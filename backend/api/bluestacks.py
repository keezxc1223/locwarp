"""
BlueStacks / Android Emulator API
提供 ADB 裝置列表、連線、斷線與 GPS 模擬功能。
"""

from __future__ import annotations

import asyncio
import logging
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/bluestacks", tags=["bluestacks"])
logger = logging.getLogger(__name__)


async def _run(*args: str) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return proc.returncode, out.decode().strip(), err.decode().strip()


async def _list_adb_devices() -> list[dict]:
    """列出所有 ADB 連線的 Android 裝置（含模擬器）。"""
    rc, out, _ = await _run("adb", "devices", "-l")
    if rc != 0:
        return []

    devices = []
    for line in out.splitlines()[1:]:  # 跳過 "List of devices attached"
        line = line.strip()
        if not line or "offline" in line:
            continue
        parts = line.split()
        if len(parts) < 2 or parts[1] != "device":
            continue
        serial = parts[0]

        # 取得裝置名稱
        name = "Android Device"
        model_match = re.search(r"model:(\S+)", line)
        if model_match:
            name = model_match.group(1).replace("_", " ")

        # 判斷是否為模擬器
        is_emulator = serial.startswith("emulator-") or re.match(r"\d+\.\d+\.\d+\.\d+:\d+", serial)

        devices.append({
            "serial": serial,
            "name": name,
            "type": "emulator" if is_emulator else "device",
        })
    return devices


class ConnectRequest(BaseModel):
    serial: str = "127.0.0.1:5555"


@router.get("/list")
async def list_devices():
    """列出所有 ADB 裝置（先嘗試連接預設 BlueStacks 位址）。"""
    # 自動嘗試連接 BlueStacks 預設位址
    for addr in ["127.0.0.1:5555", "127.0.0.1:5556", "127.0.0.1:5557"]:
        await _run("adb", "connect", addr)

    devices = await _list_adb_devices()
    return {"devices": devices}


@router.post("/connect")
async def connect_device(req: ConnectRequest):
    """連線到指定 ADB 裝置，建立 GPS 模擬引擎。"""
    from main import app_state
    from services.adb_location_service import AdbLocationService
    from api.websocket import broadcast

    # 嘗試 ADB 連線
    rc, out, err = await _run("adb", "connect", req.serial)
    if rc != 0 or ("error" in out.lower() and "connected" not in out.lower()):
        raise HTTPException(status_code=400, detail={
            "code": "adb_connect_failed",
            "message": f"無法連接 {req.serial}：{out or err}",
        })

    # 確認裝置存在
    devices = await _list_adb_devices()
    dev = next((d for d in devices if d["serial"] == req.serial), None)
    if dev is None:
        raise HTTPException(status_code=404, detail={
            "code": "device_not_found",
            "message": f"找不到裝置 {req.serial}",
        })

    # 建立 location service 並初始化 test provider
    loc_service = AdbLocationService(req.serial)
    try:
        await loc_service.connect()
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail={
            "code": "adb_init_failed",
            "message": str(e),
        })

    # 建立模擬引擎
    await app_state.create_engine_for_adb(req.serial, dev["name"], loc_service)

    await broadcast("device_reconnected", {
        "udid": req.serial,
        "name": dev["name"],
        "type": "bluestacks",
    })

    return {"status": "connected", "serial": req.serial, "name": dev["name"]}


@router.delete("/connect")
async def disconnect_device():
    """斷開 ADB 裝置連線，清除 GPS 模擬。"""
    from main import app_state
    from api.websocket import broadcast

    serial = getattr(app_state, "_adb_serial", None)
    engine = app_state.simulation_engine

    if engine is not None:
        try:
            await engine.restore()
        except Exception:
            pass

    app_state.simulation_engine = None
    app_state._adb_serial = None

    await broadcast("device_disconnected", {
        "udids": [serial] if serial else [],
        "reason": "user_disconnect",
    })
    return {"status": "disconnected"}


@router.get("/status")
async def device_status():
    """回傳目前連線中的 ADB 裝置資訊。"""
    from main import app_state
    serial = getattr(app_state, "_adb_serial", None)
    if not serial:
        return {"connected": False}
    return {"connected": True, "serial": serial}
