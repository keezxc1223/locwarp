"""Geofence API"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
router = APIRouter(prefix="/api/geofence", tags=["geofence"])

class GeofenceRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    radius_m: float = Field(gt=0, le=100_000, default=500)
    auto_return: bool = True

@router.put("")
async def set_geofence(req: GeofenceRequest):
    from main import app_state
    app_state.geofence.set(req.lat, req.lng, req.radius_m, req.auto_return)
    return {"status": "set", **app_state.geofence.get_status()}

@router.delete("")
async def clear_geofence():
    from main import app_state
    app_state.geofence.clear()
    return {"status": "cleared"}

@router.get("")
async def geofence_status():
    from main import app_state
    return app_state.geofence.get_status()
