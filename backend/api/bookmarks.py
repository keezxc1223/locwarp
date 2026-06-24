from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from models.schemas import Bookmark, BookmarkCategory, BookmarkMoveRequest

router = APIRouter(prefix="/api/bookmarks", tags=["bookmarks"])


def _bm():
    from main import app_state
    return app_state.bookmark_manager


class BookmarkUiState(BaseModel):
    expanded_categories: list[str] | None = None


# ── Bookmarks ─────────────────────────────────────────────

@router.get("", response_model=dict)
async def list_bookmarks():
    bm = _bm()
    return {
        "categories": [c.model_dump() for c in bm.list_categories()],
        "bookmarks": [b.model_dump() for b in bm.list_bookmarks()],
    }


@router.post("", response_model=Bookmark)
async def create_bookmark(bookmark: Bookmark):
    bm = _bm()
    return bm.create_bookmark(
        name=bookmark.name,
        lat=bookmark.lat,
        lng=bookmark.lng,
        address=bookmark.address,
        category_id=bookmark.category_id,
        country_code=bookmark.country_code,
    )


@router.put("/{bookmark_id}", response_model=Bookmark)
async def update_bookmark(bookmark_id: str, bookmark: Bookmark):
    bm = _bm()
    updated = bm.update_bookmark(
        bookmark_id,
        name=bookmark.name,
        lat=bookmark.lat,
        lng=bookmark.lng,
        address=bookmark.address,
        category_id=bookmark.category_id,
        country_code=bookmark.country_code,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return updated


@router.delete("/{bookmark_id}")
async def delete_bookmark(bookmark_id: str):
    bm = _bm()
    if not bm.delete_bookmark(bookmark_id):
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return {"status": "deleted"}


@router.post("/move")
async def move_bookmarks(req: BookmarkMoveRequest):
    bm = _bm()
    count = bm.move_bookmarks(req.bookmark_ids, req.target_category_id)
    return {"moved": count}


class _ReorderBookmarksRequest(BaseModel):
    category_id: str
    bookmark_ids: list[str]


@router.post("/reorder")
async def reorder_bookmarks(req: _ReorderBookmarksRequest):
    bm = _bm()
    count = bm.reorder_bookmarks_in_category(req.category_id, req.bookmark_ids)
    return {"reordered": count}


class _ReorderCategoriesRequest(BaseModel):
    category_ids: list[str]


@router.post("/categories/reorder")
async def reorder_categories(req: _ReorderCategoriesRequest):
    bm = _bm()
    count = bm.reorder_categories(req.category_ids)
    return {"reordered": count}


# ── Categories ────────────────────────────────────────────

@router.get("/categories", response_model=list[BookmarkCategory])
async def list_categories():
    bm = _bm()
    return bm.list_categories()


@router.post("/categories", response_model=BookmarkCategory)
async def create_category(cat: BookmarkCategory):
    bm = _bm()
    return bm.create_category(name=cat.name, color=cat.color)


@router.put("/categories/{cat_id}", response_model=BookmarkCategory)
async def update_category(cat_id: str, cat: BookmarkCategory):
    bm = _bm()
    updated = bm.update_category(cat_id, name=cat.name, color=cat.color)
    if not updated:
        raise HTTPException(status_code=404, detail="Category not found")
    return updated


@router.delete("/categories/{cat_id}")
async def delete_category(cat_id: str):
    bm = _bm()
    if cat_id == "default":
        raise HTTPException(status_code=400, detail="Cannot delete default category")
    if not bm.delete_category(cat_id):
        raise HTTPException(status_code=404, detail="Category not found")
    return {"status": "deleted"}


# ── Import / Export ───────────────────────────────────────

@router.get("/export")
async def export_bookmarks():
    bm = _bm()
    data = bm.export_json()
    return Response(content=data, media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename="bookmarks.json"'})


@router.get("/gpx/export/{bookmark_id}")
async def export_bookmark_gpx(bookmark_id: str):
    """Export a single saved coordinate as a GPX waypoint file."""
    bm = _bm()
    mark = next((b for b in bm.list_bookmarks() if b.id == bookmark_id), None)
    if mark is None:
        raise HTTPException(status_code=404, detail="Bookmark not found")

    from services.gpx_service import GpxService
    import urllib.parse

    gpx_xml = GpxService.generate_gpx_waypoints(
        [{"lat": mark.lat, "lng": mark.lng, "name": mark.name,
          "description": mark.address or None}],
        name=mark.name or "LocWarp Bookmark",
    )
    base = mark.name or "bookmark"
    safe_name = "".join(ch if ord(ch) < 128 and ch not in '"\\/' else "_" for ch in base) or "bookmark"
    utf8_encoded = urllib.parse.quote(f"{base}.gpx", safe="")
    disposition = f'attachment; filename="{safe_name}.gpx"; filename*=UTF-8\'\'{utf8_encoded}'
    return Response(content=gpx_xml, media_type="application/gpx+xml",
                    headers={"Content-Disposition": disposition})


@router.post("/import")
async def import_bookmarks(data: dict):
    import json
    bm = _bm()
    count = bm.import_json(json.dumps(data))
    return {"imported": count}


# ── UI state (persists per-category collapse in ~/.locwarp/settings.json) ──

@router.get("/ui-state")
async def get_bookmark_ui_state():
    from main import app_state
    return {"expanded_categories": app_state._bookmark_expanded_categories}


@router.post("/ui-state")
async def set_bookmark_ui_state(req: BookmarkUiState):
    from main import app_state
    app_state._bookmark_expanded_categories = (
        list(req.expanded_categories) if req.expanded_categories is not None else []
    )
    app_state.save_settings()
    return {"status": "ok", "expanded_categories": app_state._bookmark_expanded_categories}
