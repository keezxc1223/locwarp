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
