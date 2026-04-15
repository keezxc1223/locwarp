from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.location_service import DeviceLostError

from models.schemas import (
    MovementMode,
    TeleportRequest,
    NavigateRequest,
    LoopRequest,
    MultiStopRequest,
    RandomWalkRequest,
    JoystickStartRequest,
    SimulationStatus,
    Coordinate,
    CooldownSettings,
    CooldownStatus,
    CoordFormatRequest,
    CoordinateFormat,
)

router = APIRouter(prefix="/api/location", tags=["location"])


async def _engine(udid: str | None = None):
    """Return the active SimulationEngine for *udid* (or the primary one if
    unspecified), lazily rebuilding when the slot is empty. On the first
    attempt we just rebuild the engine; if that fails we force a full
    disconnect + reconnect + engine rebuild (covers the common iOS 17+ case
    where the RSD tunnel is alive but the DVT channel has silently gone stale)."""
    from main import app_state
    import logging as _logging
    _log = _logging.getLogger("locwarp")

    # Direct hit on the requested udid.
    if udid is not None:
        eng = app_state.get_engine(udid)
        if eng is not None:
            return eng

    if udid is None and app_state.simulation_engine is not None:
        return app_state.simulation_engine

    dm = app_state.device_manager

    # Pick a target UDID — requested udid first, then already-connected, then any discoverable device.
    target_udid = udid or next(iter(dm._connections.keys()), None)
    if target_udid is None:
        import asyncio as _asyncio
        for attempt in range(10):
            try:
                discovered = await dm.discover_devices()
                if discovered:
                    target_udid = discovered[0].udid
                    if attempt > 0:
                        _log.info("discover_devices returned device on attempt %d", attempt + 1)
                    break
            except Exception:
                _log.exception("discover_devices failed during lazy rebuild (attempt %d)", attempt + 1)
            await _asyncio.sleep(1.0)

    if target_udid is None:
        raise HTTPException(
            status_code=400,
            detail={"code": "no_device", "message": "尚未連接任何 iOS 裝置,請先透過 USB 連線"},
        )

    # Attempt 1: rebuild engine on top of existing connection
    _log.info("simulation_engine missing; attempt 1 (rebuild) for %s", target_udid)
    try:
        await app_state.create_engine_for_device(target_udid)
        if app_state.simulation_engine is not None:
            _log.info("Engine rebuild succeeded on attempt 1")
            return app_state.simulation_engine
    except Exception:
        _log.exception("Engine rebuild (attempt 1) failed for %s", target_udid)

    # Attempt 2: hard reset — disconnect + reconnect + rebuild
    _log.info("attempt 2 (hard reset) for %s", target_udid)
    try:
        try:
            await dm.disconnect(target_udid)
        except Exception:
            _log.warning("disconnect during hard reset failed; proceeding", exc_info=True)
        await dm.connect(target_udid)
        await app_state.create_engine_for_device(target_udid)
        if app_state.simulation_engine is not None:
            _log.info("Engine rebuild succeeded on attempt 2")
            return app_state.simulation_engine
    except Exception:
        _log.exception("Engine rebuild (attempt 2, hard reset) failed for %s", target_udid)

    raise HTTPException(
        status_code=400,
        detail={
            "code": "no_device",
            "message": "裝置連線已失效,請嘗試重新插拔 USB 或重新啟動 LocWarp(詳見 ~/.locwarp/logs/backend.log)",
        },
    )


async def _handle_device_lost(exc: Exception) -> "HTTPException":
    """Clean up after a DeviceLostError: disconnect the stale device from
    DeviceManager, drop the simulation engine, broadcast an explicit
    `device_disconnected` WebSocket event so the frontend can banner it.
    Returns an HTTPException the caller should raise."""
    from main import app_state
    from api.websocket import broadcast
    import logging as _logging
    _log = _logging.getLogger("locwarp")

    dm = app_state.device_manager
    lost_udids = list(dm._connections.keys())
    for udid in lost_udids:
        try:
            await dm.disconnect(udid)
            _log.info("device_lost cleanup: disconnected %s", udid)
        except Exception:
            _log.exception("device_lost cleanup: disconnect failed for %s", udid)
        # Only remove this udid's engine; the legacy `= None` setter clears
        # every engine (bad for dual mode).
        app_state.simulation_engines.pop(udid, None)
        if app_state._primary_udid == udid:
            remaining = next(iter(app_state.simulation_engines.keys()), None)
            app_state._primary_udid = remaining

    try:
        await broadcast("device_disconnected", {
            "udids": lost_udids,
            "reason": "device_lost",
            "error": str(exc),
        })
    except Exception:
        _log.exception("Failed to broadcast device_disconnected")

    return HTTPException(
        status_code=503,
        detail={
            "code": "device_lost",
            "message": "裝置連線中斷(USB 拔除或 Tunnel 死亡),請重新插上 USB 後再操作",
        },
    )


def _cooldown():
    from main import app_state
    return app_state.cooldown_timer


def _coord_fmt():
    from main import app_state
    return app_state.coord_formatter


# ── Simulation modes ─────────────────────────────────────

class ApplySpeedRequest(BaseModel):
    mode: MovementMode = MovementMode.WALKING
    speed_kmh: float | None = None
    speed_min_kmh: float | None = None
    speed_max_kmh: float | None = None
    udid: str | None = None


@router.post("/apply-speed")
async def apply_speed(req: ApplySpeedRequest):
    """Hot-swap the active navigation's speed profile. The current
    _move_along_route loop re-interpolates from the current position
    with the new speed; already-completed progress is kept."""
    from config import resolve_speed_profile
    engine = await _engine(getattr(req, "udid", None) if 'req' in dir() else None)
    profile = resolve_speed_profile(
        req.mode.value,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh,
        speed_max_kmh=req.speed_max_kmh,
    )
    swapped = engine.apply_speed(profile)
    if not swapped:
        raise HTTPException(
            status_code=400,
            detail={"code": "no_active_route",
                    "message": "目前沒有進行中的路線,無法套用新速度"},
        )
    return {"status": "applied", "speed_mps": profile["speed_mps"]}


@router.post("/teleport")
async def teleport(req: TeleportRequest):
    engine = await _engine(getattr(req, "udid", None) if 'req' in dir() else None)
    cooldown = _cooldown()

    # Group mode (2+ engines): bypass cooldown entirely. The UI also locks the
    # toggle off, but the saved cooldown_enabled value is preserved so single-
    # device mode restores the user's preference automatically.
    from main import app_state as _app_state
    dual_mode = len(_app_state.simulation_engines) >= 2

    # Enforce cooldown server-side: if enabled and currently active,
    # refuse the teleport so API clients cannot bypass the UI guard.
    if not dual_mode and cooldown.enabled and cooldown.is_active and cooldown.remaining > 0:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "cooldown_active",
                "message": f"冷卻中,還需等待 {int(cooldown.remaining)} 秒",
                "remaining_seconds": cooldown.remaining,
            },
        )

    old_pos = engine.current_position
    try:
        await engine.teleport(req.lat, req.lng)
    except HTTPException:
        raise
    except DeviceLostError as e:
        raise (await _handle_device_lost(e))
    except Exception as e:
        import traceback, logging
        logging.getLogger("locwarp").error("Teleport failed:\n%s", traceback.format_exc())
        # Also inspect the cause — nested DeviceLostError (e.g. re-raised from
        # the simulation engine retry loop) should still trigger cleanup.
        cause = e
        while cause is not None:
            if isinstance(cause, DeviceLostError):
                raise (await _handle_device_lost(cause))
            cause = cause.__cause__
        raise HTTPException(status_code=500, detail=str(e))

    # Start cooldown if enabled and there was a previous position.
    # Skipped in dual mode for the same reason the check above is skipped.
    if old_pos and cooldown.enabled and not dual_mode:
        await cooldown.start(old_pos.lat, old_pos.lng, req.lat, req.lng)

    return {"status": "ok", "lat": req.lat, "lng": req.lng}


# Module-level background task set to keep strong references to fire-and-forget
# tasks. Without this, asyncio only keeps weak refs and Python can GC a task
# mid-execution (documented asyncio footgun). Tasks self-remove on completion.
_bg_tasks: set = set()


def _spawn(coro):
    import asyncio
    task = asyncio.create_task(coro)
    _bg_tasks.add(task)

    def _on_done(t):
        _bg_tasks.discard(t)
        exc = t.exception()
        if exc is not None:
            import logging as _logging
            _logging.getLogger("locwarp").exception(
                "background task crashed: %s", exc, exc_info=exc
            )

    task.add_done_callback(_on_done)
    return task


@router.post("/navigate")
async def navigate(req: NavigateRequest):
    engine = await _engine(getattr(req, "udid", None) if 'req' in dir() else None)
    _spawn(engine.navigate(
        Coordinate(lat=req.lat, lng=req.lng), req.mode,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
        straight_line=req.straight_line,
    ))
    return {"status": "started", "destination": {"lat": req.lat, "lng": req.lng}, "mode": req.mode}


@router.post("/loop")
async def loop(req: LoopRequest):
    engine = await _engine(getattr(req, "udid", None) if 'req' in dir() else None)
    _spawn(engine.start_loop(
        req.waypoints, req.mode,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
        pause_enabled=req.pause_enabled, pause_min=req.pause_min, pause_max=req.pause_max,
        straight_line=req.straight_line,
    ))
    return {"status": "started", "waypoints": len(req.waypoints), "mode": req.mode}


@router.post("/multistop")
async def multi_stop(req: MultiStopRequest):
    engine = await _engine(getattr(req, "udid", None) if 'req' in dir() else None)
    _spawn(engine.multi_stop(
        req.waypoints, req.mode, req.stop_duration, req.loop,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
        pause_enabled=req.pause_enabled, pause_min=req.pause_min, pause_max=req.pause_max,
        straight_line=req.straight_line,
    ))
    return {"status": "started", "stops": len(req.waypoints), "mode": req.mode}


@router.post("/randomwalk")
async def random_walk(req: RandomWalkRequest):
    engine = await _engine(getattr(req, "udid", None) if 'req' in dir() else None)
    _spawn(engine.random_walk(
        req.center, req.radius_m, req.mode,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
        pause_enabled=req.pause_enabled, pause_min=req.pause_min, pause_max=req.pause_max,
        seed=req.seed,
        straight_line=req.straight_line,
    ))
    return {"status": "started", "radius_m": req.radius_m, "mode": req.mode}


@router.post("/joystick/start")
async def joystick_start(req: JoystickStartRequest):
    engine = await _engine(getattr(req, "udid", None) if 'req' in dir() else None)
    try:
        await engine.joystick_start(req.mode)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"status": "started", "mode": req.mode}


@router.post("/joystick/stop")
async def joystick_stop(udid: str | None = None):
    engine = await _engine(udid)
    await engine.joystick_stop()
    return {"status": "stopped"}


@router.post("/pause")
async def pause(udid: str | None = None):
    engine = await _engine(udid)
    await engine.pause()
    return {"status": "paused"}


@router.post("/resume")
async def resume(udid: str | None = None):
    engine = await _engine(udid)
    await engine.resume()
    return {"status": "resumed"}


@router.post("/restore")
async def restore(udid: str | None = None):
    engine = await _engine(udid)
    await engine.restore()
    return {"status": "restored"}


@router.post("/stop")
async def stop_movement(udid: str | None = None):
    """Stop active movement without clearing the simulated location.
    Keeps the device at its last reported position instead of restoring
    real GPS. restore() is a separate endpoint for that."""
    engine = await _engine(udid)
    await engine.stop()
    return {"status": "stopped"}


@router.delete("/simulation")
async def stop_simulation(udid: str | None = None):
    """Legacy endpoint: stop + restore. Kept for backwards compatibility,
    prefer /stop (movement only) or /restore (clear location)."""
    engine = await _engine(udid)
    await engine.restore()
    return {"status": "stopped"}


@router.get("/debug")
async def debug_info():
    """Debug endpoint to check engine and location service state."""
    from main import app_state
    engine = app_state.simulation_engine
    if engine is None:
        return {"engine": None}
    loc_svc = engine.location_service
    return {
        "engine": type(engine).__name__,
        "state": engine.state.value if engine.state else None,
        "current_position": {"lat": engine.current_position.lat, "lng": engine.current_position.lng} if engine.current_position else None,
        "location_service": type(loc_svc).__name__ if loc_svc else None,
        "location_service_active": getattr(loc_svc, '_active', None),
    }


@router.get("/status", response_model=SimulationStatus)
async def get_status(udid: str | None = None):
    engine = await _engine(udid)
    status = engine.get_status()
    cooldown = _cooldown()
    cs = cooldown.get_status()
    status.cooldown_remaining = cs["remaining_seconds"]
    return status


# ── Cooldown ──────────────────────────────────────────────

@router.get("/cooldown/status", response_model=CooldownStatus, tags=["cooldown"])
async def cooldown_status():
    cd = _cooldown()
    s = cd.get_status()
    return CooldownStatus(**s)


@router.put("/cooldown/settings", tags=["cooldown"])
async def cooldown_settings(req: CooldownSettings):
    cd = _cooldown()
    cd.enabled = req.enabled
    if not req.enabled:
        await cd.dismiss()
    return {"enabled": cd.enabled}


@router.post("/cooldown/dismiss", tags=["cooldown"])
async def cooldown_dismiss():
    cd = _cooldown()
    await cd.dismiss()
    return {"status": "dismissed"}


# ── Coordinate format ────────────────────────────────────

@router.get("/settings/coord-format", tags=["settings"])
async def get_coord_format():
    fmt = _coord_fmt()
    return {"format": fmt.format.value}


@router.put("/settings/coord-format", tags=["settings"])
async def set_coord_format(req: CoordFormatRequest):
    fmt = _coord_fmt()
    fmt.format = req.format
    return {"format": fmt.format.value}


# --- Initial map position (persisted in settings.json) ---

class _InitialPosRequest(BaseModel):
    lat: float | None = None
    lng: float | None = None


@router.get("/settings/initial-position", tags=["settings"])
async def get_initial_position():
    from main import app_state
    pos = app_state._initial_map_position
    return {"position": pos}  # {"position": null} or {"position": {"lat","lng"}}


@router.put("/settings/initial-position", tags=["settings"])
async def set_initial_position(req: _InitialPosRequest):
    """Pass `{lat: null, lng: null}` (or omit) to clear the custom initial
    map center and fall back to the default on next launch."""
    from main import app_state
    if req.lat is None or req.lng is None:
        app_state._initial_map_position = None
    else:
        if not (-90 <= req.lat <= 90) or not (-180 <= req.lng <= 180):
            raise HTTPException(
                status_code=400,
                detail={"code": "invalid_coord", "message": "lat must be in [-90, 90], lng in [-180, 180]"},
            )
        app_state._initial_map_position = {"lat": float(req.lat), "lng": float(req.lng)}
    app_state.save_settings()
    return {"position": app_state._initial_map_position}
