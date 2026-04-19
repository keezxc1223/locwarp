"""Schema validation smoke tests.

These tests cover the Pydantic models in models/schemas.py — they are pure
data classes with no I/O, so failures here mean a contract was broken
(e.g. someone accidentally widened a field or removed a constraint).

Special focus: the WS discriminated union added in Stage 2. The boundary
validation depends on Pydantic correctly dispatching by `type` literal —
if these tests pass we know the WebSocket receive loop will reject
malformed frames as designed.
"""
from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from models.schemas import (
    Coordinate,
    IncomingWsMessage,
    JoystickInput,
    LoopRequest,
    NavigateRequest,
    TeleportRequest,
    WifiConnectResponse,
    WifiTunnelStartConnectResponse,
    WsJoystickInput,
    WsJoystickStop,
    WsPong,
)

# ── Coordinate range validation ─────────────────────────────────────────────

class TestCoordinate:
    def test_valid_coordinate(self):
        c = Coordinate(lat=25.0375, lng=121.5637)
        assert c.lat == 25.0375
        assert c.lng == 121.5637

    @pytest.mark.parametrize("lat,lng", [
        (90.1, 0),       # lat > 90
        (-90.1, 0),      # lat < -90
        (0, 180.1),      # lng > 180
        (0, -180.1),     # lng < -180
    ])
    def test_out_of_range_rejected(self, lat, lng):
        with pytest.raises(ValidationError):
            Coordinate(lat=lat, lng=lng)


class TestTeleportRequest:
    def test_valid(self):
        req = TeleportRequest(lat=25.0, lng=121.0)
        assert req.lat == 25.0

    def test_lng_out_of_range(self):
        with pytest.raises(ValidationError):
            TeleportRequest(lat=0, lng=200)


class TestNavigateRequest:
    def test_default_mode_walking(self):
        req = NavigateRequest(lat=25.0, lng=121.0)
        assert req.mode.value == "walking"

    def test_speed_must_be_positive(self):
        with pytest.raises(ValidationError):
            NavigateRequest(lat=0, lng=0, speed_kmh=0)

    def test_speed_upper_bound(self):
        with pytest.raises(ValidationError):
            NavigateRequest(lat=0, lng=0, speed_kmh=400)


class TestLoopRequest:
    def test_requires_at_least_two_waypoints(self):
        with pytest.raises(ValidationError):
            LoopRequest(waypoints=[Coordinate(lat=25, lng=121)])

    def test_two_waypoints_ok(self):
        req = LoopRequest(waypoints=[
            Coordinate(lat=25, lng=121),
            Coordinate(lat=25.01, lng=121.01),
        ])
        assert len(req.waypoints) == 2


class TestJoystickInput:
    def test_valid(self):
        ji = JoystickInput(direction=180, intensity=0.5)
        assert ji.direction == 180

    @pytest.mark.parametrize("direction,intensity", [
        (-1, 0.5),       # direction < 0
        (361, 0.5),      # direction > 360
        (0, -0.1),       # intensity < 0
        (0, 1.1),        # intensity > 1
    ])
    def test_out_of_range_rejected(self, direction, intensity):
        with pytest.raises(ValidationError):
            JoystickInput(direction=direction, intensity=intensity)


# ── WebSocket discriminated union (Stage 2) ─────────────────────────────────
# The TypeAdapter approach used in api/websocket.py — these tests prove that
# the union dispatches correctly and rejects garbage at the boundary.

_ws_adapter: TypeAdapter[IncomingWsMessage] = TypeAdapter(IncomingWsMessage)


class TestWebSocketMessageUnion:
    def test_pong_dispatches_to_pong_class(self):
        msg = _ws_adapter.validate_python({"type": "pong"})
        assert isinstance(msg, WsPong)

    def test_joystick_input_dispatches_correctly(self):
        msg = _ws_adapter.validate_python({
            "type": "joystick_input",
            "data": {"direction": 90, "intensity": 0.8},
        })
        assert isinstance(msg, WsJoystickInput)
        assert msg.data.direction == 90
        assert msg.data.intensity == 0.8

    def test_joystick_stop_dispatches_correctly(self):
        msg = _ws_adapter.validate_python({"type": "joystick_stop"})
        assert isinstance(msg, WsJoystickStop)

    def test_unknown_type_rejected(self):
        with pytest.raises(ValidationError):
            _ws_adapter.validate_python({"type": "unknown_command"})

    def test_missing_type_rejected(self):
        with pytest.raises(ValidationError):
            _ws_adapter.validate_python({"data": {}})

    def test_joystick_input_with_invalid_data_rejected(self):
        # direction out of range → joystick_input variant should reject
        with pytest.raises(ValidationError):
            _ws_adapter.validate_python({
                "type": "joystick_input",
                "data": {"direction": 999, "intensity": 0.5},
            })

    def test_joystick_input_missing_data_rejected(self):
        with pytest.raises(ValidationError):
            _ws_adapter.validate_python({"type": "joystick_input"})


# ── WiFi response models (Stage 2) ──────────────────────────────────────────

class TestWifiResponses:
    def test_connect_response_defaults(self):
        # status is a Literal["connected"] — must be passed explicitly,
        # but Pydantic will reject any other value (contract enforcement).
        r = WifiConnectResponse(
            status="connected",
            udid="00008110-XXX", name="iPhone 15", ios_version="18.0",
        )
        assert r.status == "connected"
        assert r.connection_type == "Network"  # this one IS a default

    def test_connect_response_rejects_wrong_status(self):
        with pytest.raises(ValidationError):
            WifiConnectResponse(
                status="failed",  # not "connected" → rejected
                udid="X", name="Y", ios_version="Z",
            )

    def test_tunnel_start_response_includes_rsd(self):
        r = WifiTunnelStartConnectResponse(
            status="connected",
            udid="00008110-XXX", name="iPhone 15", ios_version="18.0",
            rsd_address="fd00::1", rsd_port=12345,
        )
        assert r.rsd_address == "fd00::1"
        assert r.rsd_port == 12345
        # Inherited fields still apply
        assert r.status == "connected"
