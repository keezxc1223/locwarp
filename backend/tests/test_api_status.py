"""API smoke tests — only the endpoints that don't require a real device.

We use FastAPI's TestClient to hit the actual app, which exercises the full
routing/middleware stack but uses HTTP-over-ASGI under the hood (no network).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client():
    """Single shared TestClient — module scope so we don't re-import main per test."""
    # Importing main has side effects (creates AppState, loads settings.json).
    # Acceptable here because: (1) tests are read-only on the API surface we
    # exercise, and (2) the alternative is mocking half the module.
    from main import app
    with TestClient(app) as c:
        yield c


class TestStatusEndpoint:
    def test_api_status_returns_running(self, client):
        r = client.get("/api/status")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "running"
        assert body["name"] == "LocWarp"
        assert "initial_position" in body
        assert "lat" in body["initial_position"]
        assert "lng" in body["initial_position"]


class TestRouterMounting:
    """Sanity check that all routers are mounted at the documented prefixes.

    A failure here means main.py forgot to include_router something, or a
    router's prefix changed and broke client URLs. We hit the OpenAPI schema
    rather than the endpoints themselves to avoid touching device state.
    """

    def test_openapi_includes_expected_paths(self, client):
        schema = client.get("/openapi.json").json()
        paths = set(schema["paths"].keys())

        # Spot-check one endpoint per router prefix.
        expected = {
            "/api/device/list",       # device router
            "/api/location/teleport", # location router
            "/api/route/plan",        # route router
            "/api/geocode/search",    # geocode router
            "/api/bookmarks",         # bookmarks router
            "/api/history",           # history router
            "/api/device/sync",       # sync_device router
        }
        missing = expected - paths
        assert not missing, f"Missing router paths in OpenAPI: {missing}"


class TestWebSocketHandshake:
    """Boundary-level WS test — confirms /ws/status accepts connections and
    that malformed frames don't kill the receive loop (Stage 2 invariant).
    """

    def test_ws_accepts_connection_and_handles_garbage(self, client):
        with client.websocket_connect("/ws/status") as ws:
            # Garbage JSON: should be silently dropped (logged), not crash.
            ws.send_text("not json at all")
            # Unknown type: discriminated-union rejects it
            ws.send_text('{"type": "definitely_not_a_real_event"}')
            # Now send a valid pong — server should still be alive.
            ws.send_text('{"type": "pong"}')
            # Server pings every 20s; we don't wait for one. Sending and not
            # crashing the server is the assertion. TestClient cleanup verifies
            # the WS closes cleanly.
