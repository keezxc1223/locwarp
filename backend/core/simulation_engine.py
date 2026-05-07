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
        # Most recent route polyline (list of {lat, lng}) captured from
        # `route_path` emissions. Polled by the phone-control HTTP
        # endpoint so the phone map can draw the same path the desktop
        # WebSocket subscribers see.
        self._last_route_path: list[dict] | None = None
        # Set by apply_speed so route_loop / multi_stop know to reuse the
        # applied profile on the next lap instead of re-resolving from the
        # original request (which would revert speed every lap).
        self._speed_was_applied: bool = False
        # Extra meters to add to every emitted distance_remaining / ETA while
        # _move_along_route is running. Multi-stop sets this to the sum of
        # future legs' distances so the UI shows total-trip ETA, not just
        # current-leg ETA. Reset to 0 outside multi-stop.
        self._route_offset_remaining: float = 0.0
        # Remember the last action kind + kwargs so a newly-plugged second
        # device can auto-join and replay the same simulation on itself.
        # Set by navigate / start_loop / multi_stop / random_walk below.
        self._last_sim_kind: str | None = None
        self._last_sim_args: dict | None = None
        # Snapshot consumed by sim handlers (start_loop / multi_stop /
        # random_walk) when this engine is taking over a sim from a
        # disconnected peer. When set, the handler skips its
        # "from beginning" preamble and continues from segment_index /
        # lap_count / random_walk_count captured by the dying engine.
        self._resume_snapshot: dict | None = None
        # Random-walk progress counter exposed on the engine so a
        # disconnect-promotion can capture it and restore on the new
        # leader. The handler increments this after each completed leg.
        self._random_walk_count: int = 0
        # Holds the live-insert-waypoint splice/resume task so the
        # event loop's weak-reference task tracking doesn't garbage
        # collect it mid-execution. Cleared by the task itself when it
        # finishes (success or exception).
        self._splice_resume_task: asyncio.Task | None = None

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
        straight_line: bool = False,
        route_engine: str | None = None,
    ) -> None:
        """Navigate from current position to *dest*."""
        await self._ensure_stopped()
        self._stop_event.clear()
        self._pause_event.set()
        self._last_sim_kind = "navigate"
        self._last_sim_args = dict(
            dest=dest, mode=mode, speed_kmh=speed_kmh,
            speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
            straight_line=straight_line, route_engine=route_engine,
        )
        await self._run_handler(
            self._navigator.navigate_to(
                dest, mode, speed_kmh=speed_kmh,
                speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
                straight_line=straight_line,
                route_engine=route_engine,
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
        straight_line: bool = False,
        route_engine: str | None = None,
        lap_count: int | None = None,
        jump_mode: bool = False,
        jump_interval: float = 12.0,
    ) -> None:
        """Start looping through a closed route."""
        await self._ensure_stopped()
        self._stop_event.clear()
        self._pause_event.set()
        self._last_sim_kind = "start_loop"
        self._last_sim_args = dict(
            waypoints=waypoints, mode=mode, speed_kmh=speed_kmh,
            speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
            pause_enabled=pause_enabled, pause_min=pause_min, pause_max=pause_max,
            straight_line=straight_line, route_engine=route_engine,
            lap_count=lap_count,
            jump_mode=jump_mode, jump_interval=jump_interval,
        )
        await self._run_handler(
            self._looper.start_loop(
                waypoints, mode, speed_kmh=speed_kmh,
                speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
                pause_enabled=pause_enabled, pause_min=pause_min, pause_max=pause_max,
                straight_line=straight_line, route_engine=route_engine,
                lap_count=lap_count,
                jump_mode=jump_mode, jump_interval=jump_interval,
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
        straight_line: bool = False,
        route_engine: str | None = None,
        jump_mode: bool = False,
        jump_interval: float = 12.0,
    ) -> None:
        """Navigate through waypoints with optional stops."""
        await self._ensure_stopped()
        self._stop_event.clear()
        self._pause_event.set()
        self._last_sim_kind = "multi_stop"
        self._last_sim_args = dict(
            waypoints=waypoints, mode=mode, stop_duration=stop_duration, loop=loop,
            speed_kmh=speed_kmh, speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
            pause_enabled=pause_enabled, pause_min=pause_min, pause_max=pause_max,
            straight_line=straight_line, route_engine=route_engine,
            jump_mode=jump_mode, jump_interval=jump_interval,
        )
        await self._run_handler(
            self._multi_stop.start(
                waypoints, mode, stop_duration, loop, speed_kmh=speed_kmh,
                speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
                pause_enabled=pause_enabled, pause_min=pause_min, pause_max=pause_max,
                straight_line=straight_line, route_engine=route_engine,
                jump_mode=jump_mode, jump_interval=jump_interval,
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
        straight_line: bool = False,
        route_engine: str | None = None,
    ) -> None:
        """Begin a random walk within a radius."""
        await self._ensure_stopped()
        self._stop_event.clear()
        self._pause_event.set()
        # Auto-generate a seed so a newly-joined second device can get the
        # same random destination sequence. (The caller may override.)
        import random as _random
        effective_seed = seed if seed is not None else _random.randint(1, 2**31 - 1)
        self._last_sim_kind = "random_walk"
        self._last_sim_args = dict(
            center=center, radius_m=radius_m, mode=mode,
            speed_kmh=speed_kmh, speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
            pause_enabled=pause_enabled, pause_min=pause_min, pause_max=pause_max,
            seed=effective_seed, straight_line=straight_line, route_engine=route_engine,
        )
        seed = effective_seed
        await self._run_handler(
            self._random_walk.start(
                center, radius_m, mode,
                speed_kmh=speed_kmh,
                speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
                pause_enabled=pause_enabled, pause_min=pause_min, pause_max=pause_max,
                seed=seed,
                straight_line=straight_line, route_engine=route_engine,
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

    async def live_insert_waypoint(
        self, after_index: int, lat: float, lng: float,
    ) -> dict:
        """Splice a new waypoint into the current route at index after_index+1.

        Three behaviours depending on engine state:

        1. Currently running multi_stop / start_loop AND the splice is
           in a future leg → snapshot the engine, mutate the captured
           waypoints, restart the sim from the iPhone's current
           position. iPhone briefly pauses (~200-500ms) then walks
           through the new waypoint as part of the route.
        2. Currently running AND the splice is in a past or current leg
           → splice into the route list for display and future runs,
           but do NOT make the iPhone backtrack. User is presumed to be
           planning the route ahead, not redirecting in real time. The
           rest of the route continues from the iPhone's current pos.
        3. Not currently running → splice into _last_sim_args so the
           next manual Start picks up the new list. Equivalent to
           editing the waypoint list before running.

        Returns ``{ok, mode, splice_in_past, reason?}``. ``mode`` is
        one of ``"live"``, ``"deferred"``, or absent when ``ok=False``.
        """
        kind = self._last_sim_kind
        if kind not in ("multi_stop", "start_loop"):
            return {"ok": False, "reason": "not_route_mode"}
        args = dict(self._last_sim_args or {})
        wps = list(args.get("waypoints") or [])
        if not wps:
            return {"ok": False, "reason": "no_waypoints"}

        target = max(0, min(int(after_index) + 1, len(wps)))
        new_wp = Coordinate(lat=float(lat), lng=float(lng))
        wps.insert(target, new_wp)
        args["waypoints"] = wps

        is_running = self.state in (
            SimulationState.MULTI_STOP,
            SimulationState.LOOPING,
        )

        # Defer: just persist for the next Start.
        if not is_running:
            self._last_sim_args = args
            try:
                self._user_waypoints = list(wps)
            except Exception:
                pass
            return {"ok": True, "mode": "deferred", "splice_in_past": False}

        # IMPORTANT: do NOT read self.segment_index here. multi_stop /
        # start_loop set engine.segment_index = i ONCE per leg, then
        # _move_along_route overwrites it with the densified coord
        # index inside the per-step interpolation loop. So 99% of the
        # time it's NOT the leg index — it's a coord index that gets
        # clamped to len(wps) - 2 on resume and sends the iPhone to
        # the last leg (endpoint) or some random middle leg.
        # _user_waypoint_next IS stable: it's incremented once per
        # named user wp passed, so leg_index = _user_waypoint_next - 1.
        cur_uwn = int(self._user_waypoint_next)
        cur_seg = max(0, cur_uwn - 1)
        # "Past" splice = the inserted wp lands in or before the leg
        # we're currently walking (target ≤ cur_seg + 1). The iPhone
        # has either already finished those legs or is mid-flight on
        # the leg that would now contain the new wp; backtracking to
        # visit the new wp would surprise the user, so we just record
        # it for the route list and skip past it on resume.
        splice_in_past = target <= cur_seg + 1

        snap = self.capture_resumable_snapshot()
        if snap is None:
            # Engine state raced to IDLE between the check and snapshot
            # capture. Fall back to deferred.
            self._last_sim_args = args
            return {"ok": True, "mode": "deferred", "splice_in_past": splice_in_past}

        snap["args"] = args
        # Both multi_stop AND start_loop walk leg-by-leg through the
        # waypoint list (route_loop densifies the route via OSRM only
        # for display; movement still iterates user wps), so the same
        # segment_index math works for both.
        #
        # Resume leg = the leg whose wp_b is the SAME wp_b the iPhone
        # was already heading toward (so the in-flight current_pos →
        # wp_b movement keeps its destination). After splicing at
        # `target`, all old indices ≥ target shifted by +1. Where wp_b
        # (originally at cur_seg + 1) now lives:
        #   • target > cur_seg + 1 (future splice)  → wp_b stays at
        #     cur_seg + 1, leg_start = cur_seg.
        #   • target ≤ cur_seg + 1 (past or current) → wp_b shifted to
        #     cur_seg + 2, leg_start = cur_seg + 1. The inserted wp
        #     (now at cur_seg + 1) is recorded for the route list /
        #     polyline but the iPhone walks current_pos → wp_b
        #     directly, no backtrack.
        # Earlier code used cur_seg + 2 for the past case which jumped
        # the leg loop two ahead and made the iPhone walk straight to
        # a much later waypoint or the endpoint.
        snap["segment_index"] = cur_seg + 1 if splice_in_past else cur_seg
        snap["user_waypoint_next"] = cur_uwn + (1 if target <= cur_uwn else 0)

        # Fire-and-forget the stop + resume so the API call returns
        # quickly. The new sim starts as soon as the in-flight task
        # cancellation completes. Hold a reference on the engine so
        # asyncio's weak-ref task tracking can't garbage-collect the
        # coroutine mid-execution — without this the new sim was
        # being collected and the iPhone never moved past the splice
        # point even though the route polyline had updated.
        async def _splice_and_resume():
            try:
                await self.stop()
                await self.resume_from_snapshot(snap)
            except Exception:
                logger.exception("live_insert_waypoint splice/resume failed")
            finally:
                # Only clear the slot if we're still the registered
                # task. A reentrant live_insert (user clicks insert
                # twice in quick succession) would have replaced the
                # slot with a newer task; clearing it here would drop
                # the only reference and let asyncio GC the new task
                # mid-execution — same bug as the original missing
                # reference.
                if self._splice_resume_task is asyncio.current_task():
                    self._splice_resume_task = None

        self._splice_resume_task = asyncio.create_task(_splice_and_resume())
        return {"ok": True, "mode": "live", "splice_in_past": splice_in_past}

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
        self._last_route_path = None
        logger.info("Simulation stopped")

    def capture_resumable_snapshot(self) -> dict | None:
        """Snapshot enough state for another engine to continue this
        sim from the current position. Used by the watchdog when the
        primary device disconnects and a follower needs to be promoted
        to leader without restarting the simulation from scratch.

        Returns None when there's nothing meaningful to resume (idle,
        joystick, paused, etc).
        """
        if self.state not in (
            SimulationState.NAVIGATING,
            SimulationState.LOOPING,
            SimulationState.MULTI_STOP,
            SimulationState.RANDOM_WALK,
        ):
            return None
        if not self._last_sim_kind or not self._last_sim_args:
            return None
        cur = self.current_position
        # multi_stop / start_loop: self.segment_index gets clobbered by
        # _move_along_route's inner step loop (which writes the
        # densified-coord index, not the leg index). Use
        # _user_waypoint_next - 1 instead, which is the stable leg
        # index source. navigate / random_walk use segment_index in
        # its densified-coord meaning, so leave them on segment_index.
        if self._last_sim_kind in ("multi_stop", "start_loop"):
            seg_for_resume = max(0, int(self._user_waypoint_next) - 1)
        else:
            seg_for_resume = int(self.segment_index)
        snap = {
            "kind": self._last_sim_kind,
            "args": dict(self._last_sim_args),
            "current_pos": (cur.lat, cur.lng) if cur else None,
            "segment_index": seg_for_resume,
            "lap_count": int(self.lap_count),
            "user_waypoint_next": int(self._user_waypoint_next),
            "distance_traveled": float(self.distance_traveled),
            "speed_was_applied": bool(self._speed_was_applied),
            "random_walk_count": int(self._random_walk_count),
        }
        if self._active_speed_profile:
            snap["active_speed_profile"] = dict(self._active_speed_profile)
        return snap

    async def resume_from_snapshot(self, snap: dict) -> None:
        """Pick up a sim where another engine left off. Teleports to
        the captured position so the iPhone doesn't visibly jump on
        the new device, then re-enters the original sim handler with
        ``_resume_snapshot`` set so it skips the "from beginning"
        preamble.
        """
        pos = snap.get("current_pos")
        if pos:
            try:
                await self.teleport(pos[0], pos[1])
            except Exception:
                logger.exception("resume_from_snapshot: initial teleport failed")
                return

        # Inherit applied-speed flag so the resumed handler honors any
        # mid-flight speed change instead of reverting to the original
        # spec'd profile from the request.
        self._speed_was_applied = bool(snap.get("speed_was_applied", False))
        if "active_speed_profile" in snap:
            self._active_speed_profile = dict(snap["active_speed_profile"])

        self._resume_snapshot = snap

        kind = snap.get("kind")
        args = snap.get("args") or {}
        if not kind:
            return
        method = getattr(self, kind, None)
        if method is None:
            logger.warning("resume_from_snapshot: no method '%s' on engine", kind)
            return
        try:
            await method(**args)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("resume_from_snapshot: %s raised", kind)

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
        # Cache the most recent route polyline so HTTP-only consumers
        # (the phone control page polls /api/phone/status without a WS
        # subscription) can render the same line the desktop UI shows.
        # Cleared by stop / restore so the cached polyline doesn't outlive
        # the simulation it belongs to.
        if event_type == "route_path":
            coords = data.get("coords") if isinstance(data, dict) else None
            if isinstance(coords, list):
                self._last_route_path = [
                    {"lat": float(c["lat"]), "lng": float(c["lng"])}
                    for c in coords
                    if isinstance(c, dict) and "lat" in c and "lng" in c
                ]
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
        # Waypoint-progress detection uses deterministic seg-index math
        # (not distance thresholds). We precompute which coord index along
        # planned_coords each remaining user waypoint corresponds to, then
        # advance _user_waypoint_next whenever the current interpolation
        # point's seg_idx reaches that index. Handles off-road waypoints
        # (OSRM snaps them to the nearest road, so "nearest coord" is a
        # sharp, reliable anchor) and high-speed travel (seg_idx is a
        # monotonically-increasing integer so no point can skip over a
        # waypoint's trigger).
        user_wps = list(self._user_waypoints)
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

            # Precompute: for each remaining user waypoint, find the nearest
            # planned_coord index (monotonic forward scan). Stops as soon as
            # a waypoint can't be matched further along than the previous
            # one, meaning it belongs to a later leg (multi_stop) or isn't
            # on this planned_coords at all.
            wp_seg_idx: list[int] = []
            last_ci = -1
            for wi in range(self._user_waypoint_next, len(user_wps)):
                wp = user_wps[wi]
                start_ci = max(last_ci + 1, 0)
                best_ci = -1
                best_d = float("inf")
                for ci in range(start_ci, len(planned_coords)):
                    d = RouteInterpolator.haversine(
                        wp.lat, wp.lng,
                        planned_coords[ci].lat, planned_coords[ci].lng,
                    )
                    if d < best_d:
                        best_d = d
                        best_ci = ci
                if best_ci < 0:
                    break
                wp_seg_idx.append(best_ci)
                last_ci = best_ci
            wp_hit_ptr = 0

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

                # Anchor wall-clock for this tick BEFORE the position push so
                # the inter-tick sleep below can subtract whatever push +
                # emit cost. Without this, every tick took
                # update_interval + push_latency, so the iPhone-side
                # CoreLocation speedometer measured ~75% of the requested
                # speed over WiFi tunnel (issue #22).
                tick_start = time.monotonic()

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

                combined_remaining = self.distance_remaining + self._route_offset_remaining
                combined_eta = combined_remaining / max(speed_mps, 0.001)
                await self._emit("position_update", {
                    "lat": jittered_lat,
                    "lng": jittered_lng,
                    "bearing": bearing,
                    "speed_mps": speed_mps,
                    "progress": self.eta_tracker.progress,
                    "distance_remaining": combined_remaining,
                    "distance_traveled": self.distance_traveled,
                    "eta_seconds": combined_eta,
                })

                prev_lat, prev_lng = lat, lng

                # Waypoint hit detection (seg-index based, deterministic).
                # Advance past every waypoint whose precomputed coord index
                # is <= the interpolation point's current seg_idx. Uses a
                # while loop so two user waypoints placed very close
                # together (or a fast-moving simulation that crosses
                # multiple seg boundaries in one tick) still emit one
                # progress event per waypoint, in order.
                cur_seg = point.get("seg_idx", 0)
                while (
                    wp_hit_ptr < len(wp_seg_idx)
                    and cur_seg >= wp_seg_idx[wp_hit_ptr]
                    and self._user_waypoint_next < len(user_wps)
                ):
                    self._user_waypoint_next += 1
                    wp_hit_ptr += 1
                    await self._emit("waypoint_progress", {
                        "current_index": self._user_waypoint_next - 1,
                        "next_index": min(self._user_waypoint_next, len(user_wps) - 1),
                        "total": len(user_wps),
                    })

                # Wait for the next tick (unless this is the last point).
                # Subtract the time already spent pushing + emitting so the
                # tick rate matches update_interval, not
                # update_interval + push_latency.
                if idx < len(timed_points) - 1:
                    next_point = timed_points[idx + 1]
                    wait_time = next_point["timestamp_offset"] - point["timestamp_offset"]
                    elapsed = time.monotonic() - tick_start
                    sleep_for = max(wait_time - elapsed, 0.0)
                    if sleep_for > 0:
                        try:
                            await asyncio.wait_for(
                                self._stop_event.wait(),
                                timeout=sleep_for,
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

        # Safety net: if we exited the route normally and there are still
        # waypoints in this leg's wp_seg_idx that the tick loop didn't
        # advance past (extreme edge case, e.g. a hot-swap cutoff that
        # left tail waypoints beyond the new planned_coords boundary),
        # consume them now so the UI doesn't leave them stuck in an
        # "approaching" highlight.
        if (
            user_wps
            and not self._stop_event.is_set()
            and self._user_waypoint_next < len(user_wps)
            and wp_hit_ptr < len(wp_seg_idx)
        ):
            while (
                wp_hit_ptr < len(wp_seg_idx)
                and self._user_waypoint_next < len(user_wps)
            ):
                self._user_waypoint_next += 1
                wp_hit_ptr += 1
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
        # Resume entries (handoff between devices, live waypoint insert)
        # set _resume_snapshot BEFORE calling the handler — preserve any
        # mid-flight applied speed in that case so the iPhone keeps the
        # speed the user just set instead of falling back to the slowest
        # mode default.
        if self._resume_snapshot is None:
            self._speed_was_applied = False
            self._active_speed_profile = None
