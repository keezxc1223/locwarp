"""Simulation engine -- central orchestrator for all movement modes."""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone

from models.schemas import (
    Coordinate,
    JoystickInput,
    MovementMode,
    SimulationState,
    SimulationStatus,
)
from services.interpolator import RouteInterpolator
from services.route_service import RouteService
from config import SPEED_PROFILES, SpeedProfile

from core.teleport import TeleportHandler
from core.navigator import Navigator
from core.route_loop import RouteLooper
from core.joystick import JoystickHandler
from core.multi_stop import MultiStopNavigator
from core.random_walk import RandomWalkHandler
from core.restore import RestoreHandler

logger = logging.getLogger(__name__)


# ── ETA Tracker ──────────────────────────────────────────────────────────

class EtaTracker:
    """Tracks progress and estimates time of arrival for route-based movement."""

    def __init__(self) -> None:
        self.total_distance: float = 0.0
        self.traveled: float = 0.0
        self.speed_mps: float = 0.0
        self.start_time: float = 0.0

    def start(self, total_distance: float, speed_mps: float) -> None:
        """Initialise the tracker at the beginning of a route."""
        self.total_distance = total_distance
        self.traveled = 0.0
        self.speed_mps = max(speed_mps, 0.001)  # avoid division by zero
        self.start_time = time.monotonic()

    def update(self, traveled: float) -> None:
        """Update the distance traveled so far."""
        self.traveled = traveled

    @property
    def progress(self) -> float:
        """Return completion as a fraction 0.0 .. 1.0."""
        if self.total_distance <= 0:
            return 1.0
        return min(self.traveled / self.total_distance, 1.0)

    @property
    def eta_seconds(self) -> float:
        """Estimated seconds remaining."""
        remaining = self.distance_remaining
        if self.speed_mps <= 0:
            return 0.0
        return remaining / self.speed_mps

    @property
    def eta_arrival(self) -> str:
        """ISO-8601 estimated arrival time."""
        secs = self.eta_seconds
        if secs <= 0:
            return ""
        arrival = datetime.now(timezone.utc) + timedelta(seconds=secs)
        return arrival.isoformat(timespec="seconds")

    @property
    def distance_remaining(self) -> float:
        """Meters still to travel."""
        return max(self.total_distance - self.traveled, 0.0)


# ── Simulation Engine ───────────────────────────────────────────────────

class SimulationEngine:
    """Central controller that orchestrates all movement modes.

    Manages state transitions, task lifecycle, pause/resume, and provides
    a unified status object for the UI.

    Parameters
    ----------
    location_service
        A ``LocationService`` instance (DVT or legacy) for the target device.
    event_callback
        Optional async callable ``(event_type: str, data: dict) -> None``
        used to push realtime events over WebSocket.
    """

    def __init__(self, location_service, event_callback=None) -> None:
        self.location_service = location_service
        self.state: SimulationState = SimulationState.IDLE
        self.current_position: Coordinate | None = None
        self.event_callback = event_callback

        # Task management
        self._active_task: asyncio.Task | None = None
        self._paused_from: SimulationState | None = None
        self._pause_event = asyncio.Event()
        self._pause_event.set()  # set = running, clear = paused
        self._stop_event = asyncio.Event()

        # Sub-handlers
        self.route_service = RouteService()
        self.eta_tracker = EtaTracker()
        self._teleport_handler = TeleportHandler(self)
        self._navigator = Navigator(self)
        self._looper = RouteLooper(self)
        self._joystick = JoystickHandler(self)
        self._multi_stop = MultiStopNavigator(self)
        self._random_walk = RandomWalkHandler(self)
        self._restore_handler = RestoreHandler(self)

        # Status tracking
        self.distance_traveled: float = 0.0
        self.distance_remaining: float = 0.0
        self.lap_count: int = 0
        self.segment_index: int = 0
        self.total_segments: int = 0
        self._current_speed_mps: float = 0.0
        # Hot-swap speed support (see apply_speed + _move_along_route).
        self._active_route_coords: list[Coordinate] = []
        self._active_speed_profile: "SpeedProfile | None" = None
        self._pending_speed_profile: "SpeedProfile | None" = None
        # User-facing waypoints used for waypoint_progress emission.
        # Set by route_loop / multi_stop / navigator before each call to
        # _move_along_route, so highlight events refer to the named
        # waypoints rather than OSRM-densified polyline points.
        self._user_waypoints: list[Coordinate] = []
        self._user_waypoint_next: int = 0
        # Set by apply_speed so route_loop / multi_stop know to reuse the
        # applied profile on the next lap instead of re-resolving from the
        # original request (which would revert speed every lap).
        self._speed_was_applied: bool = False

    # ── Public API ───────────────────────────────────────────

    async def teleport(self, lat: float, lng: float) -> Coordinate:
        """Instantly move to a coordinate."""
        return await self._teleport_handler.teleport(lat, lng)

    async def _run_handler(self, coro, label: str) -> None:
        """Run a simulation handler coroutine with uniform cleanup.
        Any exception or cancellation forces the engine back to IDLE and
        notifies the frontend, preventing UI desync after a crash / drop."""
        self._active_task = asyncio.create_task(coro)
        try:
            await self._active_task
        except asyncio.CancelledError:
            logger.info("%s cancelled", label)
        except Exception:
            logger.exception("%s failed unexpectedly", label)
        finally:
            self._active_task = None
            # Force state back to IDLE if a handler crashed / was cancelled
            # mid-flight so the UI doesn't stay stuck showing "navigating".
            if self.state not in (SimulationState.IDLE, SimulationState.DISCONNECTED):
                self.state = SimulationState.IDLE
                try:
                    await self._emit("state_change", {"state": self.state.value})
                except Exception:
                    logger.exception("Failed to emit idle state_change after %s", label)

    async def navigate(
        self, dest: Coordinate, mode: MovementMode,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
    ) -> None:
        """Navigate from current position to *dest*."""
        await self._ensure_stopped()
        self._stop_event.clear()
        self._pause_event.set()
        await self._run_handler(
            self._navigator.navigate_to(
                dest, mode, speed_kmh=speed_kmh,
                speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
            ),
            "Navigate",
        )

    async def start_loop(
        self,
        waypoints: list[Coordinate],
        mode: MovementMode,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
        pause_enabled: bool = True,
        pause_min: float = 5.0,
        pause_max: float = 20.0,
    ) -> None:
        """Start looping through a closed route."""
        await self._ensure_stopped()
        self._stop_event.clear()
        self._pause_event.set()
        await self._run_handler(
            self._looper.start_loop(
                waypoints, mode, speed_kmh=speed_kmh,
                speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
                pause_enabled=pause_enabled, pause_min=pause_min, pause_max=pause_max,
            ),
            "Loop",
        )

    async def joystick_start(self, mode: MovementMode) -> None:
        """Activate joystick mode."""
        await self._joystick.start(mode)

    def joystick_move(self, joystick_input: JoystickInput) -> None:
        """Update the joystick direction/intensity (non-blocking)."""
        self._joystick.update_input(joystick_input)

    async def joystick_stop(self) -> None:
        """Deactivate joystick mode."""
        await self._joystick.stop()
        if self.state == SimulationState.JOYSTICK:
            self.state = SimulationState.IDLE
            await self._emit("state_change", {"state": self.state.value})

    async def multi_stop(
        self,
        waypoints: list[Coordinate],
        mode: MovementMode,
        stop_duration: float = 0,
        loop: bool = False,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
        pause_enabled: bool = True,
        pause_min: float = 5.0,
        pause_max: float = 20.0,
    ) -> None:
        """Navigate through waypoints with optional stops."""
        await self._ensure_stopped()
        self._stop_event.clear()
        self._pause_event.set()
        await self._run_handler(
            self._multi_stop.start(
                waypoints, mode, stop_duration, loop, speed_kmh=speed_kmh,
                speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
                pause_enabled=pause_enabled, pause_min=pause_min, pause_max=pause_max,
            ),
            "Multi-stop",
        )

    async def random_walk(
        self,
        center: Coordinate,
        radius_m: float,
        mode: MovementMode,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
        pause_enabled: bool = True,
        pause_min: float = 5.0,
        pause_max: float = 20.0,
        seed: int | None = None,
    ) -> None:
        """Begin a random walk within a radius."""
        await self._ensure_stopped()
        self._stop_event.clear()
        self._pause_event.set()
        await self._run_handler(
            self._random_walk.start(
                center, radius_m, mode,
                speed_kmh=speed_kmh,
                speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
                pause_enabled=pause_enabled, pause_min=pause_min, pause_max=pause_max,
                seed=seed,
            ),
            "Random walk",
        )

    async def pause(self) -> None:
        """Pause the active movement.

        Clears the pause event so the movement loop blocks until resumed.
        """
        if self.state == SimulationState.PAUSED:
            return
        if self.state == SimulationState.IDLE:
            return

        self._paused_from = self.state
        self.state = SimulationState.PAUSED
        self._pause_event.clear()

        await self._emit("state_change", {
            "state": self.state.value,
            "paused_from": self._paused_from.value if self._paused_from else None,
        })
        logger.info("Simulation paused (was %s)", self._paused_from)

    async def resume(self) -> None:
        """Resume a paused movement."""
        if self.state != SimulationState.PAUSED:
            return

        prev = self._paused_from or SimulationState.IDLE
        self.state = prev
        self._paused_from = None
        self._pause_event.set()

        await self._emit("state_change", {"state": self.state.value})
        logger.info("Simulation resumed to %s", self.state.value)

    async def restore(self) -> None:
        """Stop everything and clear the simulated location."""
        await self._restore_handler.restore()

    async def stop(self) -> None:
        """Stop the current movement gracefully.

        Sets the stop event so the movement loop exits, then waits for
        the active task to finish.
        """
        self._stop_event.set()
        self._pause_event.set()  # unblock if paused

        # Stop joystick if active
        if self._joystick.is_active:
            await self._joystick.stop()

        # Cancel and await the active task
        if self._active_task is not None and not self._active_task.done():
            self._active_task.cancel()
            try:
                await self._active_task
            except asyncio.CancelledError:
                pass
            self._active_task = None

        if self.state not in (SimulationState.IDLE, SimulationState.DISCONNECTED):
            self.state = SimulationState.IDLE
            await self._emit("state_change", {"state": self.state.value})

        self._paused_from = None
        logger.info("Simulation stopped")

    def get_status(self) -> SimulationStatus:
        """Build a snapshot of the current simulation status."""
        return SimulationStatus(
            state=self.state,
            current_position=self.current_position,
            progress=self.eta_tracker.progress,
            speed_mps=self._current_speed_mps,
            eta_seconds=self.eta_tracker.eta_seconds,
            eta_arrival=self.eta_tracker.eta_arrival,
            distance_remaining=self.eta_tracker.distance_remaining,
            distance_traveled=self.distance_traveled,
            lap_count=self.lap_count,
            segment_index=self.segment_index,
            total_segments=self.total_segments,
            is_paused=self.state == SimulationState.PAUSED,
        )

    # ── Internal helpers ─────────────────────────────────────

    async def _emit(self, event_type: str, data: dict) -> None:
        """Send an event to the WebSocket callback, if one is registered."""
        if self.event_callback is not None:
            try:
                await self.event_callback(event_type, data)
            except Exception:
                logger.exception("Event callback error for '%s'", event_type)

    async def _set_position(self, lat: float, lng: float) -> None:
        """Push a coordinate to the device and update internal state."""
        await self.location_service.set(lat, lng)
        self.current_position = Coordinate(lat=lat, lng=lng)

    def apply_speed(
        self,
        speed_profile: "SpeedProfile",
    ) -> bool:
        """Hot-swap the active speed profile. Works in two modes:

        * Route-based handlers (navigate / loop / multi-stop / random-walk):
          queue the profile; the running ``_move_along_route`` loop notices
          and re-interpolates the remaining coords from the current position.
        * Joystick mode: swap the joystick handler's own speed_profile so
          the next tick computes distance with the new value.

        Returns True if the change was queued/applied, False if nothing is
        running to apply it to.
        """
        if self.state in (SimulationState.IDLE, SimulationState.DISCONNECTED):
            return False
        # Joystick uses its own independent speed profile attribute.
        if self.state == SimulationState.JOYSTICK and self._joystick.is_active:
            self._joystick.speed_profile = dict(speed_profile)
            self._speed_was_applied = True
            return True
        if not self._active_route_coords:
            return False
        self._pending_speed_profile = dict(speed_profile)
        self._speed_was_applied = True
        return True

    async def _move_along_route(
        self,
        coords: list[Coordinate],
        speed_profile: "SpeedProfile",
    ) -> None:
        """Core movement loop shared by navigate, loop, multi-stop, and
        random walk modes.

        1. Interpolates the route into evenly-timed points.
        2. Iterates through each point, updating the device position.
        3. Respects pause/stop events between each step.
        4. Tracks distance, ETA, and emits position updates.

        Parameters
        ----------
        coords
            Ordered list of route coordinates.
        speed_profile
            Dict with keys ``speed_mps``, ``jitter``, ``update_interval``.
        """
        # Expose these as instance state so apply_speed can read/swap them
        # mid-flight without racing the handler's local variables.
        self._active_route_coords = list(coords)
        self._active_speed_profile = dict(speed_profile)
        self._pending_speed_profile = None
        self.total_segments = max(len(coords) - 1, 0)

        # Outer loop: each iteration plans a fresh interpolation of the
        # remaining route. Re-entered on apply_speed to absorb a new speed.
        planned_coords = self._active_route_coords

        # Waypoint-progress detection runs against the user's named
        # waypoints (set by the calling handler), not the OSRM-densified
        # polyline points. The next-target index lives on the engine so
        # multi-leg handlers (multi_stop, loop) can persist progress
        # across consecutive _move_along_route calls.
        #
        # OSRM snaps off-road taps to the nearest road, so the routed path
        # rarely passes within a strict radius of the user's literal click.
        # We therefore track the minimum distance seen toward the next
        # target and consider it "passed" when either we got *close enough*
        # OR we got reasonably close and have started moving away.
        user_wps = list(self._user_waypoints)
        WP_HARD_HIT_M = 15.0      # straight-up "we're at it"
        WP_NEAR_M = 60.0          # got close enough to count as visiting
        WP_RECEDE_M = 12.0        # how far past min before declaring passed
        wp_min_dist = float("inf")
        if user_wps:
            await self._emit("waypoint_progress", {
                "current_index": max(self._user_waypoint_next - 1, 0),
                "next_index": min(self._user_waypoint_next, len(user_wps) - 1),
                "total": len(user_wps),
            })

        while True:
            speed_mps = self._active_speed_profile["speed_mps"]
            jitter = self._active_speed_profile.get("jitter", 0.3)
            update_interval = self._active_speed_profile.get("update_interval", 1.0)

            self._current_speed_mps = speed_mps

            # Total distance of the planned coord list
            total_distance = 0.0
            for i in range(len(planned_coords) - 1):
                total_distance += RouteInterpolator.haversine(
                    planned_coords[i].lat, planned_coords[i].lng,
                    planned_coords[i + 1].lat, planned_coords[i + 1].lng,
                )

            self.eta_tracker.start(total_distance, speed_mps)
            self.distance_remaining = total_distance

            timed_points = RouteInterpolator.interpolate(
                planned_coords, speed_mps, update_interval,
            )

            if not timed_points:
                return

            accumulated_distance = 0.0
            prev_lat = timed_points[0]["lat"]
            prev_lng = timed_points[0]["lng"]

            reinterpolate_from_point: int | None = None

            for idx, point in enumerate(timed_points):
                # ── Check stop ──
                if self._stop_event.is_set():
                    logger.debug("Stop event detected at point %d/%d", idx, len(timed_points))
                    break

                # ── Check pause ──
                if not self._pause_event.is_set():
                    logger.debug("Paused at point %d/%d", idx, len(timed_points))
                    await self._pause_event.wait()
                    if self._stop_event.is_set():
                        break

                # ── Check hot-swap speed ──
                if self._pending_speed_profile is not None:
                    reinterpolate_from_point = idx
                    break

                lat = point["lat"]
                lng = point["lng"]
                bearing = point.get("bearing", 0.0)

                # Calculate distance from previous point
                step_dist = RouteInterpolator.haversine(prev_lat, prev_lng, lat, lng)
                accumulated_distance += step_dist

                # Add GPS jitter for realism
                jittered_lat, jittered_lng = RouteInterpolator.add_jitter(lat, lng, jitter)

                pushed = False
                for attempt in range(3):
                    try:
                        await self._set_position(jittered_lat, jittered_lng)
                        pushed = True
                        break
                    except (ConnectionError, OSError) as exc:
                        logger.warning(
                            "position push failed (attempt %d/3): %s", attempt + 1, exc,
                        )
                        await asyncio.sleep(0.5 * (attempt + 1))
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        logger.exception("Unexpected error pushing position")
                        break
                if not pushed:
                    logger.error("Giving up on this route after repeated push failures")
                    break

                # Update tracking
                self.distance_traveled += step_dist
                self.distance_remaining = max(total_distance - accumulated_distance, 0.0)
                self.eta_tracker.update(accumulated_distance)
                self.segment_index = min(idx, self.total_segments)

                await self._emit("position_update", {
                    "lat": jittered_lat,
                    "lng": jittered_lng,
                    "bearing": bearing,
                    "speed_mps": speed_mps,
                    "progress": self.eta_tracker.progress,
                    "distance_remaining": self.distance_remaining,
                    "distance_traveled": self.distance_traveled,
                    "eta_seconds": self.eta_tracker.eta_seconds,
                })

                prev_lat, prev_lng = lat, lng

                # Waypoint hit detection (see WP_* constants above).
                if user_wps and self._user_waypoint_next < len(user_wps):
                    target = user_wps[self._user_waypoint_next]
                    d = RouteInterpolator.haversine(jittered_lat, jittered_lng, target.lat, target.lng)
                    if d < wp_min_dist:
                        wp_min_dist = d
                    hit_close = d <= WP_HARD_HIT_M
                    hit_passed = (
                        wp_min_dist <= WP_NEAR_M
                        and d > wp_min_dist + WP_RECEDE_M
                    )
                    if hit_close or hit_passed:
                        self._user_waypoint_next += 1
                        wp_min_dist = float("inf")
                        await self._emit("waypoint_progress", {
                            "current_index": self._user_waypoint_next - 1,
                            "next_index": min(self._user_waypoint_next, len(user_wps) - 1),
                            "total": len(user_wps),
                        })

                # Wait for the next tick (unless this is the last point)
                if idx < len(timed_points) - 1:
                    next_point = timed_points[idx + 1]
                    wait_time = next_point["timestamp_offset"] - point["timestamp_offset"]
                    if wait_time > 0:
                        try:
                            await asyncio.wait_for(
                                self._stop_event.wait(),
                                timeout=wait_time,
                            )
                            break
                        except asyncio.TimeoutError:
                            pass

            # Did we break out to re-interpolate with a new speed?
            if reinterpolate_from_point is not None and self._pending_speed_profile is not None:
                # New plan: current position + the remaining original waypoints
                # starting *after* the segment we were just traversing.
                cutoff_seg = timed_points[reinterpolate_from_point].get("seg_idx", 0)
                tail_waypoints = self._active_route_coords[cutoff_seg + 1:]
                cur_pos = self.current_position
                if cur_pos is not None and tail_waypoints:
                    planned_coords = [Coordinate(lat=cur_pos.lat, lng=cur_pos.lng)] + list(tail_waypoints)
                else:
                    # Nothing ahead — just let the loop exit naturally.
                    planned_coords = []

                self._active_speed_profile = self._pending_speed_profile
                self._pending_speed_profile = None
                # Critical: also sync _active_route_coords to the new plan so
                # a *subsequent* apply_speed slices against the right list.
                # Otherwise the next cutoff_seg (relative to the now-shorter
                # planned_coords) would index back into the original full leg
                # and the device would jump back toward the leg's start.
                self._active_route_coords = list(planned_coords)
                logger.info(
                    "Hot-swapped speed to %.2f m/s; replanning %d remaining waypoints (cur=%s, cutoff_seg=%d)",
                    self._active_speed_profile["speed_mps"],
                    len(planned_coords),
                    f"{cur_pos.lat:.6f},{cur_pos.lng:.6f}" if cur_pos else "None",
                    cutoff_seg,
                )
                if planned_coords:
                    continue  # outer while — build a fresh plan
            break  # outer while: done (stopped, completed, or push-failure)

        # If we exited the route normally without stopping but didn't quite
        # touch the final user waypoint (OSRM routing can end metres away
        # from a user-clicked point that's off-road), force-advance once so
        # the UI marks the leg's destination as reached instead of leaving
        # it stuck in "approaching" forever.
        if (
            user_wps
            and not self._stop_event.is_set()
            and self._user_waypoint_next < len(user_wps)
        ):
            self._user_waypoint_next += 1
            await self._emit("waypoint_progress", {
                "current_index": self._user_waypoint_next - 1,
                "next_index": min(self._user_waypoint_next, len(user_wps) - 1),
                "total": len(user_wps),
            })

        self._pending_speed_profile = None
        self._active_route_coords = []
        self._current_speed_mps = 0.0

    async def _ensure_stopped(self) -> None:
        """Make sure no movement is active before starting a new one."""
        if self.state not in (SimulationState.IDLE, SimulationState.DISCONNECTED):
            await self.stop()
        self._stop_event.clear()
        # Fresh session — let the next handler resolve speed from its own
        # request, not from a stale apply_speed from a previous session.
        self._speed_was_applied = False
        self._active_speed_profile = None
