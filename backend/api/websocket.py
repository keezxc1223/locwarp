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

    async def _ping_loop():
        """Send a ping every 20s to keep connection alive through NAT/VPN idle timeouts."""
        while True:
            await asyncio.sleep(20)
            try:
                await ws.send_text(json.dumps({"type": "ping"}))
            except Exception:
                break

    ping_task = asyncio.create_task(_ping_loop())

    try:
        while True:
            text = await ws.receive_text()
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type", "")

            if msg_type == "pong":
                pass  # keep-alive reply from client, nothing to do

            elif msg_type == "joystick_input":
                data = msg.get("data", {})
                from main import app_state
                engine = app_state.simulation_engine
                if engine:
                    inp = JoystickInput(
                        direction=data.get("direction", 0),
                        intensity=data.get("intensity", 0),
                    )
                    engine.joystick_move(inp)

            elif msg_type == "joystick_stop":
                from main import app_state
                engine = app_state.simulation_engine
                if engine:
                    await engine.joystick_stop()

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("WebSocket error: %s", e)
    finally:
        ping_task.cancel()
        if ws in _connections:
            _connections.remove(ws)
        logger.info("WebSocket client disconnected (%d remaining)", len(_connections))
