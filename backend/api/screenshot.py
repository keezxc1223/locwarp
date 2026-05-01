"""iOS screen mirror via WebSocket + ScreenshotService."""

import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()


def _screenshot_sync(lockdown) -> bytes:
    from pymobiledevice3.services.screenshot import ScreenshotService
    with ScreenshotService(lockdown) as svc:
        return svc.take_screenshot()


@router.websocket("/ws/device/{udid}/mirror")
async def mirror_ws(websocket: WebSocket, udid: str):
    await websocket.accept()

    from main import app_state
    dm = app_state.device_manager
    conn = dm._connections.get(udid)
    if not conn:
        await websocket.send_json({"error": "Device not connected"})
        await websocket.close()
        return

    # Build list of lockdown clients to try (usbmux first, then RSD)
    lockdowns = []
    usbmux_ld = getattr(conn, "usbmux_lockdown", None)
    if usbmux_ld:
        lockdowns.append(usbmux_ld)
    if conn.lockdown and conn.lockdown not in lockdowns:
        lockdowns.append(conn.lockdown)

    loop = asyncio.get_event_loop()
    working_ld = None

    # Find a lockdown that can take screenshots
    for ld in lockdowns:
        try:
            data = await loop.run_in_executor(None, _screenshot_sync, ld)
            if data:
                working_ld = ld
                await websocket.send_bytes(data)
                break
        except Exception as exc:
            await websocket.send_json({"error": f"截圖服務啟動失敗: {exc}"})

    if not working_ld:
        await websocket.close()
        return

    try:
        while True:
            try:
                data = await asyncio.wait_for(
                    loop.run_in_executor(None, _screenshot_sync, working_ld),
                    timeout=5.0,
                )
                await websocket.send_bytes(data)
            except asyncio.TimeoutError:
                await websocket.send_json({"error": "截圖逾時"})
                break
            except Exception as exc:
                await websocket.send_json({"error": str(exc)})
                break
            # ~5fps
            await asyncio.sleep(0.2)
    except (WebSocketDisconnect, Exception):
        pass
