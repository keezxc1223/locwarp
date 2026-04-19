"""Joystick handler -- realtime directional control."""

from __future__ import annotations

import asyncio
import logging

from config import resolve_speed_profile
from models.schemas import JoystickInput, MovementMode, SimulationState
from services.interpolator import RouteInterpolator

logger = logging.getLogger(__name__)

# 搖桿 tick 間隔：與 iOS GPS 1Hz 對齊，避免 DVT rate-limiting
# 搖桿需要即時響應，使用 0.1s（10Hz）讓操作更靈敏，
# 但距離計算用真實 dt 確保物理正確，不受 tick 頻率影響。
_TICK_INTERVAL = 0.1   # 100ms：即時感更強，距離由真實 dt 計算


class JoystickHandler:
    """Provides realtime joystick-style movement control.

    The user sends direction (0-360 degrees) and intensity (0-1) inputs.
    A background loop reads input at _TICK_INTERVAL, calculates position
    using the actual elapsed time (effective_dt) for physically correct
    distance, then pushes the update to the device.
    """

    def __init__(self, engine):
        self.engine = engine
        self.is_active: bool = False
        self.speed_profile: dict | None = None
        self._task: asyncio.Task | None = None
        self._current_input = JoystickInput(direction=0, intensity=0)

    async def start(
        self,
        mode: MovementMode,
        *,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
    ) -> None:
        """Activate joystick mode with the given movement speed profile."""
        engine = self.engine

        if engine.current_position is None:
            raise RuntimeError(
                "Cannot start joystick: no current position. Teleport first."
            )

        # Stop any running simulation first
        if engine.state not in (SimulationState.IDLE, SimulationState.DISCONNECTED):
            await engine.stop()

        profile_name = mode.value
        # 使用 resolve_speed_profile 以支援自訂速度（含速度範圍）
        self.speed_profile = resolve_speed_profile(
            profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
        )
        logger.info(
            "Joystick speed: %.1f km/h (profile=%s, custom=%s)",
            self.speed_profile["speed_mps"] * 3.6,
            profile_name,
            speed_kmh,
        )
        self.is_active = True
        self._current_input = JoystickInput(direction=0, intensity=0)

        # 重置累計距離，與其他模式（navigate/loop/multi_stop/random_walk）一致。
        # 否則 status bar 會顯示上一輪 navigate 累積的距離，造成 UI 不一致。
        engine.distance_traveled = 0.0
        engine.state = SimulationState.JOYSTICK
        engine._stop_event.clear()

        await engine._emit("state_change", {"state": engine.state.value})

        self._task = asyncio.create_task(self._loop())
        logger.info("Joystick started [%s]", profile_name)

    def update_input(self, joystick_input: JoystickInput) -> None:
        """Update the current joystick direction and intensity (non-blocking)."""
        self._current_input = joystick_input

    async def _loop(self) -> None:
        """Main joystick tick loop.

        Distance per tick = speed_mps × effective_dt，使用「牆鐘真實間隔」
        而非固定常數，確保物理正確（不因 I/O 延遲而多走距離）。
        """
        engine = self.engine
        loop = asyncio.get_running_loop()
        smooth_bearing = 0.0        # 低通濾波後的方位角
        last_tick_time: float | None = None

        try:
            while self.is_active and not engine._stop_event.is_set():
                tick_start = loop.time()

                # effective_dt：本次 tick 真實間隔（含 sleep + I/O 延遲）
                # 首次用 _TICK_INTERVAL 估算；限制上限避免暫停後的超大跳躍
                if last_tick_time is None:
                    effective_dt = _TICK_INTERVAL
                else:
                    effective_dt = min(tick_start - last_tick_time, _TICK_INTERVAL * 3.0)
                last_tick_time = tick_start

                inp = self._current_input

                if inp.intensity > 0 and engine.current_position is not None:
                    speed_mps = self.speed_profile["speed_mps"] * inp.intensity
                    jitter    = self.speed_profile.get("jitter", 0.3)

                    # 方位角低通濾波：alpha=0.6 → 即時感強但不突跳
                    diff = ((inp.direction - smooth_bearing + 180) % 360) - 180
                    smooth_bearing = (smooth_bearing + 0.6 * diff) % 360

                    # 距離 = 速度 × 真實時間間隔（物理正確）
                    distance = speed_mps * effective_dt

                    new_lat, new_lng = RouteInterpolator.move_point(
                        engine.current_position.lat,
                        engine.current_position.lng,
                        inp.direction,
                        distance,
                    )

                    # 搖桿 jitter 比路線導航小（0.15x），避免手動操控時位置抖動
                    new_lat, new_lng = RouteInterpolator.add_jitter(
                        new_lat, new_lng, jitter * 0.15,
                    )

                    await engine._set_position(new_lat, new_lng)
                    engine.distance_traveled += distance

                    await engine._emit("position_update", {
                        "lat": new_lat,
                        "lng": new_lng,
                        "speed_mps": speed_mps,
                        "speed_kmh": round(speed_mps * 3.6, 1),
                        "bearing": smooth_bearing,
                    })

                # 暫停處理
                if not engine._pause_event.is_set():
                    last_tick_time = None  # 暫停後重置 dt，避免繼續時跳躍
                    await engine._pause_event.wait()

                # 精確等待剩餘時間，維持穩定 tick 頻率
                elapsed = loop.time() - tick_start
                sleep_time = max(0.0, _TICK_INTERVAL - elapsed)
                await asyncio.sleep(sleep_time)

        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Joystick loop error")
        finally:
            self.is_active = False

    async def stop(self) -> None:
        """Deactivate joystick mode."""
        self.is_active = False

        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

        self._current_input = JoystickInput(direction=0, intensity=0)
        logger.info("Joystick stopped")
