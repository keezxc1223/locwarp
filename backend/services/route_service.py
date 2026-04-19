"""OSRM route planning service."""

from __future__ import annotations

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

_TIMEOUT = httpx.Timeout(15.0, connect=5.0)

# 路線快取：最多保存 128 條不同路線，避免重複 OSRM 請求（降低延遲）
# 每條快取附帶存入時間戳；超過 _ROUTE_CACHE_TTL 秒的條目視為過期。
_ROUTE_CACHE: dict[tuple, tuple[dict, float]] = {}   # key → (result, stored_at)
_ROUTE_CACHE_MAX = 128
_ROUTE_CACHE_TTL = 300.0  # 5 分鐘：路況不太可能在 5 分鐘內大幅改變


class RouteService:
    """Thin async wrapper around the OSRM HTTP API."""

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
    ) -> dict:
        """Plan a route between two points via OSRM.

        Returns
        -------
        dict
            coords:         list of [lat, lng] pairs (route geometry)
            duration:        total duration in seconds
            distance:        total distance in meters
            leg_durations:   list of per-leg durations (seconds)
        """
        # 快取 key：座標四捨五入到小數第4位（~11m 精度），避免浮點微差造成 cache miss
        cache_key = (
            round(start_lat, 4), round(start_lng, 4),
            round(end_lat, 4),   round(end_lng, 4),
            profile,
        )
        now = time.monotonic()
        if cache_key in _ROUTE_CACHE:
            cached_result, stored_at = _ROUTE_CACHE[cache_key]
            if now - stored_at < _ROUTE_CACHE_TTL:
                logger.debug("Route cache hit: %s", cache_key)
                return cached_result
            # 條目已過期：刪除並重新請求
            logger.debug("Route cache expired: %s", cache_key)
            del _ROUTE_CACHE[cache_key]

        waypoints = [
            (start_lat, start_lng),
            (end_lat, end_lng),
        ]
        result = await self._fetch_route(waypoints, profile)

        # LRU 淘汰：超過上限時刪除最舊的項目（dict 在 Python 3.7+ 保持插入順序）
        if len(_ROUTE_CACHE) >= _ROUTE_CACHE_MAX:
            oldest_key = next(iter(_ROUTE_CACHE))
            del _ROUTE_CACHE[oldest_key]
        _ROUTE_CACHE[cache_key] = (result, now)
        return result

    async def get_multi_route(
        self,
        waypoints: list[tuple[float, float] | list[float] | dict],
        profile: str = "foot",
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

        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()

        if data.get("code") != "Ok":
            msg = data.get("message", "Unknown OSRM error")
            raise RuntimeError(f"OSRM error: {msg}")

        routes = data.get("routes", [])
        if not routes:
            raise RuntimeError("OSRM returned no routes for the given waypoints")

        route = routes[0]
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
