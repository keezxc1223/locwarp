from fastapi import APIRouter, HTTPException

from services.location_service import DeviceLostError

from models.schemas import (
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


async def _engine():
    """Return the active SimulationEngine, lazily rebuilding it when the
    device is reachable but the engine slot is empty. On the first attempt
    we just rebuild the engine; if that fails we force a full disconnect +
    reconnect + engine rebuild (covers the common iOS 17+ case where the
    RSD tunnel is alive but the DVT channel has silently gone stale)."""
    from main import app_state
    import logging as _logging
    _log = _logging.getLogger("locwarp")

    if app_state.simulation_engine is not None:
        return app_state.simulation_engine

    dm = app_state.device_manager

    # Pick a target UDID — already-connected first, then any discoverable device.
    # usbmuxd can transiently return an empty list right after device re-enum,
    # so retry up to 10× with 1s gap (matches GeoPort's get_devices_with_retry).
    target_udid = next(iter(dm._connections.keys()), None)
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

    app_state.simulation_engine = None

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


def _require_position(engine) -> None:
    """Raise HTTPException(400) if the engine has no current position.

    Movement modes (navigate, loop, multi-stop, random walk) require a
    starting position — either from a prior teleport or from the auto-set
    initial position on device connect. Without it the handler would raise
    a RuntimeError that gets silently swallowed inside _run_handler.
    """
    if engine.current_position is None:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "no_position",
                "message": "尚未取得目前位置,請先跳點到一個座標",
            },
        )


# ── Simulation modes ─────────────────────────────────────

@router.post("/teleport")
async def teleport(req: TeleportRequest):
    engine = await _engine()
    cooldown = _cooldown()

    # Enforce cooldown server-side: if enabled and currently active,
    # refuse the teleport so API clients cannot bypass the UI guard.
    if cooldown.enabled and cooldown.is_active and cooldown.remaining > 0:
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

    # Start cooldown if enabled and there was a previous position
    if old_pos and cooldown.enabled:
        await cooldown.start(old_pos.lat, old_pos.lng, req.lat, req.lng)

    return {"status": "ok", "lat": req.lat, "lng": req.lng}


@router.post("/navigate")
async def navigate(req: NavigateRequest):
    import asyncio
    engine = await _engine()
    _require_position(engine)
    asyncio.create_task(engine.navigate(
        Coordinate(lat=req.lat, lng=req.lng), req.mode,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
    ))
    return {"status": "started", "destination": {"lat": req.lat, "lng": req.lng}, "mode": req.mode}


@router.post("/loop")
async def loop(req: LoopRequest):
    import asyncio
    engine = await _engine()
    _require_position(engine)
    asyncio.create_task(engine.start_loop(
        req.waypoints, req.mode,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
        pause_enabled=req.pause_enabled, pause_min=req.pause_min, pause_max=req.pause_max,
    ))
    return {"status": "started", "waypoints": len(req.waypoints), "mode": req.mode}


@router.post("/multistop")
async def multi_stop(req: MultiStopRequest):
    import asyncio
    engine = await _engine()
    _require_position(engine)
    asyncio.create_task(engine.multi_stop(
        req.waypoints, req.mode, req.stop_duration, req.loop,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
        pause_enabled=req.pause_enabled, pause_min=req.pause_min, pause_max=req.pause_max,
    ))
    return {"status": "started", "stops": len(req.waypoints), "mode": req.mode}


@router.post("/randomwalk")
async def random_walk(req: RandomWalkRequest):
    import asyncio
    engine = await _engine()
    _require_position(engine)
    asyncio.create_task(engine.random_walk(
        req.center, req.radius_m, req.mode,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
        pause_enabled=req.pause_enabled, pause_min=req.pause_min, pause_max=req.pause_max,
    ))
    return {"status": "started", "radius_m": req.radius_m, "mode": req.mode}


@router.post("/joystick/start")
async def joystick_start(req: JoystickStartRequest):
    engine = await _engine()
    try:
        await engine.joystick_start(req.mode)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"status": "started", "mode": req.mode}


@router.post("/joystick/stop")
async def joystick_stop():
    engine = await _engine()
    await engine.joystick_stop()
    return {"status": "stopped"}


@router.post("/pause")
async def pause():
    engine = await _engine()
    await engine.pause()
    return {"status": "paused"}


@router.post("/resume")
async def resume():
    engine = await _engine()
    await engine.resume()
    return {"status": "resumed"}


@router.post("/restore")
async def restore():
    engine = await _engine()
    await engine.restore()
    return {"status": "restored"}


@router.delete("/simulation")
async def stop_simulation():
    engine = await _engine()
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
async def get_status():
    engine = await _engine()
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


# ── Home position (fixed startup location) ───────────────

@router.get("/settings/home-position", tags=["settings"])
async def get_home_position():
    """Return the manually pinned home (startup) position, or null if not set."""
    from main import app_state
    return {"home_position": app_state._home_position}


@router.put("/settings/home-position", tags=["settings"])
async def set_home_position(req: Coordinate):
    """Pin a fixed startup position. On next device connect this position is used first."""
    from main import app_state
    app_state._home_position = {"lat": req.lat, "lng": req.lng}
    app_state.save_settings()
    return {"status": "ok", "home_position": app_state._home_position}


@router.delete("/settings/home-position", tags=["settings"])
async def clear_home_position():
    """Clear the pinned home position (will fall back to last position or IP geolocation)."""
    from main import app_state
    app_state._home_position = None
    app_state.save_settings()
    return {"status": "cleared"}


# ── Startup / initial position ────────────────────────────

@router.get("/initial-position", tags=["settings"])
async def get_initial_position():
    """Return the best available initial position without requiring a device
    connection.  Priority: home_position > last_position > DEFAULT_LOCATION.

    Used by the frontend on first load so the map centers somewhere meaningful
    even before the device is connected.
    Note: does NOT perform async IP geolocation (use this for immediate UI
    feedback; the full async priority chain runs inside create_engine_for_device).
    """
    from main import app_state
    pos = app_state.get_initial_position()   # sync: home > last > DEFAULT
    return {"lat": pos["lat"], "lng": pos["lng"]}


# ── Scheduled Return (定時回家) ───────────────────────────

from pydantic import BaseModel, Field as _Field

class TimerRequest(BaseModel):
    seconds: int = _Field(gt=0, le=86400)


@router.post("/timer/start", tags=["timer"])
async def timer_start(req: TimerRequest):
    """啟動定時回家計時器。到期後自動停止模擬並跳回 home position。"""
    from main import app_state
    await app_state.scheduled_return.start(req.seconds)
    return {"status": "started", "seconds": req.seconds}


@router.delete("/timer/cancel", tags=["timer"])
async def timer_cancel():
    """取消定時回家計時器。"""
    from main import app_state
    app_state.scheduled_return.cancel()
    return {"status": "cancelled"}


@router.get("/timer/status", tags=["timer"])
async def timer_status():
    """取得定時回家計時器狀態。"""
    from main import app_state
    return app_state.scheduled_return.get_status()
