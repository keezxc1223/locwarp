"""Pokemon GO-style cooldown timer."""

from __future__ import annotations

import asyncio
import logging
import time

from config import COOLDOWN_TABLE
from services.interpolator import RouteInterpolator

logger = logging.getLogger(__name__)


class CooldownTimer:
    """Manages a countdown based on teleport distance.

    The cooldown duration is looked up from :data:`COOLDOWN_TABLE` using the
    great-circle distance between the old and new positions.
    """

    def __init__(self) -> None:
        self.enabled: bool = False
        self.is_active: bool = False
        self.remaining: float = 0.0
        self.total: float = 0.0
        self.distance_km: float = 0.0
        self._task: asyncio.Task[None] | None = None
        self._start_time: float = 0.0

    # ------------------------------------------------------------------
    # Cooldown lookup
    # ------------------------------------------------------------------

    def calculate_cooldown(self, distance_km: float) -> int:
        """Return cooldown seconds for *distance_km* from the cooldown table."""
        for max_km, seconds in COOLDOWN_TABLE:
            if distance_km <= max_km:
                return seconds
        # Fallback: last entry
        return COOLDOWN_TABLE[-1][1]

    # ------------------------------------------------------------------
    # Start / dismiss
    # ------------------------------------------------------------------

    async def start(
        self,
        from_lat: float,
        from_lng: float,
        to_lat: float,
        to_lng: float,
    ) -> None:
        """Calculate distance between points, then start the countdown."""
        if not self.enabled:
            logger.debug("Cooldown disabled -- skipping")
            return

        # Cancel any running timer first
        await self.dismiss()

        dist_m = RouteInterpolator.haversine(from_lat, from_lng, to_lat, to_lng)
        self.distance_km = dist_m / 1000.0
        cooldown_sec = self.calculate_cooldown(self.distance_km)

        if cooldown_sec <= 0:
            logger.debug("Distance %.2f km -> no cooldown needed", self.distance_km)
            return

        self.total = float(cooldown_sec)
        self.remaining = float(cooldown_sec)
        self.is_active = True
        self._start_time = time.monotonic()

        logger.info(
            "Cooldown started: %.2f km -> %d s",
            self.distance_km,
            cooldown_sec,
        )

        self._task = asyncio.create_task(self._countdown())

    async def _countdown(self) -> None:
        """Internal coroutine that ticks once per second until done."""
        try:
            while self.remaining > 0:
                await asyncio.sleep(1.0)
                elapsed = time.monotonic() - self._start_time
                self.remaining = max(0.0, self.total - elapsed)

            logger.info("Cooldown finished")
        except asyncio.CancelledError:
            logger.debug("Cooldown cancelled")
        finally:
            self.is_active = False
            self.remaining = 0.0

    async def dismiss(self) -> None:
        """Cancel an active cooldown immediately."""
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

        self.is_active = False
        self.remaining = 0.0

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def get_status(self) -> dict:
        """Return a JSON-serialisable status snapshot."""
        # Refresh remaining from wall clock while active
        if self.is_active:
            elapsed = time.monotonic() - self._start_time
            self.remaining = max(0.0, self.total - elapsed)

        return {
            "enabled": self.enabled,
            "is_active": self.is_active,
            "remaining_seconds": round(self.remaining, 1),
            "total_seconds": self.total,
            "distance_km": round(self.distance_km, 2),
        }
