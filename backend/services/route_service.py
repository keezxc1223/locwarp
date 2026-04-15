"""OSRM route planning service."""

from __future__ import annotations

import asyncio
import logging
import time

import httpx

from config import OSRM_BASE_URL

logger = logging.getLogger(__name__)

# Map user-facing profile names to OSRM profile slugs
_PROFILE_MAP = {
    "walking": "foot",
    "running": "foot",
    "driving": "car",
    "foot": "foot",
    "car": "car",
    "bike": "bike",
    "bicycle": "bicycle",
}

_TIMEOUT = httpx.Timeout(8.0, connect=4.0)


def _haversine_m(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    """Great-circle distance in meters."""
    import math
    R = 6371000.0
    dlat = math.radians(b_lat - a_lat)
    dlng = math.radians(b_lng - a_lng)
    la1 = math.radians(a_lat)
    la2 = math.radians(b_lat)
    h = math.sin(dlat / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def _straight_line_fallback(waypoints: list[tuple[float, float]], walking_speed_mps: float = 1.4) -> dict:
    """Construct a straight-line route as a last resort when OSRM is unreachable.
    Densifies each segment so the interpolator has enough sample points."""
    coords: list[list[float]] = [[waypoints[0][0], waypoints[0][1]]]
    total_distance = 0.0
    leg_durations: list[float] = []
    step_m = 25.0
    for i in range(len(waypoints) - 1):
        a_lat, a_lng = waypoints[i]
        b_lat, b_lng = waypoints[i + 1]
        seg_d = _haversine_m(a_lat, a_lng, b_lat, b_lng)
        steps = max(1, int(seg_d / step_m))
        for s in range(1, steps + 1):
            t = s / steps
            coords.append([a_lat + (b_lat - a_lat) * t, a_lng + (b_lng - a_lng) * t])
        total_distance += seg_d
        leg_durations.append(seg_d / walking_speed_mps)
    return {
        "coords": coords,
        "duration": total_distance / walking_speed_mps,
        "distance": total_distance,
        "leg_durations": leg_durations,
        "fallback": True,
    }


class RouteService:
    """Thin async wrapper around the OSRM HTTP API."""

    # Per-region OSRM coverage cache. Keyed by 1°×1° grid cell (≈110 km
    # square), value is ('ok' | 'down', monotonic_timestamp). 'ok' means
    # OSRM has data here and a normal request worked. 'down' means a probe
    # request to this region timed out / failed (no map coverage or area
    # blocked) so future requests skip OSRM and go straight to fallback.
    _region_status: dict[tuple[int, int], tuple[str, float]] = {}
    _region_lock: asyncio.Lock | None = None
    _REGION_TTL_SECONDS = 600.0  # re-probe a region every 10 minutes
    _PROBE_TIMEOUT = httpx.Timeout(2.5, connect=2.0)

    @staticmethod
    def _region_key(lat: float, lng: float) -> tuple[int, int]:
        """Bucket coordinates into a 1°×1° grid cell."""
        import math
        return (int(math.floor(lat)), int(math.floor(lng)))

    @classmethod
    def _region_state(cls, key: tuple[int, int]) -> str | None:
        """Return cached status for *key* if still fresh, else None."""
        rec = cls._region_status.get(key)
        if rec is None:
            return None
        status, checked_at = rec
        if (time.monotonic() - checked_at) >= cls._REGION_TTL_SECONDS:
            return None
        return status

    @classmethod
    def _mark_region(cls, key: tuple[int, int], status: str) -> None:
        cls._region_status[key] = (status, time.monotonic())

    # ------------------------------------------------------------------
    # Public helpers
    # ------------------------------------------------------------------

    async def get_route(
        self,
        start_lat: float,
        start_lng: float,
        end_lat: float,
        end_lng: float,
        profile: str = "foot",
        force_straight: bool = False,
    ) -> dict:
        """Plan a route between two points via OSRM.

        When *force_straight* is True, skip OSRM entirely and serve a
        densified straight-line route (used by the global "straight-line"
        toggle for users who want raw bearing-to-point travel).
        """
        waypoints = [
            (start_lat, start_lng),
            (end_lat, end_lng),
        ]
        if force_straight:
            return _straight_line_fallback(waypoints)
        return await self._fetch_route(waypoints, profile)

    async def get_multi_route(
        self,
        waypoints: list[tuple[float, float] | list[float] | dict],
        profile: str = "foot",
        force_straight: bool = False,
    ) -> dict:
        """Plan a route through multiple waypoints.

        *waypoints* may be a list of ``(lat, lng)`` tuples, ``[lat, lng]``
        lists, or dicts with ``lat``/``lng`` keys.
        """
        normalised: list[tuple[float, float]] = []
        for wp in waypoints:
            if isinstance(wp, dict):
                normalised.append((wp["lat"], wp["lng"]))
            else:
                normalised.append((float(wp[0]), float(wp[1])))

        if len(normalised) < 2:
            raise ValueError("At least two waypoints are required")

        if force_straight:
            return _straight_line_fallback(normalised)
        return await self._fetch_route(normalised, profile)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _fetch_route(
        self,
        waypoints: list[tuple[float, float]],
        profile: str,
    ) -> dict:
        osrm_profile = _PROFILE_MAP.get(profile, profile)

        # OSRM coordinate pairs are lon,lat (not lat,lon)
        coords_str = ";".join(
            f"{lng},{lat}" for lat, lng in waypoints
        )

        url = (
            f"{OSRM_BASE_URL}/route/v1/{osrm_profile}/{coords_str}"
            "?overview=full&geometries=geojson&steps=true"
            "&annotations=duration,distance"
        )

        logger.debug("OSRM request: %s", url)

        # Per-region coverage gate: cache OSRM availability by 1°x1° cell
        # keyed off the first waypoint. If we previously confirmed this
        # region is unreachable (no map data / blocked) within TTL, skip
        # OSRM entirely and serve a straight line instantly. New regions
        # get a short-timeout probe; on success we use the existing data
        # and mark 'ok'; on failure we mark 'down' and fall back.
        first_lat, first_lng = waypoints[0]
        key = self._region_key(first_lat, first_lng)
        cached = self._region_state(key)
        if cached == "down":
            return _straight_line_fallback(waypoints)

        timeout = _TIMEOUT if cached == "ok" else self._PROBE_TIMEOUT

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                data = resp.json()
            if data.get("code") != "Ok":
                msg = data.get("message", "Unknown OSRM error")
                raise RuntimeError(f"OSRM error: {msg}")
        except (httpx.HTTPError, httpx.TimeoutException, RuntimeError) as e:
            self._mark_region(key, "down")
            logger.warning(
                "OSRM failed for region %s (%s); marking down, using straight-line",
                key, type(e).__name__,
            )
            return _straight_line_fallback(waypoints)
        else:
            if cached != "ok":
                self._mark_region(key, "ok")
                logger.info("OSRM region %s confirmed ok", key)

        route = data["routes"][0]
        geometry = route["geometry"]  # GeoJSON LineString

        # GeoJSON coordinates are [lon, lat]; convert to [lat, lng]
        coords = [
            [pt[1], pt[0]] for pt in geometry["coordinates"]
        ]

        leg_durations = [leg["duration"] for leg in route["legs"]]

        return {
            "coords": coords,
            "duration": route["duration"],
            "distance": route["distance"],
            "leg_durations": leg_durations,
        }
