"""Phone-control web UI: lets a phone on the same WiFi reach a small
mobile-friendly page hosted by LocWarp and operate the primary device.

Auth model:
  * Backend generates a 32-hex `token` and a 6-digit `pin` at startup
    (and on every `/rotate` call).
  * Phone opens `http://<lan-ip>:<port>/phone`, types the PIN, and the
    page POSTs the PIN to `/api/phone/auth` to receive the token in
    JSON. The token is stored in localStorage for subsequent reloads.
  * Every action endpoint requires the token via `X-LocWarp-Token`
    header or `?t=` query param.
  * `/api/phone/info` and `/api/phone/rotate` are localhost-only so the
    desktop UI can fetch the URL / PIN without exposing them to LAN.

Earlier revisions also offered a QR-based pairing path that embedded the
token in the URL fragment, but that was removed because anyone with a
camera who glimpsed the screen could pair without typing the PIN. PIN
entry is now the only pairing path.
"""

from __future__ import annotations

import logging
import secrets
import socket
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Header
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

logger = logging.getLogger("locwarp.phone")

router = APIRouter(tags=["phone"])


# ── Auth state ───────────────────────────────────────────────


class _PhoneAuth:
    def __init__(self) -> None:
        self.token: str = secrets.token_hex(16)  # 32 hex chars
        self.pin: str = f"{secrets.randbelow(1_000_000):06d}"
        self.created_at: float = time.monotonic()

    def rotate(self) -> None:
        self.token = secrets.token_hex(16)
        self.pin = f"{secrets.randbelow(1_000_000):06d}"
        self.created_at = time.monotonic()


_auth = _PhoneAuth()


def _check_token(token: str | None) -> None:
    if not token or not secrets.compare_digest(token, _auth.token):
        raise HTTPException(status_code=401, detail={"code": "phone_auth_required",
                                                     "message": "Invalid or missing token"})


def _resolve_token(request: Request, header_token: str | None, query_token: str | None) -> str | None:
    """Pick the token from header / query — header wins to keep a clean URL bar."""
    return header_token or query_token


def _is_localhost(request: Request) -> bool:
    host = (request.client.host if request.client else "") or ""
    # IPv4 loopback or IPv6 loopback
    return host in ("127.0.0.1", "::1", "localhost")


# ── Phone reachability tracking ──────────────────────────────


_last_phone_hit_ts: float = 0.0


def _record_phone_hit() -> None:
    """Called from /phone and /api/phone/_reach when the request comes
    from a non-loopback client. Used by the desktop UI to confirm a
    phone successfully reached the LAN URL — distinguishes 'wrong IP /
    firewall blocked' from 'phone arrived but PIN typo'."""
    global _last_phone_hit_ts
    _last_phone_hit_ts = time.monotonic()


def _last_phone_hit_seconds_ago() -> float | None:
    if _last_phone_hit_ts <= 0:
        return None
    return max(0.0, time.monotonic() - _last_phone_hit_ts)


# ── Windows Firewall helpers ─────────────────────────────────


_RULE_NAME = "LocWarp Phone Control"
# Names Windows Defender auto-assigns to Block rules when the user clicks
# "Cancel" on the first-bind dialog. These rules are program-bound (no
# localport filter) so the port-scoped Block sweep below won't catch them
# — we delete them by name instead. backend exe is built by PyInstaller as
# `locwarp-backend.exe`; frontend is the Electron `LocWarp.exe`.
_AUTO_BLOCK_NAMES = ("locwarp-backend", "LocWarp")


def _firewall_add_rule(port: int) -> tuple[bool, str]:
    """Add an inbound TCP allow rule for `port`. Before adding, sweeps
    away any pre-existing Block rules that would shadow the Allow:

      * Block rules on the same TCP port (any name)
      * Defender-auto Block rules named after the LocWarp executables
        (created when the user clicks Cancel on the first-bind dialog
         — these are program-bound with no localport, and Block always
         wins over Allow on the same profile)

    Then dedupes: if our Allow rule already exists, returns success
    instead of appending an identical row (older versions accumulated
    one extra row per button click).

    Requires LocWarp to be running elevated; the installer requests
    admin via the `requireAdministrator` manifest so the bundled exe
    normally has it."""
    import platform
    if platform.system() != "Windows":
        return False, "Windows-only"
    import subprocess
    netsh_kwargs = {
        "capture_output": True,
        "text": True,
        "timeout": 4.0,
        "creationflags": 0x08000000,  # CREATE_NO_WINDOW
    }

    # 1) Sweep Block rules scoped to our TCP port (any name).
    try:
        subprocess.run(
            ["netsh", "advfirewall", "firewall", "delete", "rule",
             "name=all", "dir=in", "action=block",
             "protocol=TCP", f"localport={port}"],
            **netsh_kwargs,
        )
    except Exception:
        logger.debug("port-scoped block sweep failed", exc_info=True)

    # 2) Sweep Defender-auto Block rules by program name (no port filter
    #    because those rules are program-bound, not port-bound).
    for auto_name in _AUTO_BLOCK_NAMES:
        try:
            subprocess.run(
                ["netsh", "advfirewall", "firewall", "delete", "rule",
                 f"name={auto_name}", "dir=in", "action=block"],
                **netsh_kwargs,
            )
        except Exception:
            logger.debug("auto-name block sweep failed for %s", auto_name, exc_info=True)

    # 3) Skip add if our Allow rule already exists.
    try:
        proc = subprocess.run(
            ["netsh", "advfirewall", "firewall", "show", "rule",
             f"name={_RULE_NAME}"],
            **netsh_kwargs,
        )
        if proc.returncode == 0 and _RULE_NAME in (proc.stdout or ""):
            return True, "rule already exists"
    except Exception:
        logger.debug("existing-rule check failed", exc_info=True)

    # 4) Add the Allow rule.
    try:
        proc = subprocess.run(
            [
                "netsh", "advfirewall", "firewall", "add", "rule",
                f"name={_RULE_NAME}",
                "dir=in", "action=allow",
                "protocol=TCP", f"localport={port}",
                "profile=private,public",
            ],
            **netsh_kwargs,
        )
        if proc.returncode == 0:
            return True, "rule added"
        msg = (proc.stderr or proc.stdout or "").strip()
        if "需要" in msg or "elevated" in msg.lower() or "admin" in msg.lower():
            return False, "需以系統管理員身分執行 LocWarp"
        return False, msg or f"netsh exit code {proc.returncode}"
    except Exception as e:
        logger.exception("firewall add rule failed")
        return False, str(e)


# ── LAN discovery ────────────────────────────────────────────


def _primary_route_ip() -> str | None:
    """The IPv4 the OS actually uses to reach the internet. UDP-connect
    trick: kernel fills the source address without sending a packet."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0.5)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            return ip if ip and not ip.startswith("127.") else None
    except Exception:
        logger.debug("UDP-connect IP probe failed", exc_info=True)
        return None


# Interface-name patterns commonly used by virtual / VPN adapters that
# *can't* be reached by a phone on the user's WiFi. Filtered out from
# the dropdown so users don't pick e.g. the Hyper-V vEthernet IP. Kept
# as substrings (case-insensitive) — exact names vary per OS locale.
_VIRTUAL_NIC_PATTERNS = (
    "veth",          # Hyper-V vEthernet
    "vmware",
    "virtualbox",
    "vbox",
    "tailscale",
    "wireguard",
    "openvpn",
    "tap-windows",
    "tap-",
    "wsl",
    "docker",
    "loopback pseudo",
    "bluetooth",
    "isatap",
    "teredo",
    "miniport",
    "vethernet",
)


def _classify_iface(name: str, ip: str) -> str:
    """Return a short label: 'wifi', 'ethernet', 'virtual', or 'other'.
    Used by the desktop UI to colour-code the NIC dropdown so users
    know which IP their phone can actually reach."""
    n = (name or "").lower()
    if any(p in n for p in _VIRTUAL_NIC_PATTERNS):
        return "virtual"
    # APIPA / link-local — host couldn't get DHCP, phone won't be on it.
    if ip.startswith("169.254."):
        return "virtual"
    # Carrier-grade NAT range used by Tailscale.
    if ip.startswith("100.") and 64 <= int(ip.split(".")[1]) <= 127:
        return "virtual"
    if "wi-fi" in n or "wifi" in n or "wlan" in n or "wireless" in n:
        return "wifi"
    if "ethernet" in n or "eth" in n or "lan" in n:
        return "ethernet"
    return "other"


def _is_rfc1918(ip: str) -> bool:
    """Standard private-use IPv4 ranges. Phones on the same WiFi will
    have their own RFC1918 IP, so candidate networks must match."""
    try:
        a, b, *_ = (int(p) for p in ip.split("."))
    except (ValueError, IndexError):
        return False
    if a == 10:
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    if a == 192 and b == 168:
        return True
    return False


def _enumerate_nics() -> list[dict]:
    """Walk every up + non-loopback NIC and return its IPv4(s) labelled.
    Falls back to the legacy gethostbyname_ex path if psutil isn't
    available (e.g. dev environment without the package installed)."""
    nics: list[dict] = []

    primary = _primary_route_ip()

    try:
        import psutil  # type: ignore[import-not-found]
    except ImportError:
        # Fallback: just the route + hostname lookups, unlabelled.
        seen: set[str] = set()
        if primary:
            seen.add(primary)
            nics.append({"ip": primary, "iface": "", "kind": "wifi", "primary": True})
        try:
            host = socket.gethostname()
            _, _, addrs = socket.gethostbyname_ex(host)
            for a in addrs:
                if a in seen or a.startswith("127."):
                    continue
                seen.add(a)
                nics.append({"ip": a, "iface": "", "kind": "other", "primary": False})
        except Exception:
            logger.debug("gethostbyname_ex fallback failed", exc_info=True)
        return nics

    try:
        addrs = psutil.net_if_addrs()
        stats = psutil.net_if_stats()
    except Exception:
        logger.exception("psutil NIC enumeration failed")
        return nics

    for iface_name, addr_list in addrs.items():
        st = stats.get(iface_name)
        if st is not None and not st.isup:
            continue
        for a in addr_list:
            if a.family != socket.AF_INET:
                continue
            ip = a.address
            if not ip or ip.startswith("127."):
                continue
            kind = _classify_iface(iface_name, ip)
            nics.append({
                "ip": ip,
                "iface": iface_name,
                "kind": kind,
                "primary": ip == primary,
            })

    # Sort: primary route first, then physical (wifi/ethernet), then
    # other, then virtual (most users want the first item in the list).
    kind_order = {"wifi": 0, "ethernet": 1, "other": 2, "virtual": 3}
    nics.sort(key=lambda n: (
        0 if n["primary"] else 1,
        kind_order.get(n["kind"], 99),
        n["ip"],
    ))
    return nics


def _lan_ipv4_candidates() -> list[str]:
    """Backward-compat wrapper used elsewhere in the file. Returns just
    the IPv4 list, with virtual NICs filtered out."""
    return [n["ip"] for n in _enumerate_nics() if n["kind"] != "virtual"]


# ── Models ───────────────────────────────────────────────────


class _AuthRequest(BaseModel):
    pin: str = Field(min_length=6, max_length=6)


class _TeleportBody(BaseModel):
    lat: float = Field(ge=-90.0, le=90.0)
    lng: float = Field(ge=-180.0, le=180.0)


class _NavigateBody(BaseModel):
    lat: float = Field(ge=-90.0, le=90.0)
    lng: float = Field(ge=-180.0, le=180.0)
    mode: str = "walking"  # walking / running / driving
    # Optional: explicit speed in km/h, overrides the mode preset.
    speed_kmh: float | None = Field(default=None, ge=0.1, le=300.0)


# ── Pairing endpoints (localhost-only or PIN-gated) ──────────


@router.get("/api/phone/info")
async def phone_info(request: Request):
    """Desktop-only: returns LAN IPs, port, PIN, and last-seen phone-
    page hit timestamp so the UI can show "phone reached the URL N
    seconds ago" and diagnose why a phone can't connect (wrong IP vs.
    firewall blocked vs. PIN typo) without the user having to check
    anything themselves."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Localhost only")
    from config import API_PORT
    nics = _enumerate_nics()
    return {
        "port": API_PORT,
        "lan_ips": [n["ip"] for n in nics if n["kind"] != "virtual"],
        "nics": nics,
        "pin": _auth.pin,
        "last_phone_hit_ago_s": _last_phone_hit_seconds_ago(),
    }


@router.post("/api/phone/firewall_repair")
async def phone_firewall_repair(request: Request):
    """Desktop-only: add a Windows Firewall inbound TCP rule for API_PORT
    so the phone can reach the LAN URL. Requires LocWarp to be running
    elevated (the NSIS installer asks for admin, so the bundled exe
    already has it)."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Localhost only")
    from config import API_PORT
    ok, msg = _firewall_add_rule(API_PORT)
    return {"ok": ok, "message": msg}


@router.post("/api/phone/rotate")
async def phone_rotate(request: Request):
    """Desktop-only: regenerates PIN + token, invalidating any previously
    paired phone. Use after suspecting compromise or just to refresh."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Localhost only")
    _auth.rotate()
    logger.info("Phone-control auth rotated")
    return {"status": "ok"}


@router.post("/api/phone/auth")
async def phone_auth(req: _AuthRequest):
    """PIN-only flow: phone POSTs the PIN it sees on the desktop screen
    and gets the token back. PIN comparison is constant-time."""
    if not secrets.compare_digest(req.pin, _auth.pin):
        raise HTTPException(status_code=401, detail={"code": "bad_pin", "message": "Invalid PIN"})
    return {"token": _auth.token}


# ── Phone-side action endpoints (token required) ─────────────


def _engine():
    """Return the primary simulation engine, or 503 if no device.
    We deliberately avoid the heavyweight rebuild path used by
    api/location.py so phone callers always get a fast, predictable
    answer (the desktop UI is responsible for re-pairing devices)."""
    from main import app_state
    eng = app_state.simulation_engine
    if eng is None:
        raise HTTPException(status_code=503, detail={"code": "no_device",
                                                     "message": "尚未連接 iOS 裝置"})
    return eng


def _all_engines():
    """Return every connected simulation engine. Used so phone-control
    actions fan out to both devices in dual-device group mode (matching
    the desktop UI's behaviour). Falls back to just the primary when
    only one device is connected."""
    from main import app_state
    if not app_state.simulation_engines:
        raise HTTPException(status_code=503, detail={"code": "no_device",
                                                     "message": "尚未連接 iOS 裝置"})
    return list(app_state.simulation_engines.values())


async def _fanout(action_name: str, fn):
    """Run `fn(engine)` on every connected engine concurrently. Logs
    per-engine failures but doesn't bubble them up unless every engine
    failed — that way unplugging one device mid-action still lets the
    other device complete the action."""
    import asyncio
    engines = _all_engines()
    results = await asyncio.gather(
        *[fn(e) for e in engines], return_exceptions=True
    )
    fails = [r for r in results if isinstance(r, Exception)]
    if fails and len(fails) == len(results):
        # Every engine failed — surface the first error so the phone
        # gets a meaningful message instead of a silent success.
        first = fails[0]
        if isinstance(first, HTTPException):
            raise first
        logger.exception("phone %s failed on every engine", action_name, exc_info=first)
        raise HTTPException(status_code=500, detail=str(first))
    if fails:
        logger.warning("phone %s: %d/%d engines failed", action_name, len(fails), len(results))


@router.get("/api/phone/status")
async def phone_status(
    request: Request,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    """Per-device status snapshot. The phone UI renders one pill per
    entry in `devices`, each showing its own name + sim state, so
    group-mode users see all connected iPhones at once. The top-level
    `state` / `current_position` / `route_path` still mirror the
    primary engine for the map view (single marker, single polyline)."""
    _check_token(_resolve_token(request, x_locwarp_token, t))
    from main import app_state
    dm = app_state.device_manager
    devices_info = []
    try:
        for udid, conn in dm._connections.items():
            entry = {
                "udid": udid,
                "name": getattr(conn, "name", "") or "",
                "connection_type": getattr(conn, "connection_type", "USB"),
                "state": "disconnected",
                "is_primary": udid == app_state._primary_udid,
            }
            dev_eng = app_state.simulation_engines.get(udid)
            if dev_eng is not None:
                try:
                    ds = dev_eng.get_status()
                    entry["state"] = ds.state.value if ds.state else "idle"
                except Exception:
                    logger.debug("status: per-device get_status failed for %s", udid, exc_info=True)
            devices_info.append(entry)
    except Exception:
        logger.debug("status: device enumeration failed", exc_info=True)

    eng = app_state.simulation_engine
    if eng is None:
        return {
            "connected": False,
            "devices": devices_info,
            "state": "disconnected",
            "current_position": None,
            "route_path": None,
        }
    s = eng.get_status()
    pos = None
    if s.current_position is not None:
        pos = {"lat": s.current_position.lat, "lng": s.current_position.lng}
    route_path = getattr(eng, "_last_route_path", None)
    return {
        "connected": True,
        "devices": devices_info,
        "state": s.state.value if s.state else "idle",
        "current_position": pos,
        "route_path": route_path,
    }


@router.post("/api/phone/teleport")
async def phone_teleport(
    body: _TeleportBody,
    request: Request,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    """Teleport every connected device to the same coordinate. In single
    device mode this is just one engine; in dual-device group mode both
    iPhones move together, matching the desktop UI's behaviour."""
    _check_token(_resolve_token(request, x_locwarp_token, t))
    await _fanout("teleport", lambda e: e.teleport(body.lat, body.lng))
    return {"status": "ok", "lat": body.lat, "lng": body.lng}


@router.post("/api/phone/stop")
async def phone_stop(
    request: Request,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    _check_token(_resolve_token(request, x_locwarp_token, t))
    await _fanout("stop", lambda e: e.stop())
    return {"status": "stopped"}


@router.post("/api/phone/restore")
async def phone_restore(
    request: Request,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    _check_token(_resolve_token(request, x_locwarp_token, t))
    await _fanout("restore", lambda e: e.restore())
    return {"status": "restored"}


@router.post("/api/phone/navigate")
async def phone_navigate(
    body: _NavigateBody,
    request: Request,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    """Navigate (walk / drive) from each device's current virtual position
    to the given coordinate. Fans out across every connected engine in
    group mode so all up-to-3 iPhones move together. Refuses with 400
    if no engine has a virtual origin — without one the sim would
    silently no-op, which the phone UI used to mistake for a successful
    start."""
    _check_token(_resolve_token(request, x_locwarp_token, t))
    engines = _all_engines()
    # Require at least one engine with a current position. Otherwise
    # the navigate call falls through to a no-op on every engine.
    if all(e.current_position is None for e in engines):
        raise HTTPException(status_code=400, detail={
            "code": "no_position",
            "message": "尚未有虛擬位置,請先瞬移或飛座標",
        })
    from models.schemas import Coordinate, MovementMode
    try:
        mode = MovementMode(body.mode)
    except ValueError:
        mode = MovementMode.WALKING
    import asyncio
    dest = Coordinate(lat=body.lat, lng=body.lng)
    # navigate is fire-and-forget on each engine — the engines run
    # their sims independently. We don't gather() because navigate's
    # internal _run_handler keeps running for the lifetime of the
    # walk; awaiting it would block the HTTP response until each
    # device arrives.
    for e in engines:
        if e.current_position is None:
            continue
        asyncio.create_task(e.navigate(dest, mode, speed_kmh=body.speed_kmh))
    return {
        "status": "started",
        "destination": {"lat": body.lat, "lng": body.lng},
        "mode": mode.value,
        "speed_kmh": body.speed_kmh,
    }


@router.get("/api/phone/geocode")
async def phone_geocode(
    request: Request,
    q: str,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    """Forward geocode via the existing GeocodingService (Nominatim).
    Returned as a list of {display_name, short_name, lat, lng,
    country_code} so the phone can render a results list."""
    _check_token(_resolve_token(request, x_locwarp_token, t))
    from services.geocoding import GeocodingService
    svc = GeocodingService()
    try:
        results = await svc.search(q, limit=8, provider="nominatim", google_key=None)
    except Exception as e:
        logger.exception("phone geocode failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    return [
        {
            "display_name": r.display_name,
            "short_name": r.short_name or r.display_name,
            "lat": r.lat,
            "lng": r.lng,
            "country_code": r.country_code,
        }
        for r in results
    ]


# ── Mobile page ──────────────────────────────────────────────


def _phone_page_path() -> Path:
    """Resolve phone.html in both dev (./backend/static/phone.html) and
    PyInstaller-packaged (sys._MEIPASS/static/phone.html) layouts."""
    import sys
    candidates: list[Path] = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / "static" / "phone.html")
    candidates.append(Path(__file__).resolve().parent.parent / "static" / "phone.html")
    for c in candidates:
        if c.exists():
            return c
    return candidates[-1]


@router.get("/phone", response_class=HTMLResponse)
async def phone_page(request: Request):
    """Serve the embedded mobile control page. Token is read by the
    page JS from `window.location.hash` (#t=...) so the server never
    sees it in transit. Every non-loopback hit on this route is
    recorded so the desktop UI can show "phone reached the URL N
    seconds ago" and confirm pairing actually worked end-to-end."""
    if not _is_localhost(request):
        _record_phone_hit()
    path = _phone_page_path()
    try:
        return HTMLResponse(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        logger.error("phone.html missing at %s", path)
        raise HTTPException(status_code=500, detail="phone.html missing")


@router.get("/api/phone/_reach")
async def phone_reach_check(request: Request):
    """Unauthenticated reachability ping. Phone loads /phone, the page
    JS hits this on load, and the desktop UI polls /api/phone/info to
    see the timestamp. No secrets exposed — just used to confirm the
    LAN path between phone and PC actually works."""
    if not _is_localhost(request):
        _record_phone_hit()
    return {"ok": True}
