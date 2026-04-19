"""
MultiLocationService — fan-out GPS wrapper.

Holds a primary device service plus zero or more secondary "sync" services.
Every set()/clear() call is broadcast to all registered services concurrently:
  • Primary failures propagate (trigger normal DeviceLostError cleanup).
  • Sync-device failures are logged and swallowed (non-fatal).
"""

from __future__ import annotations

import asyncio
import logging

from services.location_service import LocationService

_log = logging.getLogger("locwarp")


class MultiLocationService(LocationService):
    """Fan-out location service.

    Usage
    -----
    # On primary device connect:
    multi.set_primary(udid, dvt_service)

    # On sync device add:
    multi.add_sync(udid, dvt_service)

    # SimulationEngine uses this object transparently:
    await multi.set(lat, lng)   # → all registered services
    await multi.clear()         # → all registered services
    """

    def __init__(self) -> None:
        # Ordered: primary key first for predictable iteration
        self._services: dict[str, LocationService] = {}
        self._primary_udid: str | None = None

    # ── Registration ─────────────────────────────────────────

    def set_primary(self, udid: str, service: LocationService) -> None:
        """Replace the primary device service.  Existing sync devices are kept."""
        if self._primary_udid and self._primary_udid != udid:
            self._services.pop(self._primary_udid, None)
        self._primary_udid = udid
        self._services[udid] = service
        _log.info("MultiLocService: primary set → %s (%d total)", udid, len(self._services))

    def add_sync(self, udid: str, service: LocationService) -> None:
        """Register an additional sync device."""
        self._services[udid] = service
        _log.info("MultiLocService: sync device added → %s (%d total)", udid, len(self._services))

    def remove_sync(self, udid: str) -> None:
        """Remove a sync device (no-op for primary)."""
        if udid == self._primary_udid:
            _log.warning("MultiLocService: tried to remove primary %s via remove_sync; ignored", udid)
            return
        self._services.pop(udid, None)
        _log.info("MultiLocService: sync device removed → %s (%d total)", udid, len(self._services))

    # ── Accessors ────────────────────────────────────────────

    @property
    def primary_udid(self) -> str | None:
        return self._primary_udid

    @property
    def sync_udids(self) -> list[str]:
        return [u for u in self._services if u != self._primary_udid]

    @property
    def all_udids(self) -> list[str]:
        return list(self._services.keys())

    @property
    def count(self) -> int:
        return len(self._services)

    # ── LocationService interface ────────────────────────────

    async def set(self, lat: float, lng: float) -> None:
        if not self._services:
            return

        udids = list(self._services.keys())
        services = list(self._services.values())

        results = await asyncio.gather(
            *[svc.set(lat, lng) for svc in services],
            return_exceptions=True,
        )

        primary_exc: Exception | None = None
        for udid, result in zip(udids, results):
            if not isinstance(result, Exception):
                continue
            if udid == self._primary_udid:
                primary_exc = result
            else:
                _log.warning(
                    "MultiLocService: sync device %s set failed (non-fatal): %s",
                    udid, result,
                )

        if primary_exc is not None:
            raise primary_exc  # Let SimulationEngine / location.py handle it

    async def clear(self) -> None:
        if not self._services:
            return

        udids = list(self._services.keys())
        results = await asyncio.gather(
            *[svc.clear() for svc in self._services.values()],
            return_exceptions=True,
        )

        for udid, result in zip(udids, results):
            if isinstance(result, Exception):
                level = _log.error if udid == self._primary_udid else _log.warning
                level(
                    "MultiLocService: clear failed for %s: %s",
                    udid, result,
                )
