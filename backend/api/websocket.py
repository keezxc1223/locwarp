import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from models.schemas import (
    IncomingWsMessage,
    WsJoystickInput,
    WsJoystickStop,
    WsPong,
)

router = APIRouter(tags=["websocket"])
logger = logging.getLogger(__name__)

# Active WebSocket connections
_connections: list[WebSocket] = []

# Validates every inbound frame against the discriminated union once at the
# boundary. Built once at module import — TypeAdapter is safe to reuse.
_incoming_adapter: TypeAdapter[IncomingWsMessage] = TypeAdapter(IncomingWsMessage)


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

            # Parse + schema-validate at the boundary. Any malformed JSON,
            # unknown `type`, or out-of-range field is dropped with a debug
            # log instead of crashing the receive loop.
            try:
                raw = json.loads(text)
            except json.JSONDecodeError:
                logger.debug("Discarding non-JSON WS frame")
                continue

            try:
                msg = _incoming_adapter.validate_python(raw)
            except ValidationError as exc:
                # `errors()[:1]` keeps the log compact; full validation
                # detail can be re-enabled at DEBUG via exc_info=True.
                logger.warning(
                    "Rejecting WS message (type=%r): %s",
                    raw.get("type") if isinstance(raw, dict) else None,
                    exc.errors()[:1],
                )
                continue

            if isinstance(msg, WsPong):
                pass  # keepalive reply, nothing to do

            elif isinstance(msg, WsJoystickInput):
                from main import app_state
                engine = app_state.simulation_engine
                if engine:
                    engine.joystick_move(msg.data)

            elif isinstance(msg, WsJoystickStop):
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
