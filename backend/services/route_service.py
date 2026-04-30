"""Route planning service supporting multiple free routing engines."""

from __future__ import annotations

import logging

import httpx

from config import (
    BROUTER_BASE_URL,
    DEFAULT_ROUTE_ENGINE,
    OSRM_BASE_URL,
    OSRM_FOSSGIS_BASE_URL,
    ROUTE_ENGINE_BROUTER,
    ROUTE_ENGINE_OSRM,
    ROUTE_ENGINE_OSRM_FOSSGIS,
    ROUTE_ENGINE_VALHALLA,
    ROUTE_ENGINES_ALLOWED,
    VALHALLA_BASE_URL,
)

logger = logging.getLogger(__name__)

# Map user-facing profile names to the OSRM URL slug used by the demo
# server (router.project-osrm.org). The demo accepts {car, foot, bike}.
_OSRM_DEMO_PROFILE = {
    "walking": "foot",
    "running": "foot",
    "driving": "car",
    "foot": "foot",
    "car": "car",
    "bike": "bike",
    "bicycle": "bike",
}

# FOSSGIS hosts each profile on its own /routed-X path and uses the
# canonical OSRM v1 profile names ("driving", "foot", "bike") inside the
# URL itself. So a "driving" request becomes
# /routed-car/route/v1/driving/...
_OSRM_FOSSGIS_PROFILE = {
    "walking": ("routed-foot", "foot"),
    "running": ("routed-foot", "foot"),
    "driving": ("routed-car", "driving"),
    "foot": ("routed-foot", "foot"),
    "car": ("routed-car", "driving"),
    "bike": ("routed-bike", "bike"),
    "bicycle": ("routed-bike", "bike"),
}

# Valhalla uses different costing model names than OSRM profiles.
_VALHALLA_COSTING = {
    "walking": "pedestrian",
    "running": "pedestrian",
    "driving": "auto",
    "foot": "pedestrian",
    "car": "auto",
    "bike": "bicycle",
    "bicycle": "bicycle",
}

# BRouter ships ~20 named profiles compiled from its DSL. We expose
# the well-known ones; "shortest" is the safest pedestrian default
# (no highway preference, follows any traversable way), "trekking"
# is the standard touring-bike profile.
_BROUTER_PROFILE = {
    "walking": "shortest",
    "running": "shortest",
    "driving": "car-fast",
    "foot": "shortest",
    "car": "car-fast",
    "bike": "trekking",
    "bicycle": "trekking",
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
    """Construct a straight-line route as a last resort when the routing
    engine is unreachable. Densifies each segment so the interpolator
    has enough sample points."""
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


def _decode_polyline6(encoded: str) -> list[tuple[float, float]]:
    """Decode a Valhalla polyline6 string into (lat, lng) pairs.

    Standard Google polyline algorithm with precision 6 (1e-6 degrees)
    instead of 5. Valhalla returns this in trip.legs[i].shape.
    """
    coords: list[tuple[float, float]] = []
    index = 0
    lat = 0
    lng = 0
    n = len(encoded)
    while index < n:
        # latitude
        shift = 0
        result = 0
        while True:
            b = ord(encoded[index]) - 63
            index += 1
            result |= (b & 0x1f) << shift
            shift += 5
            if b < 0x20:
                break
        dlat = ~(result >> 1) if result & 1 else (result >> 1)
        lat += dlat
        # longitude
        shift = 0
        result = 0
        while True:
            b = ord(encoded[index]) - 63
            index += 1
            result |= (b & 0x1f) << shift
            shift += 5
            if b < 0x20:
                break
        dlng = ~(result >> 1) if result & 1 else (result >> 1)
        lng += dlng
        coords.append((lat / 1e6, lng / 1e6))
    return coords


def _normalise_engine(engine: str | None) -> str:
    """Coerce caller-supplied engine string to a known value, falling
    back to the default if the value is None or unrecognised."""
    if engine and engine in ROUTE_ENGINES_ALLOWED:
        return engine
    return DEFAULT_ROUTE_ENGINE


class RouteService:
    """Async wrapper around the supported routing engines."""

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
        engine: str | None = None,
    ) -> dict:
        """Plan a route between two points via the chosen engine.

        When *force_straight* is True, skip the engine entirely and serve
        a densified straight-line route (used by the global
        "straight-line" toggle for users who want raw bearing-to-point
        travel).
        """
        waypoints = [
            (start_lat, start_lng),
            (end_lat, end_lng),
        ]
        if force_straight:
            return _straight_line_fallback(waypoints)
        return await self._fetch_route(waypoints, profile, _normalise_engine(engine))

    async def get_multi_route(
        self,
        waypoints: list[tuple[float, float] | list[float] | dict],
        profile: str = "foot",
        force_straight: bool = False,
        engine: str | None = None,
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
        return await self._fetch_route(normalised, profile, _normalise_engine(engine))

    # ------------------------------------------------------------------
    # Internal dispatch
    # ------------------------------------------------------------------

    async def _fetch_route(
        self,
        waypoints: list[tuple[float, float]],
        profile: str,
        engine: str,
    ) -> dict:
        # Per-request fallback only; do NOT cache failures across a
        # region. A single transient blip (demo-server 502s, etc.)
        # would otherwise force every subsequent leg of a random walk
        # onto a straight line for the rest of the cache window.
        try:
            if engine == ROUTE_ENGINE_VALHALLA:
                return await self._fetch_valhalla(waypoints, profile)
            if engine == ROUTE_ENGINE_BROUTER:
                return await self._fetch_brouter(waypoints, profile)
            return await self._fetch_osrm(waypoints, profile, engine)
        except (httpx.HTTPError, httpx.TimeoutException, RuntimeError) as e:
            logger.warning(
                "%s failed (%s); using straight-line fallback for this leg",
                engine, type(e).__name__,
            )
            return _straight_line_fallback(waypoints)

    # ------------------------------------------------------------------
    # OSRM (demo + FOSSGIS)
    # ------------------------------------------------------------------

    async def _fetch_osrm(
        self,
        waypoints: list[tuple[float, float]],
        profile: str,
        engine: str,
    ) -> dict:
        if engine == ROUTE_ENGINE_OSRM_FOSSGIS:
            prefix, osrm_profile = _OSRM_FOSSGIS_PROFILE.get(
                profile, ("routed-foot", "foot"),
            )
            base = f"{OSRM_FOSSGIS_BASE_URL}/{prefix}"
        else:
            osrm_profile = _OSRM_DEMO_PROFILE.get(profile, profile)
            base = OSRM_BASE_URL

        # OSRM coordinate pairs are lon,lat (not lat,lon)
        coords_str = ";".join(f"{lng},{lat}" for lat, lng in waypoints)
        url = (
            f"{base}/route/v1/{osrm_profile}/{coords_str}"
            "?overview=full&geometries=geojson&steps=true"
            "&annotations=duration,distance"
        )

        logger.debug("OSRM request (%s): %s", engine, url)

        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
        if data.get("code") != "Ok":
            msg = data.get("message", "Unknown OSRM error")
            raise RuntimeError(f"OSRM error: {msg}")

        route = data["routes"][0]
        geometry = route["geometry"]  # GeoJSON LineString
        # GeoJSON coordinates are [lon, lat]; convert to [lat, lng]
        coords = [[pt[1], pt[0]] for pt in geometry["coordinates"]]
        leg_durations = [leg["duration"] for leg in route["legs"]]

        return {
            "coords": coords,
            "duration": route["duration"],
            "distance": route["distance"],
            "leg_durations": leg_durations,
        }

    # ------------------------------------------------------------------
    # Valhalla (FOSSGIS)
    # ------------------------------------------------------------------

    async def _fetch_valhalla(
        self,
        waypoints: list[tuple[float, float]],
        profile: str,
    ) -> dict:
        costing = _VALHALLA_COSTING.get(profile, "pedestrian")
        body = {
            "locations": [{"lat": lat, "lon": lng} for lat, lng in waypoints],
            "costing": costing,
            "directions_options": {"units": "kilometers"},
        }
        url = f"{VALHALLA_BASE_URL}/route"
        logger.debug("Valhalla request: %s body=%s", url, body)

        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(url, json=body)
            resp.raise_for_status()
            data = resp.json()

        trip = data.get("trip")
        if not trip:
            raise RuntimeError("Valhalla returned no trip")
        if trip.get("status") not in (0, None):
            raise RuntimeError(f"Valhalla error: {trip.get('status_message')}")

        legs = trip.get("legs", [])
        if not legs:
            raise RuntimeError("Valhalla returned no legs")

        coords: list[list[float]] = []
        leg_durations: list[float] = []
        total_distance_km = 0.0
        total_time_s = 0.0
        for i, leg in enumerate(legs):
            shape = leg.get("shape")
            if not shape:
                continue
            decoded = _decode_polyline6(shape)
            # Avoid duplicating the seam point between legs.
            if i > 0 and coords and decoded:
                decoded = decoded[1:]
            coords.extend([list(pt) for pt in decoded])
            summary = leg.get("summary") or {}
            leg_time = float(summary.get("time", 0.0))
            leg_durations.append(leg_time)
            total_time_s += leg_time
            total_distance_km += float(summary.get("length", 0.0))

        if not coords:
            raise RuntimeError("Valhalla decoded geometry was empty")

        # Trip-level summary if provided is more authoritative.
        trip_summary = trip.get("summary") or {}
        if trip_summary:
            total_time_s = float(trip_summary.get("time", total_time_s))
            total_distance_km = float(trip_summary.get("length", total_distance_km))

        return {
            "coords": coords,
            "duration": total_time_s,
            "distance": total_distance_km * 1000.0,  # km → m
            "leg_durations": leg_durations,
        }

    # ------------------------------------------------------------------
    # BRouter (brouter.de)
    # ------------------------------------------------------------------

    async def _fetch_brouter(
        self,
        waypoints: list[tuple[float, float]],
        profile: str,
    ) -> dict:
        brouter_profile = _BROUTER_PROFILE.get(profile, "shortest")
        # BRouter expects lon,lat pairs separated by '|'.
        lonlats = "|".join(f"{lng},{lat}" for lat, lng in waypoints)
        url = (
            f"{BROUTER_BASE_URL}/brouter"
            f"?lonlats={lonlats}"
            f"&profile={brouter_profile}"
            "&alternativeidx=0&format=geojson"
        )
        logger.debug("BRouter request: %s", url)

        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()

        feats = data.get("features") or []
        if not feats:
            raise RuntimeError("BRouter returned no features")
        feat = feats[0]
        geom = feat.get("geometry") or {}
        raw_coords = geom.get("coordinates") or []
        if not raw_coords:
            raise RuntimeError("BRouter returned empty geometry")
        # BRouter coords are [lon, lat, elevation_m]; drop elevation and
        # swap to [lat, lng] for our interpolator.
        coords = [[pt[1], pt[0]] for pt in raw_coords]

        props = feat.get("properties") or {}
        try:
            distance_m = float(props.get("track-length") or 0.0)
        except (TypeError, ValueError):
            distance_m = 0.0
        try:
            duration_s = float(props.get("total-time") or 0.0)
        except (TypeError, ValueError):
            duration_s = 0.0

        return {
            "coords": coords,
            "duration": duration_s,
            "distance": distance_m,
            "leg_durations": [duration_s],
        }
