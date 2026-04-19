"""Auto-reconnect manager with exponential backoff."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Coroutine
from typing import Any

from config import RECONNECT_BASE_DELAY, RECONNECT_MAX_DELAY, RECONNECT_MAX_RETRIES
from models.schemas import Coordinate, SimulationState

logger = logging.getLogger(__name__)


class SimulationSnapshot:
    """Captures the simulation state at the moment of disconnection.

    This allows the system to resume from the exact position and mode
    after the device reconnects.
    """

    def __init__(
        self,
        state: SimulationState,
        position: Coordinate,
        mode_params: dict[str, Any] | None = None,
    ) -> None:
        self.state = state
        self.position = position
        self.mode_params: dict[str, Any] = mode_params or {}

    def __repr__(self) -> str:
        return (
            f"SimulationSnapshot(state={self.state!r}, "
            f"pos=({self.position.lat:.6f}, {self.position.lng:.6f}))"
        )


class ReconnectManager:
    """Handles device reconnection with exponential backoff.

    Parameters
    ----------
    device_manager:
        Any object that exposes an async ``connect(udid)`` method returning
        a truthy value on success.
    on_reconnected:
        Optional async callback invoked with the *udid* after a successful
        reconnection.
    """

    def __init__(
        self,
        device_manager: Any,
        on_reconnected: Callable[[str], Coroutine[Any, Any, None]] | None = None,
    ) -> None:
        self.device_manager = device_manager
        self.on_reconnected = on_reconnected
        self.last_snapshot: SimulationSnapshot | None = None
        self._task: asyncio.Task[None] | None = None
        self._retries: int = 0

    # ------------------------------------------------------------------
    # Snapshot
    # ------------------------------------------------------------------

    def save_snapshot(self, snapshot: SimulationSnapshot) -> None:
        """Persist the current simulation state for later resume."""
        self.last_snapshot = snapshot
        logger.info("Snapshot saved: %r", snapshot)

    # ------------------------------------------------------------------
    # Reconnection logic
    # ------------------------------------------------------------------

    async def attempt_reconnect(self, udid: str) -> bool:
        """Try to connect to the device once.

        Returns ``True`` on success, ``False`` otherwise.
        """
        try:
            result = await self.device_manager.connect(udid)
            return bool(result)
        except Exception as exc:
            logger.debug("Reconnect attempt failed for %s: %s", udid, exc)
            return False

    async def start(self, udid: str) -> None:
        """Begin the exponential-backoff reconnection loop.

        Cancels any previously running reconnection task first.
        """
        self.cancel()
        self._retries = 0
        self._task = asyncio.create_task(self._reconnect_loop(udid))

    async def _reconnect_loop(self, udid: str) -> None:
        """Internal loop: retry with exponential backoff up to max retries."""
        delay = RECONNECT_BASE_DELAY

        while self._retries < RECONNECT_MAX_RETRIES:
            self._retries += 1
            logger.info(
                "Reconnect attempt %d/%d for %s (delay %.1fs)",
                self._retries,
                RECONNECT_MAX_RETRIES,
                udid,
                delay,
            )

            try:
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                logger.debug("Reconnect loop cancelled during sleep")
                return

            success = await self.attempt_reconnect(udid)
            if success:
                logger.info("Reconnected to %s after %d attempts", udid, self._retries)
                if self.on_reconnected is not None:
                    try:
                        await self.on_reconnected(udid)
                    except Exception:
                        logger.exception("on_reconnected callback failed")
                return

            # Exponential backoff (capped)
            delay = min(delay * 2, RECONNECT_MAX_DELAY)

        logger.error(
            "Gave up reconnecting to %s after %d attempts",
            udid,
            RECONNECT_MAX_RETRIES,
        )

    def cancel(self) -> None:
        """Cancel any in-progress reconnection."""
        if self._task is not None and not self._task.done():
            self._task.cancel()
            logger.info("Reconnect task cancelled")
        self._task = None
        self._retries = 0
