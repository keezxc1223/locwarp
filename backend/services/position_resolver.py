"""Initial-position resolution with IP-geolocation fallback.

Priority order (async variant):
  1. Manually pinned ``home_position`` (user-set via the UI)
  2. ``last_position`` persisted in settings.json
  3. IP geolocation via ip-api.com (free, no key, city-level)
  4. ``DEFAULT_LOCATION`` — hardcoded fallback (Taipei City Hall)

Extracted from ``AppState`` because this is a purely functional concern
with no dependency on device state — and because the sync/async split
(``get_initial_position`` vs ``get_initial_position_async``) was easy to
trip over when it lived alongside 13 other attributes.

The resolver holds the two position slots (home, last) as plain data
and a single persistence hook so ``AppState`` can wire save-on-change
without this module knowing about settings.json layout.
"""
from __future__ import annotations

import logging
from collections.abc import Callable

import httpx

from config import DEFAULT_LOCATION

logger = logging.getLogger("locwarp.position")

# Tight-ish to keep startup snappy; ip-api's 95th percentile is well under
# this. A timeout here means "give up and use DEFAULT_LOCATION", which is
# a perfectly graceful degradation.
_IP_GEO_TIMEOUT_SECONDS = 5.0


class PositionResolver:
    """Holds the two user-addressable position slots and resolves an
    initial position by checking them (plus IP geolocation) in order.

    ``on_change`` is called after any setter mutates the state — the
    caller (AppState) uses it to persist to settings.json. Passing None
    disables persistence (handy in tests).
    """

    def __init__(self, on_change: Callable[[], None] | None = None):
        self._home: dict | None = None
        self._last: dict | None = None
        self._on_change = on_change
        # Save throttling — every 10 updates, matches the pre-refactor
        # behavior so we don't suddenly write 10x more often.
        self._update_count = 0

    # ── Getters / setters for the two slots ────────────────────────────

    @property
    def home(self) -> dict | None:
        return self._home

    @home.setter
    def home(self, pos: dict | None) -> None:
        self._home = pos
        if self._on_change:
            self._on_change()

    @property
    def last(self) -> dict | None:
        return self._last

    def update_last(self, lat: float, lng: float) -> None:
        """Fast-path update used on every position_update WS frame.

        Persists every 10th call — writing on every GPS tick would
        thrash the disk for no gain.
        """
        self._last = {"lat": lat, "lng": lng}
        self._update_count += 1
        if self._update_count % 10 == 0 and self._on_change:
            self._on_change()

    # ── Bulk load (used by AppState._load_settings) ────────────────────

    def load(self, last: dict | None = None, home: dict | None = None) -> None:
        """Seed state from persisted settings without triggering on_change."""
        self._last = last
        self._home = home

    # ── Resolution ─────────────────────────────────────────────────────

    def get_initial_position_sync(self) -> dict:
        """Return the last saved position or ``DEFAULT_LOCATION``.

        Synchronous variant for endpoints that can't await (e.g. the root
        status endpoint); skips IP geolocation.
        """
        return self._last or DEFAULT_LOCATION

    async def get_initial_position(self) -> dict:
        """Full async variant with IP geolocation fallback.

        Logs each chosen branch so startup traces show *why* the app
        opened on the map location it did.
        """
        if self._home:
            logger.info(
                "Using home position: (%.6f, %.6f)",
                self._home["lat"], self._home["lng"],
            )
            return self._home
        if self._last:
            logger.info(
                "Using last saved position: (%.6f, %.6f)",
                self._last["lat"], self._last["lng"],
            )
            return self._last
        ip_loc = await self._fetch_ip_location()
        if ip_loc:
            return ip_loc
        logger.info("Falling back to DEFAULT_LOCATION")
        return DEFAULT_LOCATION

    async def _fetch_ip_location(self) -> dict | None:
        """Query ip-api.com for a city-level fix. Returns None on any
        failure (network, malformed response, non-success status) — the
        caller falls back to DEFAULT_LOCATION."""
        try:
            async with httpx.AsyncClient(timeout=_IP_GEO_TIMEOUT_SECONDS) as client:
                resp = await client.get(
                    "http://ip-api.com/json?fields=status,lat,lon,city,country"
                )
                data = resp.json()
                if data.get("status") == "success":
                    lat, lng = float(data["lat"]), float(data["lon"])
                    city = data.get("city", "")
                    country = data.get("country", "")
                    logger.info(
                        "IP geolocation: (%.4f, %.4f) — %s, %s",
                        lat, lng, city, country,
                    )
                    return {"lat": lat, "lng": lng}
                logger.debug("IP geolocation returned non-success status: %s", data)
        except Exception as exc:
            logger.debug(
                "IP geolocation failed (%s: %s); using default",
                type(exc).__name__, exc,
            )
        return None
