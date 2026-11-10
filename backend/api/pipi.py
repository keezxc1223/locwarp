"""Pipi Mushroom 蘑菇地圖 overlay — proxies pipimushroom.com map data
using the cookie the user pasted from their own logged-in browser."""

import logging
import time
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from services.pipi_mushroom import PipiError, PipiMushroomClient, parse_cookie_header

router = APIRouter(prefix="/api/pipi", tags=["pipi"])
logger = logging.getLogger("locwarp")


class CookieBody(BaseModel):
    cookie: str = Field(max_length=16384)
    # "extension" = pushed by extensions/pipi-cookie-sync (Chrome extension).
    source: Literal["manual", "extension"] = "manual"


def _client():
    from main import app_state
    return app_state.pipi_client


def _require_local(request: Request) -> None:
    """The backend also listens on the LAN for phone control. The login
    cookie may only be set or cleared from this PC (the desktop window, or
    the Chrome extension, which posts to 127.0.0.1)."""
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=403, detail={"code": "pipi_local_only"})


def _http_error(e: PipiError) -> HTTPException:
    if e.code == "pipi_unavailable":
        logger.warning("Pipi Mushroom upstream error: %s", e.message)
    detail: dict = {"code": e.code}
    if e.retry_after is not None:
        detail["retry_after"] = round(e.retry_after)
    return HTTPException(status_code=e.status, detail=detail)


@router.get("/status")
async def status():
    """`updated_at` (epoch ms) lets the map layer notice a cookie pushed by
    the extension and resume loading without a manual refresh."""
    from main import app_state
    configured = _client().configured
    return {
        "configured": configured,
        "source": app_state._pipi_cookie_source if configured else None,
        "updated_at": app_state._pipi_cookie_updated_at if configured else None,
        # True / False once the site has answered with this cookie, None
        # before that. False means the login expired: the extension sends
        # a fresh cookie when it sees it, and the panel says so.
        "logged_in": _client().login_ok if configured else None,
    }


async def _verify(cookie: str) -> tuple[str | None, str]:
    """Check a cookie on a throwaway client. Returns (error code, or None
    when logged in; the Cookie header including any renewal the site sent
    during the check, which is what should be stored)."""
    candidate = PipiMushroomClient()
    candidate.set_cookie(cookie)
    try:
        await candidate.check_login()
        return None, candidate.cookie_header
    except PipiError as e:
        return e.code, candidate.cookie_header
    finally:
        await candidate.aclose()


@router.put("/cookie")
async def set_cookie(body: CookieBody, request: Request):
    """Verify the cookie with one authenticated call, then store it. The
    cookie itself is never echoed back.

    A manual paste always replaces the stored cookie (the user asked for
    it). An extension push only replaces it when it's logged in, or when the
    stored one is gone / no longer works: otherwise a Chrome profile that
    isn't logged in would silently overwrite a working cookie."""
    _require_local(request)
    from main import app_state
    # Validate before touching the client so a bad paste can't wipe a
    # working cookie.
    if not parse_cookie_header(body.cookie):
        raise HTTPException(status_code=400, detail={"code": "pipi_cookie_invalid"})
    client = _client()
    error, header = await _verify(body.cookie)
    if error is not None and body.source == "extension" and client.configured:
        if error != "pipi_login_required":
            # Couldn't verify (site down / rate limited): keep what we have,
            # the extension retries later.
            return {"configured": True, "logged_in": False, "error": error, "adopted": False}
        try:
            await client.check_login()
            return {"configured": True, "logged_in": False, "error": error, "adopted": False}
        except PipiError as e:
            if e.code != "pipi_login_required":
                return {"configured": True, "logged_in": False, "error": error, "adopted": False}
            # stored cookie is dead too; the new one is no worse
    client.set_cookie(header)
    # The check above was made with this very cookie.
    client.login_ok = error is None
    if error is None:
        client.last_ok_at = time.monotonic()
    app_state._pipi_cookie = header
    app_state._pipi_cookie_source = body.source
    app_state._pipi_cookie_updated_at = int(time.time() * 1000)
    app_state.save_settings()
    return {"configured": True, "logged_in": error is None, "error": error, "adopted": True}


@router.delete("/cookie")
async def clear_cookie(request: Request):
    _require_local(request)
    from main import app_state
    _client().set_cookie("")
    app_state._pipi_cookie = ""
    app_state._pipi_cookie_source = None
    app_state._pipi_cookie_updated_at = None
    app_state.save_settings()
    return {"configured": False}


@router.get("/items")
async def items(
    north: float = Query(ge=-90, le=90),
    south: float = Query(ge=-90, le=90),
    east: float = Query(ge=-180, le=180),
    west: float = Query(ge=-180, le=180),
    zoom: int = Query(ge=0, le=22),
):
    if north <= south or east <= west:
        raise HTTPException(status_code=400, detail={"code": "pipi_bad_bounds"})
    try:
        return await _client().items(north, south, east, west, zoom)
    except PipiError as e:
        raise _http_error(e) from e
