import logging

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from models.schemas import (
    Coordinate,
    GeocodingResult,
    RouteOptimizeRequest,
    RouteOptimizeResponse,
    TimezoneInfo,
)
from services.geocoding import GeocodingService
from services.geo_extras import (
    _HAVERSINE_PROFILE_SPEED_MPS,
    get_timezone,
    haversine_duration_matrix,
    optimize_order_exact,
    optimize_order_nearest_neighbor,
    osrm_table,
    valhalla_matrix,
)

router = APIRouter(prefix="/api/geocode", tags=["geocode"])
logger = logging.getLogger("locwarp")

geocoding_service = GeocodingService()


@router.get("/search", response_model=list[GeocodingResult])
async def search_address(
    q: str,
    limit: int = 5,
    provider: str = "nominatim",
    google_key: str | None = None,
):
    """Forward geocode.

    `provider` is one of ``nominatim`` (default, free, no key),
    ``photon`` (also free / no key, fuzzy-friendly OSM mirror at
    komoot.io), or ``google`` (requires `google_key`, 10k events/month
    free tier on Google's Essentials plan).
    """
    return await geocoding_service.search(q, limit, provider, google_key)


@router.get("/reverse", response_model=GeocodingResult | None)
async def reverse_geocode(lat: float, lng: float):
    return await geocoding_service.reverse(lat, lng)


class ProviderPref(BaseModel):
    provider: str = Field(pattern="^(nominatim|photon|google)$")
    google_key: str = ""


@router.get("/provider-pref")
async def get_provider_pref():
    """Return the desktop's currently-selected geocode provider so the
    phone page can honour the same choice — the desktop's pick lives in
    Electron-renderer localStorage which the mobile browser can't read."""
    from main import app_state
    return {
        "provider": app_state._geocode_provider,
        "has_google_key": bool(app_state._google_geocode_key),
    }


@router.put("/provider-pref")
async def set_provider_pref(pref: ProviderPref):
    """Desktop pushes its provider choice here whenever the user changes
    it in the search settings modal, so the same choice flows to /api/
    phone/geocode."""
    from main import app_state
    app_state._geocode_provider = pref.provider
    # Only overwrite the stored key when one is supplied so the user can
    # toggle Google off / on without re-entering it.
    if pref.google_key:
        app_state._google_geocode_key = pref.google_key.strip()
    elif pref.provider != "google":
        # Allow explicit clear when switching away from google.
        pass
    app_state.save_settings()
    return {"ok": True}


@router.get("/timezone", response_model=TimezoneInfo | None)
async def timezone_lookup(lat: float, lng: float):
    """Return IANA timezone + UTC offset for a coordinate (TimezoneDB)."""
    return await get_timezone(lat, lng)


@router.get("/real-location")
async def real_location():
    """Resolve the user's real public IP to city-level coordinates.

    Runs on the backend (not the Electron renderer) so we bypass CORS and
    TLS-cert issues that killed the renderer-direct version. Tries three
    free providers in sequence and returns the first one that gives us a
    valid lat/lng.

    Returns: {"lat": float, "lng": float, "city": str, "country": str}
    Raises 502 if every provider fails.
    """
    providers = [
        # (name, url, extractor)
        (
            "ipwho.is",
            "https://ipwho.is/?fields=success,latitude,longitude,city,region,country",
            lambda d: None
            if d.get("success") is False
            else (
                float(d["latitude"]),
                float(d["longitude"]),
                str(d.get("city") or d.get("region") or ""),
                str(d.get("country") or ""),
            )
            if d.get("latitude") is not None and d.get("longitude") is not None
            else None,
        ),
        (
            "ip-api.com",
            "http://ip-api.com/json/?fields=status,lat,lon,city,regionName,country",
            lambda d: (
                float(d["lat"]),
                float(d["lon"]),
                str(d.get("city") or d.get("regionName") or ""),
                str(d.get("country") or ""),
            )
            if d.get("status") == "success"
            else None,
        ),
        (
            "ipapi.co",
            "https://ipapi.co/json/",
            lambda d: (
                float(d["latitude"]),
                float(d["longitude"]),
                str(d.get("city") or d.get("region") or ""),
                str(d.get("country_name") or d.get("country") or ""),
            )
            if d.get("latitude") is not None and d.get("longitude") is not None
            else None,
        ),
    ]

    last_err: str = ""
    async with httpx.AsyncClient(timeout=httpx.Timeout(6.0, connect=3.0)) as client:
        for name, url, extract in providers:
            try:
                resp = await client.get(url)
                resp.raise_for_status()
                data = resp.json()
                result = extract(data)
                if result is None:
                    last_err = f"{name} returned no location"
                    continue
                lat, lng, city, country = result
                logger.info("real-location resolved via %s: %.4f, %.4f (%s)", name, lat, lng, city)
                return {"lat": lat, "lng": lng, "city": city, "country": country}
            except Exception as exc:
                last_err = f"{name}: {exc}"
                logger.info("real-location provider %s failed: %s", name, exc)
                continue

    raise HTTPException(status_code=502, detail=f"All IP geolocation providers failed ({last_err})")


@router.post("/route-optimize", response_model=RouteOptimizeResponse)
async def route_optimize(req: RouteOptimizeRequest):
    """Reorder waypoints to minimize total travel time.

    Uses OSRM /table when feasible (<=100 waypoints AND the demo server
    responds). Otherwise falls back to a straight-line haversine duration
    matrix — accuracy trades road distance for crow-flight, which is fine
    for dense Pokemon-GO style loops where adjacent points are already
    close together. The endpoint always succeeds; no more 503.
    """
    if len(req.waypoints) < 2:
        raise HTTPException(status_code=400, detail="need >=2 waypoints")

    # Engine dispatch for the duration matrix used by the TSP solver.
    # The user-selected engine controls the *path* taken between points
    # at simulation time, but the matrix only affects ordering — so
    # when the chosen engine has no matrix API (BRouter), we silently
    # try OSRM /table → Valhalla /sources_to_targets → haversine. That
    # way picking BRouter still gives road-aware ordering instead of
    # forcing a "straight-line estimate" label on every optimize.
    engine = (req.engine or "osrm").lower()
    durations: list[list[float]] | None = None
    if req.straight_line:
        # Straight-line mode moves crow-flight, so order by haversine distance.
        # Road-based duration ordering is wrong for straight-line travel; here
        # haversine is the true distance, so this is NOT a fallback estimate.
        durations = haversine_duration_matrix(req.waypoints, req.profile)
    elif engine == "valhalla":
        durations = await valhalla_matrix(req.waypoints, req.profile)
        if not durations:
            logger.info(
                "route_optimize: Valhalla matrix unavailable for %d waypoints, trying OSRM /table",
                len(req.waypoints),
            )
            durations = await osrm_table(req.waypoints, req.profile)
    elif engine == "brouter":
        # BRouter has no matrix endpoint, so reach for OSRM /table first
        # (closest in semantics to BRouter's road-aware costing) and
        # then Valhalla as a second fallback.
        logger.info(
            "route_optimize: BRouter has no matrix API; using OSRM /table for ordering of %d waypoints",
            len(req.waypoints),
        )
        durations = await osrm_table(req.waypoints, req.profile)
        if not durations:
            durations = await valhalla_matrix(req.waypoints, req.profile)
    else:  # osrm
        durations = await osrm_table(req.waypoints, req.profile)
        if not durations:
            logger.info(
                "route_optimize: OSRM /table unavailable, trying Valhalla matrix for %d waypoints",
                len(req.waypoints),
            )
            durations = await valhalla_matrix(req.waypoints, req.profile)

    used_estimate = False
    if not durations:
        durations = haversine_duration_matrix(req.waypoints, req.profile)
        used_estimate = True
        logger.info(
            "route_optimize: all matrix engines unavailable, using haversine fallback for %d waypoints (engine=%s)",
            len(req.waypoints), engine,
        )

    # Brute-force optimal up to 8 points, heuristic beyond. With the
    # haversine matrix the brute-force is still cheap (8! = 40320 perms).
    if len(req.waypoints) <= 8:
        order = optimize_order_exact(durations, req.keep_first)
    else:
        order = optimize_order_nearest_neighbor(durations, req.keep_first)

    reordered = [req.waypoints[i] for i in order]
    total_duration = 0.0
    for a, b in zip(order, order[1:]):
        d = durations[a][b] or 0.0
        total_duration += d

    # Reconstruct an estimated road distance from the duration matrix using
    # each engine's natural-walking baseline. The frontend re-derives ETA
    # from this distance using the user's actual sim speed (which is often
    # 3~10 km/h, very different from OSRM/Valhalla's 5 km/h built-in
    # pedestrian speed). Without this scaling step the optimizer toast
    # would advertise OSRM's wall-clock instead of the user's.
    baseline_speed = _HAVERSINE_PROFILE_SPEED_MPS.get(req.profile, 1.4)
    total_distance_m = total_duration * baseline_speed

    return RouteOptimizeResponse(
        waypoints=[Coordinate(lat=wp.lat, lng=wp.lng) for wp in reordered],
        total_distance_m=total_distance_m,
        total_duration_s=total_duration,
        used_estimate=used_estimate,
    )
