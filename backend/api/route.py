import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, UploadFile, File

from config import ROUTES_FILE
from models.schemas import RoutePlanRequest, SavedRoute, Coordinate
from services.route_service import RouteService
from services.gpx_service import GpxService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/route", tags=["route"])

route_service = RouteService()
gpx_service = GpxService()


def _load_saved_routes() -> dict[str, SavedRoute]:
    if not ROUTES_FILE.exists():
        return {}
    try:
        raw = json.loads(ROUTES_FILE.read_text(encoding="utf-8"))
        out: dict[str, SavedRoute] = {}
        for item in raw.get("routes", []):
            try:
                route = SavedRoute(**item)
                out[route.id] = route
            except Exception as e:
                logger.warning("skip malformed saved route: %s", e)
        return out
    except Exception as e:
        logger.error("failed to read routes.json, starting empty: %s", e)
        return {}


def _persist_saved_routes() -> None:
    try:
        payload = {"routes": [r.model_dump(mode="json") for r in _saved_routes.values()]}
        ROUTES_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        logger.error("failed to write routes.json: %s", e)


_saved_routes: dict[str, SavedRoute] = _load_saved_routes()


@router.post("/plan")
async def plan_route(req: RoutePlanRequest):
    profile_map = {"walking": "foot", "running": "foot", "driving": "car", "foot": "foot", "car": "car"}
    profile = profile_map.get(req.profile, "foot")
    result = await route_service.get_route(req.start.lat, req.start.lng, req.end.lat, req.end.lng, profile)
    return result


@router.get("/saved", response_model=list[SavedRoute])
async def list_saved():
    return list(_saved_routes.values())


@router.post("/saved", response_model=SavedRoute)
async def save_route(route: SavedRoute):
    route.id = str(uuid.uuid4())
    route.created_at = datetime.now(timezone.utc).isoformat()
    _saved_routes[route.id] = route
    _persist_saved_routes()
    return route


@router.delete("/saved/{route_id}")
async def delete_saved(route_id: str):
    if route_id not in _saved_routes:
        raise HTTPException(status_code=404, detail="Route not found")
    del _saved_routes[route_id]
    _persist_saved_routes()
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
        raise HTTPException(status_code=400, detail={"code": "invalid_name", "message": "路線名稱不可為空"})
    _saved_routes[route_id].name = name
    _persist_saved_routes()
    return _saved_routes[route_id]


@router.get("/saved/export")
async def export_all_saved_routes():
    """Export every saved route as a single JSON bundle."""
    payload = {"routes": [r.model_dump(mode="json") for r in _saved_routes.values()]}
    from fastapi.responses import Response
    import json as _json
    body = _json.dumps(payload, ensure_ascii=False, indent=2)
    return Response(content=body, media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename="locwarp-routes.json"'})


class _RouteImportBody(_BM):
    routes: list[SavedRoute]


@router.post("/saved/import")
async def import_all_saved_routes(body: _RouteImportBody):
    """Merge imported routes into saved. Imports get fresh ids so they never collide."""
    imported = 0
    for r in body.routes:
        r.id = str(uuid.uuid4())
        r.created_at = datetime.now(timezone.utc).isoformat()
        _saved_routes[r.id] = r
        imported += 1
    if imported:
        _persist_saved_routes()
    return {"imported": imported}


@router.post("/gpx/import")
async def import_gpx(file: UploadFile = File(...)):
    content = await file.read()
    text = content.decode("utf-8")
    coords = gpx_service.parse_gpx(text)
    # Strip the .gpx extension from the filename so the rename input
    # doesn't show "myroute.gpx" — the format suffix is irrelevant to the
    # in-app route name.
    raw_name = file.filename or "Imported GPX"
    base_name = raw_name.rsplit(".", 1)[0] if raw_name.lower().endswith(".gpx") else raw_name
    route = SavedRoute(
        id=str(uuid.uuid4()),
        name=base_name or "Imported GPX",
        waypoints=coords,
        profile="walking",
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    _saved_routes[route.id] = route
    _persist_saved_routes()
    return {"status": "imported", "id": route.id, "points": len(coords)}


@router.get("/gpx/export/{route_id}")
async def export_gpx(route_id: str):
    if route_id not in _saved_routes:
        raise HTTPException(status_code=404, detail="Route not found")
    route = _saved_routes[route_id]
    points = [{"lat": c.lat, "lng": c.lng} for c in route.waypoints]
    gpx_xml = gpx_service.generate_gpx(points, name=route.name)
    from fastapi.responses import Response
    return Response(content=gpx_xml, media_type="application/gpx+xml",
                    headers={"Content-Disposition": f'attachment; filename="{route.name}.gpx"'})
