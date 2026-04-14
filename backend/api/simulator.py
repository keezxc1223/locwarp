"""
iOS Simulator API
提供模擬器列表、連線、斷線功能，透過 xcrun simctl 控制 GPS。
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/simulator", tags=["simulator"])
logger = logging.getLogger(__name__)


async def _simctl(*args: str) -> tuple[int, str, str]:
    """Run `xcrun simctl <args>` and return (returncode, stdout, stderr)."""
    proc = await asyncio.create_subprocess_exec(
        "xcrun", "simctl", *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return proc.returncode, out.decode(), err.decode()


async def _list_simulators() -> list[dict]:
    """Return all available iOS simulators."""
    rc, out, _ = await _simctl("list", "devices", "available", "--json")
    if rc != 0:
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return []

    simulators = []
    for runtime, devices in data.get("devices", {}).items():
        if "iOS" not in runtime:
            continue
        # runtime string: com.apple.CoreSimulator.SimRuntime.iOS-18-0
        version = runtime.split("iOS-")[-1].replace("-", ".") if "iOS-" in runtime else runtime
        for d in devices:
            if not d.get("isAvailable", False):
                continue
            simulators.append({
                "udid": d["udid"],
                "name": d["name"],
                "state": d["state"],          # "Booted" | "Shutdown"
                "ios_version": version,
                "runtime": runtime,
            })
    return simulators


async def _boot_simulator(udid: str) -> None:
    """Boot simulator if not already booted."""
    rc, _, err = await _simctl("boot", udid)
    if rc != 0 and "Unable to boot device in current state: Booted" not in err:
        raise RuntimeError(f"simctl boot failed: {err.strip()}")


@router.get("/list")
async def list_simulators():
    """列出所有可用的 iOS 模擬器。"""
    sims = await _list_simulators()
    return {"simulators": sims}


@router.post("/{udid}/connect")
async def connect_simulator(udid: str):
    """連線到指定模擬器（自動開機），建立 SimulationEngine。"""
    from main import app_state
    from services.location_service import SimulatorLocationService
    from api.websocket import broadcast

    # 確認 UDID 存在
    sims = await _list_simulators()
    sim = next((s for s in sims if s["udid"] == udid), None)
    if sim is None:
        raise HTTPException(status_code=404, detail={"code": "sim_not_found",
                                                     "message": f"找不到模擬器 {udid}"})

    # 開機
    if sim["state"] != "Booted":
        logger.info("Booting simulator %s (%s)…", sim["name"], udid)
        try:
            await _boot_simulator(udid)
        except RuntimeError as e:
            raise HTTPException(status_code=500, detail={"code": "sim_boot_failed",
                                                         "message": str(e)})
        # 等候模擬器完全啟動（最多 30 秒）
        for _ in range(30):
            await asyncio.sleep(1)
            rc, out, _ = await _simctl("list", "devices", "--json")
            if rc == 0:
                try:
                    data = json.loads(out)
                    for devs in data["devices"].values():
                        for d in devs:
                            if d["udid"] == udid and d["state"] == "Booted":
                                break
                        else:
                            continue
                        break
                    else:
                        continue
                    break
                except Exception:
                    pass
        else:
            raise HTTPException(status_code=504, detail={"code": "sim_boot_timeout",
                                                         "message": "模擬器開機逾時"})

    # 建立 SimulatorLocationService & SimulationEngine
    loc_service = SimulatorLocationService(udid)
    await app_state.create_engine_for_simulator(udid, sim["name"], loc_service)

    await broadcast("device_reconnected", {"udid": udid, "name": sim["name"],
                                           "type": "simulator"})

    return {"status": "connected", "udid": udid, "name": sim["name"],
            "ios_version": sim["ios_version"]}


@router.delete("/{udid}/connect")
async def disconnect_simulator(udid: str):
    """斷開模擬器連線，清除 GPS 模擬。"""
    from main import app_state
    from api.websocket import broadcast

    engine = app_state.simulation_engine
    if engine is not None:
        try:
            await engine.restore()
        except Exception:
            pass
    app_state.simulation_engine = None
    app_state._simulator_udid = None

    await broadcast("device_disconnected", {"udids": [udid], "reason": "user_disconnect"})
    return {"status": "disconnected"}


@router.get("/status")
async def simulator_status():
    """回傳目前連線中的模擬器資訊。"""
    from main import app_state
    udid = getattr(app_state, "_simulator_udid", None)
    if not udid:
        return {"connected": False}
    sims = await _list_simulators()
    sim = next((s for s in sims if s["udid"] == udid), None)
    return {"connected": True, "udid": udid, "simulator": sim}
