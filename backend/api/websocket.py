import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from models.schemas import JoystickInput

router = APIRouter(tags=["websocket"])
logger = logging.getLogger(__name__)

# Active WebSocket connections
_connections: list[WebSocket] = []


async def broadcast(event_type: str, data: dict):
    """Broadcast event to all connected WebSocket clients."""
    message = json.dumps({"type": event_type, "data": data})
    dead = []
    for ws in _connections:
        try:
            await ws.send_text(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _connections.remove(ws)


@router.websocket("/ws/status")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    _connections.append(ws)
    logger.info("WebSocket client connected (%d total)", len(_connections))

    try:
        while True:
            text = await ws.receive_text()
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type", "")

            if msg_type == "joystick_input":
                data = msg.get("data", {})
                from main import app_state
                # Route per-udid if provided; otherwise fan out to all engines.
                udid = msg.get("udid") or data.get("udid")
                inp = JoystickInput(
                    direction=data.get("direction", 0),
                    intensity=data.get("intensity", 0),
                )
                if udid:
                    engine = app_state.get_engine(udid)
                    if engine:
                        engine.joystick_move(inp)
                else:
                    for engine in list(app_state.simulation_engines.values()):
                        engine.joystick_move(inp)

            elif msg_type == "joystick_stop":
                from main import app_state
                udid = msg.get("udid") or msg.get("data", {}).get("udid")
                if udid:
                    engine = app_state.get_engine(udid)
                    if engine:
                        await engine.joystick_stop()
                else:
                    for engine in list(app_state.simulation_engines.values()):
                        await engine.joystick_stop()

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("WebSocket error: %s", e)
    finally:
        if ws in _connections:
            _connections.remove(ws)
        logger.info("WebSocket client disconnected (%d remaining)", len(_connections))
