"""Joystick handler -- realtime directional control."""

from __future__ import annotations

import asyncio
import logging
import time

from models.schemas import JoystickInput, MovementMode, SimulationState
from services.interpolator import RouteInterpolator
from config import SPEED_PROFILES

logger = logging.getLogger(__name__)

# How often the joystick loop ticks (seconds)
_TICK_INTERVAL = 0.2


class JoystickHandler:
    """Provides realtime joystick-style movement control.

    The user sends direction (0-360 degrees) and intensity (0-1) inputs.
    A background loop runs at ~200 ms intervals, calculating a new position
    based on the current input and speed profile, then pushing the update
    to the device.
    """

    def __init__(self, engine):
        self.engine = engine
        self.is_active: bool = False
        self.speed_profile: dict | None = None
        self._task: asyncio.Task | None = None
        self._current_input = JoystickInput(direction=0, intensity=0)

    async def start(self, mode: MovementMode) -> None:
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
        self.speed_profile = SPEED_PROFILES[profile_name]
        self.is_active = True
        self._current_input = JoystickInput(direction=0, intensity=0)

        engine.state = SimulationState.JOYSTICK
        engine._stop_event.clear()

        await engine._emit("state_change", {"state": engine.state.value})

        self._task = asyncio.create_task(self._loop())
        logger.info("Joystick started [%s]", profile_name)

    def update_input(self, joystick_input: JoystickInput) -> None:
        """Update the current joystick direction and intensity.

        Called from WebSocket messages -- must be non-blocking.
        """
        self._current_input = joystick_input

    async def _loop(self) -> None:
        """Main joystick tick loop.

        Runs every ``_TICK_INTERVAL`` seconds. Reads the current input,
        computes a new position, and pushes it to the device.
        """
        engine = self.engine

        try:
            while self.is_active and not engine._stop_event.is_set():
                # Anchor wall-clock for this tick before the push so the
                # inter-tick sleep below can subtract push + emit cost.
                # Otherwise effective tick = _TICK_INTERVAL + push_latency
                # and the iPhone-side speedometer reads ~75% of the
                # requested joystick speed (issue #22, route-based loop
                # had the same bug).
                tick_start = time.monotonic()
                inp = self._current_input

                if inp.intensity > 0 and engine.current_position is not None:
                    speed_mps = self.speed_profile["speed_mps"] * inp.intensity
                    distance = speed_mps * _TICK_INTERVAL  # meters this tick
                    jitter = self.speed_profile.get("jitter", 0.3)

                    # Calculate new position
                    new_lat, new_lng = RouteInterpolator.move_point(
                        engine.current_position.lat,
                        engine.current_position.lng,
                        inp.direction,
                        distance,
                    )

                    # Add GPS jitter
                    new_lat, new_lng = RouteInterpolator.add_jitter(
                        new_lat, new_lng, jitter * 0.3,
                    )

                    # Push to device
                    await engine._set_position(new_lat, new_lng)

                    # Accumulate distance
                    engine.distance_traveled += distance

                    await engine._emit("position_update", {
                        "lat": new_lat,
                        "lng": new_lng,
                        "speed_mps": speed_mps,
                        "bearing": inp.direction,
                    })

                # Check pause (this can sit arbitrarily long; pause time is
                # excluded from the tick budget by re-anchoring tick_start
                # after the wait so we don't burst-push to "catch up").
                if not engine._pause_event.is_set():
                    await engine._pause_event.wait()
                    tick_start = time.monotonic()

                elapsed = time.monotonic() - tick_start
                sleep_for = max(_TICK_INTERVAL - elapsed, 0.0)
                if sleep_for > 0:
                    await asyncio.sleep(sleep_for)
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
