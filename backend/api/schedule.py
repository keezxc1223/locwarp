"""Schedule API — 排程跳點"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
router = APIRouter(prefix="/api/schedule", tags=["schedule"])

class ScheduleAddRequest(BaseModel):
    hour: int = Field(ge=0, le=23)
    minute: int = Field(ge=0, le=59)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    label: str = ""
    repeat_daily: bool = True

@router.get("")
async def list_schedule():
    from main import app_state
    return {"entries": app_state.schedule_service.list_entries()}

@router.post("")
async def add_schedule(req: ScheduleAddRequest):
    from main import app_state
    e = app_state.schedule_service.add(
        req.hour, req.minute, req.lat, req.lng, req.label, req.repeat_daily)
    return {"status": "added", "id": e.id}

@router.delete("/{entry_id}")
async def remove_schedule(entry_id: str):
    from main import app_state
    if not app_state.schedule_service.remove(entry_id):
        raise HTTPException(404, detail="entry not found")
    return {"status": "removed"}

@router.patch("/{entry_id}/toggle")
async def toggle_schedule(entry_id: str, enabled: bool = True):
    from main import app_state
    app_state.schedule_service.toggle(entry_id, enabled)
    return {"status": "updated"}

@router.delete("")
async def clear_schedule():
    from main import app_state
    app_state.schedule_service.clear()
    return {"status": "cleared"}
