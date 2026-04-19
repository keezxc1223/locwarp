"""Location History API"""
from fastapi import APIRouter

router = APIRouter(prefix="/api/history", tags=["history"])

@router.get("")
async def get_history():
    from main import app_state
    return {"entries": app_state.location_history.get_all()}

@router.delete("")
async def clear_history():
    from main import app_state
    app_state.location_history.clear()
    return {"status": "cleared"}

@router.get("/export/gpx")
async def export_history_gpx():
    """Export all location history entries as a GPX track file."""
    from fastapi.responses import Response

    from main import app_state
    from services.gpx_service import GpxService

    entries = app_state.location_history.get_all()
    # get_all() returns newest-first; reverse to chronological order for GPX
    points = [{"lat": e["lat"], "lng": e["lng"]} for e in reversed(entries)]
    gpx_xml = GpxService().generate_gpx(points, name="LocWarp History")
    return Response(
        content=gpx_xml,
        media_type="application/gpx+xml",
        headers={"Content-Disposition": 'attachment; filename="locwarp_history.gpx"'},
    )
