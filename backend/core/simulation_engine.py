"""Simulation engine -- central orchestrator for all movement modes."""

from __future__ import annotations

import asyncio
import logging
import random
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

    async def joystick_start(
        self,
        mode: MovementMode,
        *,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
    ) -> None:
        """Activate joystick mode."""
        await self._joystick.start(
            mode,
            speed_kmh=speed_kmh,
            speed_min_kmh=speed_min_kmh,
            speed_max_kmh=speed_max_kmh,
        )

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
        speed_mps = speed_profile["speed_mps"]
        jitter = speed_profile.get("jitter", 0.3)
        update_interval = speed_profile.get("update_interval", 1.0)

        self._current_speed_mps = speed_mps

        # Calculate total route distance
        total_distance = 0.0
        for i in range(len(coords) - 1):
            total_distance += RouteInterpolator.haversine(
                coords[i].lat, coords[i].lng,
                coords[i + 1].lat, coords[i + 1].lng,
            )

        self.eta_tracker.start(total_distance, speed_mps)
        self.distance_remaining = total_distance

        # 先用 RDP 去除 OSRM 多餘的密集點，再做時間插值
        simplified_coords = RouteInterpolator.rdp_simplify(coords, epsilon_m=2.0)

        # Interpolate the route into dense timed points
        timed_points = RouteInterpolator.interpolate(
            simplified_coords, speed_mps, update_interval,
        )

        if not timed_points:
            return

        total_duration = timed_points[-1]["timestamp_offset"]
        prev_lat = timed_points[0]["lat"]
        prev_lng = timed_points[0]["lng"]
        accumulated_distance = 0.0  # 實際累計距離（用於 ETA 和進度追蹤）
        smooth_bearing = timed_points[0].get("bearing", 0.0)  # 平滑方位角

        # ── 速度平滑 ──────────────────────────────────────────────────────────
        # 在路線開頭和結尾各加 RAMP_STEPS 個 tick 的速度漸變，
        # 讓 status bar 的速度顯示從 0 平滑地加速到目標速度再緩速停下。
        # 短路線（總 tick < 2×RAMP_STEPS）直接顯示全速，避免速度永遠達不到設定值。
        _RAMP_STEPS = 4          # 漸變步數（約 4 秒 @ 1s interval）
        _ramp_step  = 0          # 當前 tick 計數
        _total_ticks_est = max(1, int(total_duration / max(update_interval, 0.1)))
        _use_ramp = _total_ticks_est > _RAMP_STEPS * 2  # 短路線不做 ramp

        # ── 時間驅動迴圈 ──────────────────────────────────────────────
        # 每次 tick 以「牆鐘經過時間」查詢路線上的正確位置，
        # 而不是逐點迭代。好處：
        #   1. tick 慢了 → 直接跳到應有位置，不 burst 連射
        #   2. 不受 carry 計算影響，位移永遠固定為 speed × interval
        #   3. 暫停後繼續，時間自動補償
        #
        # timing_randomness: ±50ms 自然抖動（約 5% of 1.0s interval）
        # 舊版 ±200ms 相當於 ±67% of 0.3s，造成速度感知混亂。
        _TIMING_RANDOMNESS_MS = 50
        loop = asyncio.get_running_loop()
        route_start_time = loop.time()
        pause_offset = 0.0

        while True:
            tick_start = loop.time()

            # ── Check stop ──
            if self._stop_event.is_set():
                break

            # ── Check pause ──
            if not self._pause_event.is_set():
                pause_begin = loop.time()
                await self._pause_event.wait()
                pause_offset += loop.time() - pause_begin
                if self._stop_event.is_set():
                    break
                tick_start = loop.time()

            # 計算本次 tick 對應的路線時間位移
            elapsed = tick_start - route_start_time - pause_offset

            # 路線結束
            if elapsed >= total_duration:
                lat, lng, bearing = RouteInterpolator.get_position_at_time(timed_points, total_duration)
                jittered_lat, jittered_lng = RouteInterpolator.add_jitter(lat, lng, jitter)
                try:
                    await self._set_position(jittered_lat, jittered_lng)
                except Exception:
                    pass
                break

            # 查詢此時刻的精確位置（二分搜尋 + 線性插值）
            lat, lng, bearing = RouteInterpolator.get_position_at_time(timed_points, elapsed)

            # 計算本步實際位移和方位角
            step_dist = RouteInterpolator.haversine(prev_lat, prev_lng, lat, lng)
            accumulated_distance += step_dist

            # 從實際移動方向計算方位角（低通濾波平滑，避免抖動）
            if step_dist > 0.5:  # 只在有明顯移動時更新方位角
                raw_bearing = RouteInterpolator.bearing(prev_lat, prev_lng, lat, lng)
                # 低通濾波：alpha=0.3 → 新值佔 30%，舊值佔 70%，轉角不突變
                diff = ((raw_bearing - smooth_bearing + 180) % 360) - 180
                smooth_bearing = (smooth_bearing + 0.3 * diff) % 360

            # ── 速度平滑：根據路線進度漸變顯示速度 ────────────────────────────
            _ramp_step += 1
            if not _use_ramp:
                # 短路線或高速場景：直接顯示設定速度，避免永遠達不到設定值
                self._current_speed_mps = speed_mps
            elif _ramp_step <= _RAMP_STEPS:
                _ramp = _ramp_step / _RAMP_STEPS           # ease-in  0→1
                self._current_speed_mps = speed_mps * max(0.05, _ramp)
            elif _total_ticks_est - _ramp_step <= _RAMP_STEPS:
                _ramp = max(0.0, (_total_ticks_est - _ramp_step) / _RAMP_STEPS)  # ease-out 1→0
                self._current_speed_mps = speed_mps * max(0.05, _ramp)
            else:
                self._current_speed_mps = speed_mps

            # Add GPS jitter for realism
            jittered_lat, jittered_lng = RouteInterpolator.add_jitter(lat, lng, jitter)

            # Push position to device, with limited retry on transient errors
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
                await self._emit("simulation_error", {
                    "message": "GPS 定位推送失敗，路線已中止",
                    "code": "push_failure",
                })
                break

            # 更新距離追蹤（使用實際累計距離，而非速度估算）
            self.distance_traveled += step_dist
            self.distance_remaining = max(total_distance - accumulated_distance, 0.0)
            self.eta_tracker.update(accumulated_distance)

            # Emit position update
            # speed_mps 發實際設定值（供前端顯示時速），不發 ramp 後的平滑值
            await self._emit("position_update", {
                "lat": jittered_lat,
                "lng": jittered_lng,
                "bearing": smooth_bearing,
                "speed_mps": speed_mps,
                "speed_kmh": round(speed_mps * 3.6, 1),
                "progress": self.eta_tracker.progress,
                "distance_remaining": self.distance_remaining,
                "distance_traveled": self.distance_traveled,
                "eta_seconds": self.eta_tracker.eta_seconds,
            })

            prev_lat, prev_lng = lat, lng

            # 精確等待下一個 update_interval + ±50ms 自然抖動（~5% of 1.0s interval）
            # 不做 burst 追趕：下一 tick 直接查詢正確時間位置即可
            elapsed_this_tick = loop.time() - tick_start
            randomness = random.uniform(-_TIMING_RANDOMNESS_MS, _TIMING_RANDOMNESS_MS) / 1000.0
            sleep_time = max(0.05, update_interval - elapsed_this_tick + randomness)
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=sleep_time,
                )
                break  # stop event fired
            except asyncio.TimeoutError:
                pass  # 正常，繼續下一個 tick

        self._current_speed_mps = 0.0

    async def _ensure_stopped(self) -> None:
        """Make sure no movement is active before starting a new one."""
        if self.state not in (SimulationState.IDLE, SimulationState.DISCONNECTED):
            await self.stop()
        self._stop_event.clear()
