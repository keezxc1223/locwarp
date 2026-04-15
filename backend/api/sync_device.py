"""
Multi-device GPS sync API
GET  /api/device/sync       — list sync group
POST /api/device/sync       — add a device to the sync group
DELETE /api/device/sync/{udid} — remove a device from the sync group
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/device/sync", tags=["sync"])


class AddSyncDeviceRequest(BaseModel):
    udid: str


@router.get("")
async def list_sync_devices():
    """Return all devices in the GPS sync group."""
    from main import app_state
    ml = app_state._multi_loc
    devices = []
    for udid in ml.all_udids:
        devices.append({
            "udid": udid,
            "name": app_state._sync_device_names.get(udid, udid),
            "is_primary": udid == ml.primary_udid,
        })
    return {"devices": devices, "total": ml.count}


@router.post("")
async def add_sync_device(req: AddSyncDeviceRequest):
    """Connect a secondary iOS device and add it to the GPS sync group."""
    from main import app_state
    if req.udid == app_state._multi_loc.primary_udid:
        raise HTTPException(status_code=400, detail="Already the primary device")
    try:
        await app_state.add_sync_device(req.udid)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {
        "status": "added",
        "udid": req.udid,
        "name": app_state._sync_device_names.get(req.udid, req.udid),
        "total": app_state._multi_loc.count,
    }


@router.delete("/{udid}")
async def remove_sync_device(udid: str):
    """Remove a secondary device from the GPS sync group."""
    from main import app_state
    if udid == app_state._multi_loc.primary_udid:
        raise HTTPException(status_code=400, detail="Cannot remove primary device from sync")
    app_state.remove_sync_device(udid)
    return {"status": "removed", "udid": udid, "total": app_state._multi_loc.count}
