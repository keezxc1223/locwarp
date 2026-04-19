import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from models.schemas import RoutePlanRequest, SavedRoute
from services.gpx_service import GpxService
from services.route_service import RouteService

router = APIRouter(prefix="/api/route", tags=["route"])

route_service = RouteService()
gpx_service = GpxService()

# ── Persistence ──────────────────────────────────────────────────────────────
_ROUTES_FILE = Path.home() / ".locwarp" / "routes.json"

def _load_routes() -> dict[str, SavedRoute]:
    try:
        if _ROUTES_FILE.exists():
            raw = json.loads(_ROUTES_FILE.read_text(encoding="utf-8"))
            return {r["id"]: SavedRoute(**r) for r in raw if "id" in r}
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("Failed to load routes: %s", exc)
    return {}

def _save_routes(routes: dict[str, SavedRoute]) -> None:
    try:
        _ROUTES_FILE.parent.mkdir(parents=True, exist_ok=True)
        payload = [r.model_dump() for r in routes.values()]
        _ROUTES_FILE.write_text(json.dumps(payload, indent=2, ensure_ascii=False),
                                encoding="utf-8")
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("Failed to save routes: %s", exc)

# Load once at import time
_saved_routes: dict[str, SavedRoute] = _load_routes()


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/plan")
async def plan_route(req: RoutePlanRequest):
    profile_map = {"walking": "foot", "running": "foot", "driving": "car",
                   "foot": "foot", "car": "car"}
    profile = profile_map.get(req.profile, "foot")
    result = await route_service.get_route(
        req.start.lat, req.start.lng, req.end.lat, req.end.lng, profile)
    return result


@router.get("/saved", response_model=list[SavedRoute])
async def list_saved():
    return list(_saved_routes.values())


@router.post("/saved", response_model=SavedRoute)
async def save_route(route: SavedRoute):
    route.id = str(uuid.uuid4())
    route.created_at = datetime.now(UTC).isoformat()
    _saved_routes[route.id] = route
    _save_routes(_saved_routes)
    return route


@router.delete("/saved/{route_id}")
async def delete_saved(route_id: str):
    if route_id not in _saved_routes:
        raise HTTPException(status_code=404, detail="Route not found")
    del _saved_routes[route_id]
    _save_routes(_saved_routes)
    return {"status": "deleted"}


from pydantic import BaseModel as _BM


class _RouteRenameRequest(_BM):
    name: str


@router.patch("/saved/{route_id}")
async def rename_saved(route_id: str, req: _RouteRenameRequest):
    if route_id not in _saved_routes:
        raise HTTPException(status_code=404, detail="Route not found")
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400,
                            detail={"code": "invalid_name", "message": "路線名稱不可為空"})
    _saved_routes[route_id].name = name
    _save_routes(_saved_routes)
    return _saved_routes[route_id]


@router.post("/gpx/import")
async def import_gpx(file: UploadFile = File(...)):
    content = await file.read()
    text = content.decode("utf-8")
    coords = gpx_service.parse_gpx(text)
    route = SavedRoute(
        id=str(uuid.uuid4()),
        name=file.filename or "Imported GPX",
        waypoints=coords,
        profile="walking",
        created_at=datetime.now(UTC).isoformat(),
    )
    _saved_routes[route.id] = route
    _save_routes(_saved_routes)
    return {"status": "imported", "id": route.id, "points": len(coords)}


@router.get("/gpx/export/{route_id}")
async def export_gpx(route_id: str):
    if route_id not in _saved_routes:
        raise HTTPException(status_code=404, detail="Route not found")
    route = _saved_routes[route_id]
    points = [{"lat": c.lat, "lng": c.lng} for c in route.waypoints]
    gpx_xml = gpx_service.generate_gpx(points, name=route.name)
    from fastapi.responses import Response
    return Response(
        content=gpx_xml,
        media_type="application/gpx+xml",
        headers={"Content-Disposition": f'attachment; filename="{route.name}.gpx"'},
    )
