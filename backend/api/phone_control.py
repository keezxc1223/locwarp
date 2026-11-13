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
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
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
    # netsh on TC Windows outputs UTF-8 (Chinese headers like "規則名稱:"),
    # but Python's text mode defaults to cp950 there and dies on the first
    # multi-byte char with UnicodeDecodeError in the stdout reader thread,
    # silently leaving proc.stdout = "". That made the dedupe check below
    # always say "rule not found" → every button click appended another
    # row. Force UTF-8 + replace so dedupe + error-message matching work
    # regardless of system locale.
    netsh_kwargs = {
        "capture_output": True,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
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
    # Optional label (bookmark / search-result name) for the recent list.
    name: str | None = Field(default=None, max_length=200)


class _NavigateBody(BaseModel):
    lat: float = Field(ge=-90.0, le=90.0)
    lng: float = Field(ge=-180.0, le=180.0)
    mode: str = "walking"  # walking / running / driving
    # Optional: explicit speed in km/h, overrides the mode preset.
    speed_kmh: float | None = Field(default=None, ge=0.1, le=300.0)
    name: str | None = Field(default=None, max_length=200)


class _SpeedBody(BaseModel):
    mode: str = "walking"  # walking / running / driving
    speed_kmh: float | None = Field(default=None, ge=0.1, le=300.0)


class _CoordFormatBody(BaseModel):
    datum: str = "wgs84"   # wgs84 / gcj02 / bd09
    order: str = "latlng"  # latlng / lnglat


# Coordinate text format chosen in the desktop UI (設定 > 座標格式). The
# desktop keeps it in its own localStorage, which the phone page cannot
# read, so the desktop pushes it here on launch and on every change and
# the phone picks it up from /api/phone/status. Coordinates on the wire
# are always WGS84 lat/lng; this only tells the phone page how to show
# and parse coordinate text.
_coord_format: dict[str, str] = {"datum": "wgs84", "order": "latlng"}


def _push_recent(lat: float, lng: float, kind: str, name: str | None) -> None:
    """Record a phone-initiated move in the shared recent list. Never
    lets a bookkeeping failure break the move itself."""
    try:
        from services.recent import get_manager
        get_manager().push(lat, lng, kind, name or None)  # type: ignore[arg-type]
    except Exception:
        logger.debug("phone: recent push failed", exc_info=True)


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


@router.post("/api/phone/coord_format")
async def phone_set_coord_format(body: _CoordFormatBody, request: Request):
    """Desktop-only: mirror the desktop's coordinate format setting so the
    phone page shows and parses coordinates the same way."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Localhost only")
    _coord_format["datum"] = body.datum if body.datum in ("wgs84", "gcj02", "bd09") else "wgs84"
    _coord_format["order"] = body.order if body.order in ("latlng", "lnglat") else "latlng"
    return dict(_coord_format)


class _AppearanceBody(BaseModel):
    accent_rgb: str = Field(max_length=20)  # "R, G, B"


# Theme accent chosen in the desktop UI (設定 > 外觀), mirrored the same
# way as the coordinate format so the phone page matches the desktop.
_DEFAULT_ACCENT = "108, 140, 255"
_appearance: dict[str, str] = {"accent_rgb": _DEFAULT_ACCENT}


def _clean_accent(raw: str) -> str:
    """Accept only three 0-255 integers; the value ends up inside a CSS
    custom property on the phone page."""
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 3 or not all(p.isdigit() and int(p) <= 255 for p in parts):
        return _DEFAULT_ACCENT
    return ", ".join(str(int(p)) for p in parts)


@router.post("/api/phone/appearance")
async def phone_set_appearance(body: _AppearanceBody, request: Request):
    """Desktop-only: mirror the desktop's theme accent colour."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Localhost only")
    _appearance["accent_rgb"] = _clean_accent(body.accent_rgb)
    return dict(_appearance)


class _MapLayerBody(BaseModel):
    key: str = Field(max_length=32)


# Base map chosen in the desktop's layer picker, mirrored like the accent
# so the phone page can follow it. Keys match MapView's layerDefs.
_MAP_LAYER_KEYS = ("osm", "google", "esri_street", "esri", "liberty", "bright",
                   "positron", "versa", "nlsc", "gsi")
_map_layer: dict[str, str] = {"key": "osm"}


@router.post("/api/phone/map_layer")
async def phone_set_map_layer(body: _MapLayerBody, request: Request):
    """Desktop-only: mirror the desktop's base map choice."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Localhost only")
    _map_layer["key"] = body.key if body.key in _MAP_LAYER_KEYS else "osm"
    return dict(_map_layer)


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


# Wrong-PIN limits. A 6-digit PIN is only a million guesses, and this
# endpoint is reachable by anything on the LAN, so guessing has to be slow:
# a few tries per address, and a ceiling across all addresses so spreading
# the guesses over many source IPs does not help either.
_PIN_FAILS_PER_IP = 5
_PIN_IP_LOCK_SECONDS = 60.0
_PIN_FAILS_GLOBAL = 30
_PIN_GLOBAL_WINDOW_SECONDS = 600.0
_PIN_GLOBAL_LOCK_SECONDS = 300.0
_pin_ip_state: dict[str, tuple[int, float]] = {}  # ip -> (fails, locked_until)
_pin_global_fails: list[float] = []
_pin_global_locked_until = 0.0


def _pin_retry_after(ip: str, now: float) -> float:
    """Seconds this address still has to wait, 0 when it may try."""
    wait = max(0.0, _pin_global_locked_until - now)
    fails, locked_until = _pin_ip_state.get(ip, (0, 0.0))
    return max(wait, locked_until - now, 0.0)


def _pin_record_failure(ip: str, now: float) -> None:
    global _pin_global_locked_until
    fails, _ = _pin_ip_state.get(ip, (0, 0.0))
    fails += 1
    if fails >= _PIN_FAILS_PER_IP:
        _pin_ip_state[ip] = (0, now + _PIN_IP_LOCK_SECONDS)
    else:
        _pin_ip_state[ip] = (fails, 0.0)
    _pin_global_fails.append(now)
    cutoff = now - _PIN_GLOBAL_WINDOW_SECONDS
    while _pin_global_fails and _pin_global_fails[0] < cutoff:
        _pin_global_fails.pop(0)
    if len(_pin_global_fails) >= _PIN_FAILS_GLOBAL:
        _pin_global_fails.clear()
        _pin_global_locked_until = now + _PIN_GLOBAL_LOCK_SECONDS
        logger.warning("Phone control: too many wrong PINs, pairing paused for %d s",
                       int(_PIN_GLOBAL_LOCK_SECONDS))
    # Keep the table from growing without bound.
    if len(_pin_ip_state) > 512:
        for key in [k for k, (f, until) in _pin_ip_state.items() if until < now and f == 0][:256]:
            _pin_ip_state.pop(key, None)


@router.post("/api/phone/auth")
async def phone_auth(req: _AuthRequest, request: Request):
    """PIN-only flow: phone POSTs the PIN it sees on the desktop screen
    and gets the token back. PIN comparison is constant-time, and wrong
    attempts are rate-limited (see the limits above)."""
    ip = request.client.host if request.client else "?"
    now = time.monotonic()
    wait = _pin_retry_after(ip, now)
    if wait > 0:
        raise HTTPException(
            status_code=429,
            detail={"code": "pin_locked", "message": "Too many wrong PINs", "retry_after": int(wait) + 1},
            headers={"Retry-After": str(int(wait) + 1)},
        )
    if not secrets.compare_digest(req.pin, _auth.pin):
        _pin_record_failure(ip, now)
        raise HTTPException(status_code=401, detail={"code": "bad_pin", "message": "Invalid PIN"})
    _pin_ip_state.pop(ip, None)
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
            "coord_format": dict(_coord_format),
            "accent_rgb": _appearance["accent_rgb"],
            "map_layer": _map_layer["key"],
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
        # Progress of the primary engine's active route, for the phone's
        # "now moving" bar. All zero while idle.
        "is_paused": bool(s.is_paused),
        "progress": s.progress,
        "distance_remaining": s.distance_remaining,
        "eta_seconds": s.eta_seconds,
        "speed_kmh": round((s.speed_mps or 0.0) * 3.6, 1),
        "coord_format": dict(_coord_format),
        "accent_rgb": _appearance["accent_rgb"],
        "map_layer": _map_layer["key"],
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
    _push_recent(body.lat, body.lng, "teleport", body.name)
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
    _push_recent(body.lat, body.lng, "navigate", body.name)
    return {
        "status": "started",
        "destination": {"lat": body.lat, "lng": body.lng},
        "mode": mode.value,
        "speed_kmh": body.speed_kmh,
    }


@router.post("/api/phone/pause")
async def phone_pause(
    request: Request,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    _check_token(_resolve_token(request, x_locwarp_token, t))
    await _fanout("pause", lambda e: e.pause())
    return {"status": "paused"}


@router.post("/api/phone/resume")
async def phone_resume(
    request: Request,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    _check_token(_resolve_token(request, x_locwarp_token, t))
    await _fanout("resume", lambda e: e.resume())
    return {"status": "resumed"}


@router.post("/api/phone/speed")
async def phone_speed(
    body: _SpeedBody,
    request: Request,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    """Change the speed of whatever route is currently running, on every
    connected engine. 400 when nothing is moving."""
    _check_token(_resolve_token(request, x_locwarp_token, t))
    from config import resolve_speed_profile
    from models.schemas import MovementMode
    try:
        mode = MovementMode(body.mode)
    except ValueError:
        mode = MovementMode.WALKING
    profile = resolve_speed_profile(mode.value, speed_kmh=body.speed_kmh)
    applied = 0
    for e in _all_engines():
        try:
            if e.apply_speed(profile):
                applied += 1
        except Exception:
            logger.warning("phone speed: apply failed on one engine", exc_info=True)
    if applied == 0:
        raise HTTPException(status_code=400, detail={
            "code": "no_active_route",
            "message": "目前沒有進行中的路線,無法套用新速度",
        })
    return {"status": "applied", "speed_kmh": round(profile["speed_mps"] * 3.6, 1)}


@router.get("/api/phone/bookmarks")
async def phone_bookmarks(
    request: Request,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    """Read-only copy of the desktop's saved coordinates, in the same
    category / item order the desktop shows."""
    _check_token(_resolve_token(request, x_locwarp_token, t))
    from main import app_state
    bm = app_state.bookmark_manager
    cats = sorted(bm.list_categories(), key=lambda c: c.sort_order)
    return {
        "categories": [{"id": c.id, "name": c.name, "color": c.color} for c in cats],
        "bookmarks": [
            {"id": b.id, "name": b.name, "lat": b.lat, "lng": b.lng,
             "category_id": b.category_id, "country_code": b.country_code}
            for b in bm.list_bookmarks()
        ],
    }


@router.get("/api/phone/routes")
async def phone_routes(
    request: Request,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    """Read-only copy of the desktop's saved routes, in the same category
    / item order the desktop shows. Waypoints are included so the phone
    can preview a route on its map before starting it."""
    _check_token(_resolve_token(request, x_locwarp_token, t))
    from main import app_state
    rm = app_state.route_manager
    return {
        "categories": [{"id": c.id, "name": c.name, "color": c.color} for c in rm.list_categories()],
        "routes": [
            {"id": r.id, "name": r.name, "category_id": r.category_id, "profile": r.profile,
             "waypoints": [{"lat": w.lat, "lng": w.lng} for w in r.waypoints]}
            for r in rm.list_routes()
        ],
    }


class _FlowerOpts(BaseModel):
    """種花模式 settings; same meaning as the desktop's 花農設定."""
    radius_m: float = Field(default=30.0, ge=1.0, le=1000.0)
    circles: float = Field(default=1.0, ge=0.5, le=50.0)
    rounds: int = Field(default=1, ge=1, le=100)
    # True: teleport between waypoints. False: walk there.
    teleport: bool = False


class _RouteStartBody(BaseModel):
    route_id: str = Field(min_length=1, max_length=100)
    mode: str = "walking"  # walking / running / driving
    speed_kmh: float | None = Field(default=None, ge=0.1, le=300.0)
    # False: walk the waypoints once and stop. True: keep circling back
    # to the first waypoint until stopped.
    loop: bool = False
    # True: jump to the first waypoint before starting. False: walk there
    # from the current virtual position (engines without one still jump).
    teleport_to_start: bool = True
    # Set to run the route in 種花模式 (circle around every waypoint)
    # instead of walking along it. `loop` is ignored then.
    flower: _FlowerOpts | None = None


@router.post("/api/phone/route/start")
async def phone_route_start(
    body: _RouteStartBody,
    request: Request,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    """Run one of the desktop's saved routes on every connected device."""
    _check_token(_resolve_token(request, x_locwarp_token, t))
    from main import app_state
    route = next((r for r in app_state.route_manager.list_routes() if r.id == body.route_id), None)
    if route is None:
        raise HTTPException(status_code=404, detail={
            "code": "route_not_found", "message": "找不到這條路線,可能已在電腦上刪除",
        })
    if len(route.waypoints) < 2:
        raise HTTPException(status_code=400, detail={
            "code": "route_too_short", "message": "這條路線少於 2 個點,無法執行",
        })
    engines = _all_engines()
    from api.location import _spawn
    from models.schemas import Coordinate, MovementMode
    try:
        mode = MovementMode(body.mode)
    except ValueError:
        mode = MovementMode.WALKING
    first = route.waypoints[0]

    async def _to_start(e):
        if body.teleport_to_start or e.current_position is None:
            await e.teleport(first.lat, first.lng)

    await _fanout("route start", _to_start)
    # Fire-and-forget, like navigate: each engine runs its own sim and the
    # call only returns once the route ends. Each engine gets its own
    # waypoint list so nothing a sim does can touch the saved route.
    for e in engines:
        wps = [Coordinate(lat=w.lat, lng=w.lng) for w in route.waypoints]
        if body.flower is not None:
            f = body.flower
            _spawn(e.flower(wps, mode, radius_m=f.radius_m, circles=f.circles, rounds=f.rounds,
                            teleport=f.teleport, speed_kmh=body.speed_kmh))
        elif body.loop:
            _spawn(e.start_loop(wps, mode, speed_kmh=body.speed_kmh, pause_enabled=False))
        else:
            _spawn(e.multi_stop(wps, mode, 0, False, speed_kmh=body.speed_kmh, pause_enabled=False))
    return {"status": "started", "name": route.name, "waypoints": len(route.waypoints),
            "loop": body.loop, "flower": body.flower is not None, "mode": mode.value}


class _RandomWalkBody(BaseModel):
    radius_m: float = Field(default=500.0, ge=10.0, le=50000.0)
    mode: str = "walking"  # walking / running / driving
    speed_kmh: float | None = Field(default=None, ge=0.1, le=300.0)


@router.post("/api/phone/randomwalk")
async def phone_random_walk(
    body: _RandomWalkBody,
    request: Request,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    """Wander at random inside a circle around the current virtual
    position, on every connected device. 400 when there is no position
    to centre the circle on."""
    _check_token(_resolve_token(request, x_locwarp_token, t))
    engines = _all_engines()
    from main import app_state
    primary = app_state.simulation_engine
    anchor = primary.current_position if primary is not None else None
    if anchor is None:
        anchor = next((e.current_position for e in engines if e.current_position is not None), None)
    if anchor is None:
        raise HTTPException(status_code=400, detail={
            "code": "no_position",
            "message": "尚未有虛擬位置,請先瞬移或飛座標",
        })
    from api.location import _spawn
    from models.schemas import Coordinate, MovementMode
    try:
        mode = MovementMode(body.mode)
    except ValueError:
        mode = MovementMode.WALKING
    center = Coordinate(lat=anchor.lat, lng=anchor.lng)

    async def _to_center(e):
        if e.current_position is None:
            await e.teleport(center.lat, center.lng)

    await _fanout("random walk", _to_center)
    # One seed for every device so they pick the same destinations and
    # stay together, as the desktop does in group mode.
    seed = secrets.randbelow(2 ** 31)
    for e in engines:
        _spawn(e.random_walk(center, body.radius_m, mode, speed_kmh=body.speed_kmh,
                             pause_enabled=False, seed=seed))
    return {"status": "started", "radius_m": body.radius_m, "mode": mode.value}


# Same Windows Location query the desktop's 定位電腦 button runs from the
# Electron main process (frontend/electron/main.js LOCATE_PS_SCRIPT). The
# phone cannot reach that process, so the backend runs it here; keep the
# two scripts in step.
_LOCATE_PS_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Device
  $watcher = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High)
  $watcher.Start()
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    if ($watcher.Permission -eq 'Denied') { Write-Output 'DENIED'; exit 0 }
    if ($watcher.Status -eq 'Ready' -and -not $watcher.Position.Location.IsUnknown) { break }
    Start-Sleep -Milliseconds 200
  }
  if ($watcher.Permission -eq 'Denied') { Write-Output 'DENIED'; exit 0 }
  $loc = $watcher.Position.Location
  if ($loc.IsUnknown) { Write-Output ('NODATA,status=' + $watcher.Status); exit 0 }
  Write-Output ('OK,' + $loc.Latitude.ToString([cultureinfo]::InvariantCulture) + ',' + $loc.Longitude.ToString([cultureinfo]::InvariantCulture) + ',' + $loc.HorizontalAccuracy.ToString([cultureinfo]::InvariantCulture))
  $watcher.Stop()
} catch {
  Write-Output ('ERROR,' + $_.Exception.Message)
}
"""


def _windows_location() -> dict:
    """Blocking; call through asyncio.to_thread. Returns {"ok": True, lat,
    lng, accuracy} or {"ok": False, "code": ...}."""
    import platform
    if platform.system() != "Windows":
        return {"ok": False, "code": "UNSUPPORTED"}
    import subprocess
    try:
        proc = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-Command", _LOCATE_PS_SCRIPT],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=18.0, creationflags=0x08000000,  # CREATE_NO_WINDOW
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "code": "TIMEOUT"}
    except Exception as e:
        logger.debug("locate-pc: powershell failed to run", exc_info=True)
        return {"ok": False, "code": "SPAWN_FAILED", "message": str(e)}
    out = (proc.stdout or "").strip()
    if out.startswith("OK,"):
        try:
            _, lat, lng, acc = out.split(",")[:4]
            lat_f, lng_f = float(lat), float(lng)
            if -90 <= lat_f <= 90 and -180 <= lng_f <= 180:
                try:
                    acc_f = float(acc)
                except ValueError:
                    acc_f = 100.0
                return {"ok": True, "lat": lat_f, "lng": lng_f,
                        "accuracy": acc_f if acc_f == acc_f and acc_f > 0 else 100.0}
        except ValueError:
            pass
    if out == "DENIED":
        return {"ok": False, "code": "DENIED"}
    return {"ok": False, "code": "NODATA", "message": out[:200]}


@router.get("/api/phone/locate_pc")
async def phone_locate_pc(
    request: Request,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    """Where the PC really is: Windows Location (Wi-Fi positioning) first,
    then IP geolocation, the same order as the desktop's 定位電腦. Only
    reports the position; moving there is a separate teleport."""
    _check_token(_resolve_token(request, x_locwarp_token, t))
    import asyncio
    win = await asyncio.to_thread(_windows_location)
    if win["ok"]:
        return {"lat": win["lat"], "lng": win["lng"], "accuracy": win["accuracy"], "via": "windows"}
    if win["code"] == "DENIED":
        raise HTTPException(status_code=409, detail={
            "code": "location_denied",
            "message": "電腦的 Windows 定位服務被關閉,請到電腦的 設定 > 隱私權與安全性 > 位置 開啟",
        })
    logger.info("phone locate-pc: Windows Location gave %s, trying IP", win["code"])
    from api.geocode import real_location
    try:
        ip = await real_location()
    except HTTPException:
        raise HTTPException(status_code=502, detail={
            "code": "locate_failed", "message": "電腦無法取得位置 (Wi-Fi 定位與 IP 定位都失敗)",
        })
    return {"lat": ip["lat"], "lng": ip["lng"], "accuracy": 5000.0, "via": "ip"}


@router.get("/api/phone/recent")
async def phone_recent(
    request: Request,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    _check_token(_resolve_token(request, x_locwarp_token, t))
    from services.recent import get_manager
    return get_manager().list()


@router.get("/api/phone/geocode")
async def phone_geocode(
    request: Request,
    q: str,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    """Forward geocode using whichever provider the desktop UI picked.

    The desktop saves its choice (and the Google API key if any) to the
    backend via PUT /api/geocode/provider-pref. We honour the same
    preference here so the mobile page doesn't quietly fall back to
    Nominatim — which has been 403-ing for some users — when the user
    explicitly chose Photon or Google upstairs."""
    _check_token(_resolve_token(request, x_locwarp_token, t))
    from services.geocoding import GeocodingService
    from main import app_state
    provider = app_state._geocode_provider or "arcgis"
    google_key = app_state._google_geocode_key or None
    if provider == "google" and not google_key:
        provider = "arcgis"  # safety fallback if key got cleared
    svc = GeocodingService()
    try:
        results = await svc.search(
            q, limit=8, provider=provider, google_key=google_key,
            arcgis_key=app_state._arcgis_geocode_key or None,
        )
    except Exception as e:
        logger.exception("phone geocode failed (provider=%s): %s", provider, e)
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


async def _reverse_lookup(lat: float, lng: float) -> tuple[str, str]:
    """Best-effort (short name, country code) for a spot; ('', '') when
    the lookup fails or takes too long, so saving never waits on it."""
    import asyncio
    from api.geocode import geocoding_service
    try:
        r = await asyncio.wait_for(geocoding_service.reverse(lat, lng, True), timeout=8)
    except Exception:
        logger.debug("phone reverse lookup failed", exc_info=True)
        return "", ""
    if not r:
        return "", ""
    short = (r.short_name or (r.display_name or "").split(",")[0]).strip()
    return short, (r.country_code or "").lower()


@router.get("/api/phone/reverse")
async def phone_reverse(
    request: Request,
    lat: float,
    lng: float,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    """Suggested name for a spot, used to pre-fill 存成座標 on the phone."""
    _check_token(_resolve_token(request, x_locwarp_token, t))
    name, cc = await _reverse_lookup(lat, lng)
    return {"name": name, "country_code": cc}


class _BookmarkCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    lat: float = Field(ge=-90.0, le=90.0)
    lng: float = Field(ge=-180.0, le=180.0)
    category_id: str = Field(default="default", max_length=100)
    country_code: str = Field(default="", max_length=8)


@router.post("/api/phone/bookmarks")
async def phone_bookmark_create(
    body: _BookmarkCreateBody,
    request: Request,
    x_locwarp_token: str | None = Header(default=None, alias="X-LocWarp-Token"),
    t: str | None = None,
):
    """Save a coordinate from the phone into the desktop's saved list (the
    same store the desktop 收藏 tab edits), then tell the desktop UI so it
    shows up there right away."""
    _check_token(_resolve_token(request, x_locwarp_token, t))
    from main import app_state
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is empty")
    bm = app_state.bookmark_manager
    for b in bm.list_bookmarks():
        if abs(b.lat - body.lat) < 1e-6 and abs(b.lng - body.lng) < 1e-6:
            raise HTTPException(status_code=409, detail={"code": "duplicate", "message": b.name})
    cc = (body.country_code or "").lower()
    if not cc:
        _, cc = await _reverse_lookup(body.lat, body.lng)
    created = bm.create_bookmark(
        name=name, lat=body.lat, lng=body.lng,
        category_id=body.category_id or "default", country_code=cc,
    )
    try:
        from api.websocket import broadcast
        await broadcast("bookmarks_changed", {"id": created.id, "source": "phone"})
    except Exception:
        logger.debug("bookmarks_changed broadcast failed", exc_info=True)
    return {"id": created.id, "name": created.name, "lat": created.lat, "lng": created.lng,
            "category_id": created.category_id, "country_code": created.country_code}


# ── Mobile page ──────────────────────────────────────────────


def _static_path(name: str) -> Path:
    """Resolve a bundled static file in both dev (./backend/static/) and
    PyInstaller-packaged (sys._MEIPASS/static/) layouts."""
    import sys
    candidates: list[Path] = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / "static" / name)
    candidates.append(Path(__file__).resolve().parent.parent / "static" / name)
    for c in candidates:
        if c.exists():
            return c
    return candidates[-1]


def _phone_page_path() -> Path:
    return _static_path("phone.html")


@router.get("/phone/manifest.webmanifest")
async def phone_manifest():
    """Web app manifest so "Add to Home Screen" opens the page full
    screen, without browser chrome. No secrets in here."""
    return JSONResponse(
        {
            "name": "LocWarp",
            "short_name": "LocWarp",
            "start_url": "/phone",
            "scope": "/phone",
            "display": "standalone",
            "orientation": "portrait",
            "background_color": "#0e1015",
            "theme_color": "#0e1015",
            "icons": [
                {"src": "/phone/icon.png", "sizes": "256x256", "type": "image/png", "purpose": "any"},
            ],
        },
        media_type="application/manifest+json",
    )


@router.get("/phone/icon.png")
async def phone_icon():
    path = _static_path("phone-icon.png")
    if not path.exists():
        raise HTTPException(status_code=404, detail="icon missing")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


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
