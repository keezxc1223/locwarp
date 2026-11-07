from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from models.schemas import DeviceInfo

router = APIRouter(prefix="/api/device", tags=["device"])


def _dm():
    from main import app_state
    return app_state.device_manager


@router.get("/list", response_model=list[DeviceInfo])
async def list_devices():
    dm = _dm()
    return await dm.discover_devices()


# /wifi/connect (legacy direct-IP WiFi for iOS <17) removed in v0.1.49.


@router.get("/wifi/scan")
async def wifi_scan():
    """Scan the local network for iOS devices."""
    dm = _dm()
    try:
        results = await dm.scan_wifi_devices()
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class WifiTunnelConnectRequest(BaseModel):
    rsd_address: str
    rsd_port: int


@router.post("/wifi/tunnel")
async def wifi_tunnel_connect(req: WifiTunnelConnectRequest):
    """Connect to a device via an existing WiFi tunnel (RSD address/port)."""
    from main import app_state
    from core.device_manager import UnsupportedIosVersionError
    dm = _dm()
    # Max 3 devices (group mode). connect_wifi_tunnel may reconnect an existing udid;
    # we can only cheaply check the pre-state here.
    if len(dm._connections) >= MAX_DEVICES:
        raise HTTPException(
            status_code=409,
            detail={"code": "max_devices_reached", "message": f"已連接最多 {MAX_DEVICES} 台裝置"},
        )
    try:
        info = await dm.connect_wifi_tunnel(req.rsd_address, req.rsd_port)
        await app_state.create_engine_for_device(info.udid)
        try:
            from api.websocket import broadcast
            await broadcast("device_connected", {
                "udid": info.udid,
                "name": info.name,
                "ios_version": info.ios_version,
                "connection_type": "Network",
            })
        except Exception:
            pass
        return {
            "status": "connected",
            "udid": info.udid,
            "name": info.name,
            "ios_version": info.ios_version,
            "connection_type": "Network",
        }
    except UnsupportedIosVersionError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "ios_unsupported",
                "message": (
                    f"偵測到 iOS {e.version},LocWarp 自 v0.1.49 起僅支援 "
                    f"iOS {UnsupportedIosVersionError.MIN_VERSION} 以上。"
                    f"請將裝置升級至 iOS {UnsupportedIosVersionError.MIN_VERSION} 或更新版本後再連線。"
                ),
                "ios_version": e.version,
                "min_version": UnsupportedIosVersionError.MIN_VERSION,
            },
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── WiFi Tunnel lifecycle (start / status / stop) ───────

import asyncio
import logging

from core.wifi_tunnel import TunnelRunner

_tunnel_logger = logging.getLogger("wifi_tunnel")

# Group-mode device cap. Same value gates USB auto-connect, /wifi/tunnel,
# /wifi/tunnel/start, /wifi/tunnel/start-and-connect, and /{udid}/connect.
MAX_DEVICES = 3

# Per-device tunnel registry. Each connected iOS 17+ device that uses
# WiFi (instead of USB) gets its own TunnelRunner. v0.2.83 lifted the
# previous singleton design so multiple iPhones can run on WiFi at once.
# Registry mutations go through _tunnels_lock; individual TunnelRunners
# also keep their own .lock for their own lifecycle (start/stop/wait).
_tunnels: dict[str, TunnelRunner] = {}
_tunnel_watchdogs: dict[str, asyncio.Task] = {}
_tunnels_lock = asyncio.Lock()


@router.post("/wifi/repair")
async def wifi_repair():
    """Regenerate the RemotePairing pair record (~/.pymobiledevice3/) using a
    currently-attached USB device. The iPhone will show a 'Trust This Computer'
    prompt the first time; after the user taps 信任, a fresh RemotePairing
    record is written and WiFi Tunnel will work again.

    Flow:
      1. List USB devices (must have at least one plugged in).
      2. Open a USB lockdown session with autopair=True — this triggers the
         Trust prompt if the Apple Lockdown USB record is missing.
      3. For iOS 17+: open CoreDeviceTunnelProxy.start_tcp_tunnel() briefly.
         pymobiledevice3 persists the RemotePairing record to
         ~/.pymobiledevice3/ as a side effect of the RSD handshake.
    """
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.usbmux import list_devices as mux_list_devices
    from pymobiledevice3.remote.tunnel_service import (
        CoreDeviceTunnelProxy,
        create_core_device_tunnel_service_using_rsd,
    )
    from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService

    try:
        raw_devices = await mux_list_devices()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": "usbmux_unavailable", "message": f"無法列出 USB 裝置:{e}"},
        )

    # Prefer a USB-attached device (Network entries won't help us regenerate
    # the RemotePairing record).
    usb_dev = next((d for d in raw_devices if getattr(d, "connection_type", "USB") == "USB"), None)
    if usb_dev is None:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "repair_needs_usb",
                "message": "請先用 USB 線連接 iPhone。重新配對需要 USB 觸發『信任這台電腦』提示。",
            },
        )

    udid = usb_dev.serial
    _tunnel_logger.info("Re-pair requested for USB device %s", udid)

    # Step 1: USB lockdown autopair — pops Trust prompt if USB record missing.
    try:
        lockdown = await create_using_usbmux(serial=udid, autopair=True)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={
                "code": "trust_failed",
                "message": f"USB 信任失敗 — 請在 iPhone 解鎖畫面上點「信任」後再試:{e}",
                "udid": udid,
            },
        )

    ios_version = lockdown.all_values.get("ProductVersion", "0.0")
    name = lockdown.all_values.get("DeviceName", "iPhone")

    # Step 2: iOS 17+ — briefly open a CoreDeviceTunnelProxy. The RSD handshake
    # re-generates the ~/.pymobiledevice3/ RemotePairing record.
    try:
        major = int(ios_version.split(".")[0])
    except (ValueError, IndexError):
        major = 0

    remote_record_regenerated = False
    if major >= 17:
        # Delete any stale remote pair record for this udid so the
        # RemotePairingProtocol.connect() path can't short-circuit through
        # the cached (possibly-corrupt) record and actually runs _pair().
        try:
            from pymobiledevice3.common import get_home_folder
            from pymobiledevice3.pair_records import (
                PAIRING_RECORD_EXT,
                get_remote_pairing_record_filename,
            )
            stale = get_home_folder() / f"{get_remote_pairing_record_filename(udid)}.{PAIRING_RECORD_EXT}"
            if stale.exists():
                stale.unlink()
                _tunnel_logger.info("Re-pair: removed stale remote pair record %s", stale)
        except Exception:
            _tunnel_logger.debug("Re-pair: could not check/remove stale pair record", exc_info=True)

        proxy = None
        tunnel_ctx = None
        rsd = None
        tunnel_svc = None
        try:
            # 1. Open a CoreDeviceTunnelProxy tunnel over USB.
            proxy = await CoreDeviceTunnelProxy.create(lockdown)
            tunnel_ctx = proxy.start_tcp_tunnel()
            tunnel_result = await tunnel_ctx.__aenter__()

            # 2. Construct an RSD on the tunnel.
            rsd = RemoteServiceDiscoveryService((tunnel_result.address, tunnel_result.port))
            await rsd.connect()

            # 3. This is the step that actually triggers the Trust dialog
            #    (when no cached record) and persists the RemotePairing file
            #    to ~/.pymobiledevice3/. RemotePairingProtocol.connect()
            #    calls _pair() which runs _request_pair_consent() — Trust
            #    prompt — then save_pair_record().
            _tunnel_logger.info(
                "Re-pair: opening CoreDeviceTunnelService over RSD %s:%s — "
                "Trust prompt should appear on iPhone...",
                tunnel_result.address, tunnel_result.port,
            )
            tunnel_svc = await create_core_device_tunnel_service_using_rsd(rsd, autopair=True)
            _tunnel_logger.info(
                "Re-pair: CoreDeviceTunnelService connected for %s — RemotePairing record written",
                udid,
            )
            remote_record_regenerated = True
        except Exception as e:
            _tunnel_logger.exception("Re-pair: RemotePairing handshake failed")
            msg = str(e)
            if "PairingDialogResponsePending" in msg or "consent" in msg.lower():
                friendly = "請在 iPhone 解鎖螢幕上按「信任」後重試(timeout 只有幾秒)。"
            elif "not paired" in msg.lower() or "pairingerror" in msg.lower():
                friendly = "USB 配對失效,請拔 USB 重插一次並按信任。"
            else:
                friendly = f"RemotePairing 握手失敗:{msg}"
            raise HTTPException(
                status_code=500,
                detail={
                    "code": "remote_pair_failed",
                    "message": friendly,
                    "udid": udid,
                    "ios_version": ios_version,
                },
            )
        finally:
            # Close everything in reverse order; ignore errors.
            for closer in (
                lambda: tunnel_svc and tunnel_svc.close(),
                lambda: rsd and rsd.close(),
                lambda: tunnel_ctx and tunnel_ctx.__aexit__(None, None, None),
            ):
                try:
                    r = closer()
                    if hasattr(r, "__await__"):
                        await r
                except Exception:
                    pass
            try:
                if proxy is not None:
                    proxy.close()
            except Exception:
                pass

    return {
        "status": "paired",
        "udid": udid,
        "name": name,
        "ios_version": ios_version,
        "remote_record_regenerated": remote_record_regenerated,
    }


class WifiTunnelStartRequest(BaseModel):
    ip: str
    port: int = 49152
    udid: str | None = None
    # Extra RemotePairing port candidates, in fallback order. iOS re-picks
    # its RemotePairing port on every boot / network rebind, so a single
    # remembered port goes stale constantly; /discover and /find_port now
    # hand back the whole open-port list and the start loop walks it.
    ports: list[int] | None = None


# Ports that sit inside the 49152-65535 dynamic range the scanner sweeps
# but are never RemotePairing. 62078 is lockdownd: TCP connects fine, so
# "lowest open port" used to pick it, and the handshake then burned a
# whole attempt budget on a guaranteed ConnectionTerminatedError.
NON_REMOTEPAIRING_PORTS = frozenset({62078})

# Ceiling on how long one /wifi/tunnel/start may spend walking candidate
# ports. Wrong ports normally fail in milliseconds (RST), so this only
# bites when several candidates are silently dropped by the network.
TUNNEL_START_BUDGET = 45.0


def _filter_remotepairing_ports(ports: list[int]) -> list[int]:
    """Drop ports we know can't be RemotePairing, preserving order."""
    return [p for p in ports if p not in NON_REMOTEPAIRING_PORTS]


def _get_primary_local_ip() -> str | None:
    """Return this machine's primary IPv4 (the one used to reach the internet)."""
    import socket as _s
    try:
        s = _s.socket(_s.AF_INET, _s.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


# ── LAN scanning safety limits (issue #49) ──────────────
# Every outgoing probe in this module holds one slot of this process-wide
# semaphore, so no combination of discover / find_port / tunnel-start
# re-scan can have more than this many connects in flight. Windows'
# default ephemeral range is 16384 ports; the old per-host 1024 limit
# multiplied by "every candidate host at once" could exceed it many times.
PROBE_CONCURRENCY = 256
_PROBE_SEM = asyncio.Semaphore(PROBE_CONCURRENCY)

# A real iPhone has only a handful of listeners in 49152-65535. A host that
# accepts more than this is a VPN / proxy that answers SYN for every
# address and port, and continuing would just pile up TIME_WAIT sockets.
MAX_OPEN_PORTS_PER_HOST = 32

# Upper bound on hosts that get the full-range port scan in one discover.
MAX_SCAN_HOSTS = 8

# Unverified hosts (62078 accepted but lockdownd fingerprint did not answer)
# are only kept when the subnet looks like a normal LAN with this many or
# fewer such hosts; an accept-everything VPN produces ~253.
MAX_UNVERIFIED_HOSTS = 4

LOCKDOWN_PORT = 62078


class _TooManyOpenPorts(Exception):
    """Raised when a host accepts so many ports it cannot be an iPhone."""


# Single-flight: concurrent callers asking for the same scan share one run
# instead of stacking scans (auto-connect + manual click, or find_port +
# tunnel-start re-scan of the same IP).
_scan_inflight: dict[str, asyncio.Future] = {}


async def _single_flight(key: str, factory):
    fut = _scan_inflight.get(key)
    if fut is None or fut.done():
        fut = asyncio.ensure_future(factory())
        _scan_inflight[key] = fut

        def _done(f: asyncio.Future, k: str = key) -> None:
            if _scan_inflight.get(k) is f:
                _scan_inflight.pop(k, None)
            # Mark the exception as retrieved even when every awaiter left.
            if not f.cancelled():
                f.exception()

        fut.add_done_callback(_done)
    # shield: one caller going away (HTTP client closed) must not cancel the
    # scan another caller is still waiting on. The scan is bounded anyway.
    return await asyncio.shield(fut)


async def _close_writer(writer) -> None:
    if writer is None:
        return
    try:
        writer.close()
        await writer.wait_closed()
    except Exception:
        pass


async def _tcp_probe(ip: str, port: int, timeout: float = 0.4) -> bool:
    """TCP connect probe. Holds a global probe slot for its whole lifetime."""
    async with _PROBE_SEM:
        writer = None
        try:
            _reader, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, port), timeout=timeout,
            )
            return True
        except (OSError, ConnectionError, asyncio.TimeoutError):
            return False
        finally:
            await _close_writer(writer)


async def _probe_lockdownd(ip: str, timeout: float = 1.5) -> str:
    """Check whether `ip` runs lockdownd on 62078.

    Returns "lockdown" when the host answers a QueryType request the way only
    lockdownd does (no pairing needed for QueryType), "open" when TCP connects
    but the reply is missing or wrong, and "closed" otherwise. VPNs / proxies
    that accept every SYN land in "open", so they never pass as an iPhone.
    """
    import plistlib
    import struct

    async with _PROBE_SEM:
        writer = None
        try:
            try:
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection(ip, LOCKDOWN_PORT), timeout=timeout,
                )
            except (OSError, ConnectionError, asyncio.TimeoutError):
                return "closed"
            try:
                payload = plistlib.dumps({"Label": "LocWarp", "Request": "QueryType"})
                writer.write(struct.pack(">I", len(payload)) + payload)
                await asyncio.wait_for(writer.drain(), timeout=timeout)
                hdr = await asyncio.wait_for(reader.readexactly(4), timeout=timeout)
                (size,) = struct.unpack(">I", hdr)
                if size <= 0 or size > 64 * 1024:
                    return "open"
                body = await asyncio.wait_for(reader.readexactly(size), timeout=timeout)
                reply = plistlib.loads(body)
            except Exception:
                return "open"
            if isinstance(reply, dict) and reply.get("Type") == "com.apple.mobile.lockdown":
                return "lockdown"
            return "open"
        finally:
            await _close_writer(writer)


async def _find_lockdown_hosts() -> list[str]:
    """Probe the primary /24 for iPhones, verified by the lockdownd reply."""
    my_ip = _get_primary_local_ip()
    if not my_ip:
        return []
    try:
        prefix = ".".join(my_ip.split(".")[:3])
    except (AttributeError, IndexError):
        return []

    hosts = [f"{prefix}.{i}" for i in range(1, 255) if f"{prefix}.{i}" != my_ip]
    states = await asyncio.gather(*[_probe_lockdownd(ip) for ip in hosts])
    verified = [ip for ip, s in zip(hosts, states) if s == "lockdown"]
    unverified = [ip for ip, s in zip(hosts, states) if s == "open"]
    _tunnel_logger.info(
        "Subnet probe %s.0/24 (local %s): %d lockdownd host(s), %d host(s) "
        "accepted 62078 without a lockdownd reply",
        prefix, my_ip, len(verified), len(unverified),
    )
    if len(unverified) > MAX_UNVERIFIED_HOSTS:
        # Accept-everything network path (VPN TUN / fake-ip / proxy). Those
        # hosts are not iPhones; scanning them is what caused issue #49.
        _tunnel_logger.warning(
            "Ignoring %d unverified host(s) on %s.0/24: looks like a VPN or "
            "proxy answering every address", len(unverified), prefix,
        )
        unverified = []
    return (verified + unverified)[:MAX_SCAN_HOSTS]


async def _scan_ports_for_ip_impl(
    ip: str, start: int, end: int, workers: int, timeout: float,
) -> list[int]:
    ports = iter(range(start, end + 1))
    hits: list[int] = []
    too_many = False

    async def _worker() -> None:
        nonlocal too_many
        for p in ports:
            if too_many:
                return
            if await _tcp_probe(ip, p, timeout):
                hits.append(p)
                if len(hits) > MAX_OPEN_PORTS_PER_HOST:
                    too_many = True
                    return

    tasks = [asyncio.create_task(_worker()) for _ in range(workers)]
    try:
        await asyncio.gather(*tasks)
    finally:
        # Cancelled or failed: make sure no probe outlives the scan.
        for t in tasks:
            if not t.done():
                t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    if too_many:
        _tunnel_logger.warning(
            "Port scan of %s stopped: more than %d open ports, not an iPhone "
            "(VPN / proxy answering every port)", ip, MAX_OPEN_PORTS_PER_HOST,
        )
        raise _TooManyOpenPorts(ip)
    hits.sort()
    return hits


async def _scan_ports_for_ip(
    ip: str,
    start: int = 49152,
    end: int = 65535,
    workers: int = PROBE_CONCURRENCY,
    timeout: float = 0.35,
) -> list[int]:
    """Scan the IANA dynamic / ephemeral range on a single IP for open TCP ports.

    iOS picks the RemotePairing port from this range at boot / network rebind,
    so the actual port on a given iPhone is rarely the legacy 49152 default.
    Most closed ports return RST immediately on a same-LAN probe, so a fixed
    pool of workers (sharing the global probe limit) finishes in seconds.
    Raises _TooManyOpenPorts when the host is clearly not an iPhone.
    """
    return await _single_flight(
        f"ports:{ip}:{start}-{end}",
        lambda: _scan_ports_for_ip_impl(ip, start, end, workers, timeout),
    )


class WifiTunnelFindPortRequest(BaseModel):
    ip: str


@router.post("/wifi/tunnel/find_port")
async def wifi_tunnel_find_port(req: WifiTunnelFindPortRequest):
    """Scan an iPhone IP across the IANA dynamic range (49152-65535) and return
    every open TCP port. Used as the manual fallback when mDNS / Bonjour fails
    because the user's router blocks multicast or the PC has VPN / virtual NICs
    that hijack the broadcast path."""
    ip = (req.ip or "").strip()
    if not ip:
        raise HTTPException(status_code=400, detail="ip required")
    try:
        ports = await _scan_ports_for_ip(ip)
    except _TooManyOpenPorts:
        return {"ip": ip, "ports": [], "proxy_suspected": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ip": ip, "ports": ports}


async def _discover_by_scan() -> list[dict]:
    """TCP fallback for discover when mDNS finds nothing.

    a) probe the /24 on 62078 and keep only hosts that answer like lockdownd
       (see _find_lockdown_hosts for the unverified-host rule)
    b) full-range scan (49152-65535) on each of those, one host at a time,
       to find the port iOS actually picked this boot
    """
    found: list[dict] = []
    candidates = await _find_lockdown_hosts()
    if not candidates:
        return found
    _tunnel_logger.info(
        "Smart scan: full-range scanning %d candidate(s): %s",
        len(candidates), candidates,
    )
    for ip in candidates:
        try:
            ports = await _scan_ports_for_ip(ip)
        except Exception as e:
            _tunnel_logger.warning("port scan for %s failed: %s", ip, e)
            continue
        ports = _filter_remotepairing_ports(ports)
        if not ports:
            continue
        # One entry per IP; `port` is the primary guess and `ports` carries
        # the rest as fallbacks. A scan can't tell RemotePairing apart from
        # any other listener in the dynamic range, so the tunnel start loop
        # is what actually decides, by trying the handshake on each.
        found.append({
            "ip": ip,
            "port": ports[0],
            "ports": ports[:8],
            "host": ip,
            "name": ip,
            "method": "tcp_scan",
        })
    return found


@router.get("/wifi/tunnel/discover")
async def wifi_tunnel_discover(scan: bool = True):
    """Find iPhones on the local network. First tries mDNS (Bonjour RemotePairing
    broadcast); if that yields nothing and `scan` is true, falls back to a
    lockdownd-verified /24 scan plus a port scan of the verified hosts.

    Background auto-connect passes scan=false: it must never run a LAN scan
    the user did not ask for (issue #49)."""
    results: list[dict] = []

    # --- 1) mDNS / Bonjour broadcast ---
    try:
        from pymobiledevice3.bonjour import browse_remotepairing
        instances = await browse_remotepairing(timeout=3.0)
        for inst in instances:
            # Newer pymobiledevice3 returns Address objects with .ip and
            # .iface attributes; older releases returned plain string IPs.
            # Pull the bare IP either way so the UI shows e.g.
            # "192.168.0.185" not "Address(ip='192.168.0.185',
            # iface='Intel(R) Ethernet Controller (3) I225-V')".
            raw_addrs = inst.addresses or []
            str_addrs: list[str] = []
            for a in raw_addrs:
                if hasattr(a, "ip"):
                    str_addrs.append(str(a.ip))
                else:
                    str_addrs.append(str(a))
            ipv4s = [s for s in str_addrs if ":" not in s]
            addrs = ipv4s if ipv4s else str_addrs
            for addr in addrs:
                results.append({
                    "ip": addr,
                    "port": inst.port,
                    "host": inst.host,
                    "name": inst.instance or inst.host,
                    "method": "mdns",
                })
    except Exception as e:
        _tunnel_logger.warning("mDNS browse failed: %s", e)

    # --- 2) Fallback: lockdownd-verified /24 scan (manual detect only) ---
    if not results and scan:
        _tunnel_logger.info("mDNS empty; falling back to verified /24 scan")
        try:
            results.extend(await _single_flight("discover_scan", _discover_by_scan))
        except Exception as e:
            _tunnel_logger.warning("Smart fallback scan failed: %s", e)
    elif not results:
        _tunnel_logger.info("mDNS empty; LAN scan skipped (scan=false)")

    # De-dupe on (ip, port)
    seen = set()
    unique = []
    for r in results:
        key = (r["ip"], r["port"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(r)

    return {"devices": unique}


async def _cleanup_wifi_connection_for(udid: str, *, caller: str) -> bool:
    """Disconnect a single WiFi-connected device + drop its sim engine.
    Broadcasts device_disconnected for that udid so the frontend chip
    flips to disconnected. Returns True iff a Network connection was found
    and torn down.

    The engine MUST be stopped before the dm.disconnect closes the RSD —
    otherwise its in-flight task (random_walk / loop / multi_stop /
    navigate / _move_along_route) keeps trying to push positions through
    the now-dead RSD, hits DeviceLostError, retries, fails again, and
    floods the log with `Giving up on this route after repeated push
    failures` every ~2 seconds for as long as LocWarp stays open.
    Mirrors the USB watchdog teardown sequence in main.py:387-418."""
    from main import app_state
    dm = _dm()
    conn = dm._connections.get(udid)
    if conn is None or getattr(conn, "connection_type", "") != "Network":
        return False

    # Stop the running simulation BEFORE we close the underlying lockdown,
    # so its retry loop doesn't get a chance to log a dozen DeviceLostError
    # rounds against the dying RSD.
    old_eng = app_state.simulation_engines.get(udid)
    if old_eng is not None:
        try:
            from models.schemas import SimulationState as _SS
            old_eng.state = _SS.DISCONNECTED
            try:
                await old_eng._emit("state_change", {"state": old_eng.state.value})
            except Exception:
                _tunnel_logger.debug(
                    "[%s] disconnected state_change emit failed", caller, exc_info=True,
                )
            old_eng._stop_event.set()
            old_eng._pause_event.set()  # unstick anyone awaiting pause_event
            active = getattr(old_eng, "_active_task", None)
            if active is not None and not active.done():
                active.cancel()
        except Exception:
            _tunnel_logger.debug(
                "[%s] failed to stop old engine for %s", caller, udid, exc_info=True,
            )

    try:
        await dm.disconnect(udid)
        _tunnel_logger.info("[%s] Disconnected WiFi device %s", caller, udid)
    except (OSError, RuntimeError):
        _tunnel_logger.exception("[%s] Failed to disconnect %s", caller, udid)
    app_state.simulation_engines.pop(udid, None)
    if app_state._primary_udid == udid:
        remaining = next(iter(app_state.simulation_engines.keys()), None)
        app_state._primary_udid = remaining
    try:
        from api.websocket import broadcast
        await broadcast("device_disconnected", {
            "udid": udid,
            "udids": [udid],
            "reason": "wifi_tunnel_stopped",
            "remaining_count": len(dm._connections),
        })
    except Exception:
        _tunnel_logger.exception("[%s] WiFi cleanup broadcast failed", caller)
    return True


async def _cleanup_all_wifi_connections(caller: str = "unknown") -> list[str]:
    """Disconnect every Network device + drop their sim engines. Used by
    the legacy stop-all flow and shutdown paths."""
    import traceback
    dm = _dm()
    stack = traceback.extract_stack(limit=8)[:-1]
    stack_str = " <- ".join(f"{fr.name}@{fr.filename.split(chr(92))[-1]}:{fr.lineno}" for fr in reversed(stack))
    _tunnel_logger.warning(
        "_cleanup_all_wifi_connections called (caller=%s); stack: %s",
        caller, stack_str,
    )
    udids = [
        udid for udid, conn in list(dm._connections.items())
        if getattr(conn, "connection_type", "") == "Network"
    ]
    for udid in udids:
        await _cleanup_wifi_connection_for(udid, caller=caller)
    return udids


async def _tear_down_tunnel(udid: str, *, caller: str) -> None:
    """Cancel this udid's watchdog (if any) and stop the runner. Caller
    decides whether to also clean up the DM connection."""
    wd = _tunnel_watchdogs.pop(udid, None)
    if wd is not None and not wd.done():
        wd.cancel()
        try:
            await wd
        except (asyncio.CancelledError, Exception):
            pass
    runner = _tunnels.pop(udid, None)
    if runner is not None:
        try:
            await runner.stop()
        except Exception:
            _tunnel_logger.exception("[%s] runner.stop failed for %s", caller, udid)


# Restart backoff sequence (seconds). Three attempts cover most WiFi blips
# (transient packet loss, brief screen-lock pause) without sitting on a dead
# tunnel for an unbounded time. Total worst-case wait ~21s before final
# teardown — within the user's tolerance for "auto-recovers" before they'd
# look at the UI and notice.
_TUNNEL_RESTART_BACKOFF: tuple[float, ...] = (3.0, 6.0, 12.0)


async def _attempt_tunnel_restart(
    udid: str,
    ip: str,
    port: int,
    snapshot: dict | None,
    original_runner: TunnelRunner,
) -> bool:
    """Try one restart of the tunnel. On success, swaps in the new runner,
    rebuilds dm._connections + sim engine (since the new RSD interface gets
    a fresh address), and resumes any captured snapshot. Returns True on
    success, False otherwise. Caller decides whether to retry."""
    new_runner = TunnelRunner()
    try:
        info = await new_runner.start(udid, ip, port, timeout=10.0)
    except Exception as exc:
        _tunnel_logger.warning(
            "Tunnel restart failed for %s: %s: %s",
            udid, type(exc).__name__, exc,
        )
        return False

    new_rsd_address = info.get("rsd_address")
    new_rsd_port = info.get("rsd_port")
    if not new_rsd_address or not new_rsd_port:
        _tunnel_logger.warning(
            "Tunnel restart for %s returned no RSD info; treating as failure",
            udid,
        )
        try:
            await new_runner.stop()
        except Exception:
            pass
        return False

    from main import app_state
    try:
        async with _tunnels_lock:
            # User may have stopped this tunnel during our async window.
            if _tunnels.get(udid) is not original_runner:
                _tunnel_logger.info(
                    "Tunnel restart for %s racing user stop; discarding new runner",
                    udid,
                )
                try:
                    await new_runner.stop()
                except Exception:
                    pass
                return True  # not really success, but caller should NOT retry
            _tunnels[udid] = new_runner

        # connect_wifi_tunnel internally calls disconnect(udid) if udid
        # already exists, so the old (now-dead) RSD lockdown gets torn
        # down correctly.
        dm = _dm()
        dev_info = await dm.connect_wifi_tunnel(new_rsd_address, new_rsd_port)

        # Rebuild the sim engine bound to the new location service. The
        # old engine pointed at the dead RSD and would throw
        # ConnectionTerminatedError on the next teleport / position push.
        app_state.simulation_engines.pop(dev_info.udid, None)
        if app_state._primary_udid == dev_info.udid:
            # Keep this udid as primary; create_engine_for_device only
            # promotes when _primary_udid is None.
            pass
        await app_state.create_engine_for_device(dev_info.udid)

        # Re-arm the watchdog on the new runner so subsequent blips get
        # the same recovery treatment.
        old_wd = _tunnel_watchdogs.pop(udid, None)
        if old_wd is not None and old_wd is not asyncio.current_task() and not old_wd.done():
            old_wd.cancel()
        _tunnel_watchdogs[udid] = asyncio.create_task(
            _per_tunnel_watchdog(udid, new_runner)
        )

        # Resume any in-flight simulation (navigate / loop / multi-stop /
        # random_walk) so the iPhone keeps moving instead of stopping at
        # the blip point. Snapshot only exists when this device was the
        # one driving the sim — followers don't capture one.
        if snapshot is not None:
            new_eng = app_state.simulation_engines.get(dev_info.udid)
            if new_eng is not None:
                _tunnel_logger.info(
                    "Resuming sim from snapshot after tunnel restart for %s (kind=%s)",
                    dev_info.udid, snapshot.get("kind"),
                )
                asyncio.create_task(new_eng.resume_from_snapshot(snapshot))
        else:
            # Group-mode: if this WiFi device was a follower of some other
            # primary (USB or WiFi), restart broke the follower task. Re-
            # arm the same teleport-to-primary + attach-as-follower flow
            # the USB watchdog uses for re-plugged USB devices, so dual /
            # triple-device groups stay locked together across a blip.
            try:
                from main import _auto_sync_new_device_to_primary
                asyncio.create_task(_auto_sync_new_device_to_primary(dev_info.udid))
            except Exception:
                _tunnel_logger.exception(
                    "Auto-sync after tunnel restart failed for %s", dev_info.udid,
                )

        try:
            from api.websocket import broadcast
            await broadcast("tunnel_recovered", {
                "udid": dev_info.udid,
                "rsd_address": new_rsd_address,
                "rsd_port": new_rsd_port,
            })
            await broadcast("device_connected", {
                "udid": dev_info.udid,
                "name": dev_info.name,
                "ios_version": dev_info.ios_version,
                "connection_type": "Network",
            })
        except Exception:
            _tunnel_logger.exception("Failed to broadcast tunnel_recovered for %s", udid)

        _tunnel_logger.info(
            "Tunnel restart succeeded for %s (rsd %s:%d)",
            udid, new_rsd_address, new_rsd_port,
        )
        return True
    except Exception:
        _tunnel_logger.exception(
            "Tunnel restart for %s started but post-setup failed; rolling back",
            udid,
        )
        # Roll back the new runner we registered. Leave the old runner
        # entry empty so the outer retry loop tries a fresh new one.
        async with _tunnels_lock:
            if _tunnels.get(udid) is new_runner:
                _tunnels.pop(udid, None)
        try:
            await new_runner.stop()
        except Exception:
            pass
        return False


async def _per_tunnel_watchdog(udid: str, runner: TunnelRunner) -> None:
    """Watch a single device's tunnel. If the runner's task dies (WiFi
    blip, iPhone locked, admin revoked), capture the sim state, then try
    up to len(_TUNNEL_RESTART_BACKOFF) restarts with backoff. Each restart
    rebuilds the device manager connection (the new TUN interface gets a
    fresh RSD address) and resumes the sim from snapshot so the iPhone
    keeps moving across the blip. Other tunnels stay isolated."""
    try:
        task = runner.task
        if task is None:
            return
        try:
            await task
        except asyncio.CancelledError:
            return
        except BaseException:
            pass

        # If the registry was already updated (explicit stop, re-key on
        # reconnect, etc.) this watchdog is stale.
        if _tunnels.get(udid) is not runner:
            return

        ip = runner.target_ip
        port = runner.target_port

        _tunnel_logger.warning(
            "Tunnel for %s exited unexpectedly (target=%s:%s); will attempt %d restart(s)",
            udid, ip, port, len(_TUNNEL_RESTART_BACKOFF),
        )
        try:
            from api.websocket import broadcast
            await broadcast("tunnel_degraded", {"udid": udid, "reason": "task_exited"})
        except Exception:
            _tunnel_logger.exception("Failed to emit tunnel_degraded event")

        if ip is None or port is None:
            # No target captured; we have nothing to retry against. Fall
            # through to teardown.
            _tunnel_logger.warning(
                "Tunnel for %s has no captured target ip/port; skipping retries",
                udid,
            )
        else:
            from main import app_state
            snapshot: dict | None = None
            old_eng = app_state.simulation_engines.get(udid)
            if old_eng is not None:
                try:
                    snapshot = old_eng.capture_resumable_snapshot()
                    if snapshot:
                        _tunnel_logger.info(
                            "Captured resumable snapshot for %s before tunnel restart (kind=%s)",
                            udid, snapshot.get("kind"),
                        )
                except Exception:
                    _tunnel_logger.exception("capture_resumable_snapshot failed for %s", udid)

                # Park the engine while we restart. Without this, multi-stop /
                # loop / random-walk keep iterating to the next leg, each call
                # burning ~3s in DvtLocationService._reconnect retries against
                # the dead RSD before raising DeviceLostError, then the handler
                # immediately tries the next leg. The log fills with "Giving up
                # on this route after repeated push failures" every ~6s for as
                # long as the watchdog is mid-restart. Cancelling the active
                # task here halts the thrash; on a successful restart, the
                # snapshot we just captured drives resume_from_snapshot back to
                # the same leg / segment.
                try:
                    from models.schemas import SimulationState as _SS
                    old_eng.state = _SS.DISCONNECTED
                    try:
                        await old_eng._emit("state_change", {"state": old_eng.state.value})
                    except Exception:
                        _tunnel_logger.debug(
                            "Disconnected state_change emit failed during watchdog pause",
                            exc_info=True,
                        )
                    old_eng._stop_event.set()
                    old_eng._pause_event.set()  # unstick anyone awaiting pause_event
                    active = getattr(old_eng, "_active_task", None)
                    if active is not None and not active.done():
                        active.cancel()
                except Exception:
                    _tunnel_logger.exception(
                        "Failed to park engine for %s before tunnel restart", udid,
                    )

            for attempt, delay in enumerate(_TUNNEL_RESTART_BACKOFF, start=1):
                try:
                    await asyncio.sleep(delay)
                except asyncio.CancelledError:
                    return

                # User may have explicitly stopped or replaced this tunnel
                # during the sleep; if so, abort the retry loop.
                if _tunnels.get(udid) is not runner:
                    _tunnel_logger.info(
                        "Tunnel for %s no longer registered (user stop?); aborting retries",
                        udid,
                    )
                    return

                _tunnel_logger.info(
                    "Tunnel restart attempt %d/%d for %s (after %.0fs backoff)",
                    attempt, len(_TUNNEL_RESTART_BACKOFF), udid, delay,
                )
                ok = await _attempt_tunnel_restart(udid, ip, port, snapshot, runner)
                if ok:
                    # On success the new watchdog has been armed and this
                    # one's job is done.
                    return

        # All retries exhausted (or no target to retry against).
        _tunnel_logger.warning(
            "Tunnel for %s could not be restarted; tearing down WiFi connection",
            udid,
        )
        async with _tunnels_lock:
            current = _tunnels.get(udid)
            if current is runner:
                _tunnels.pop(udid, None)
            wd = _tunnel_watchdogs.pop(udid, None)
            if wd is not None and wd is not asyncio.current_task() and not wd.done():
                wd.cancel()
            await _cleanup_wifi_connection_for(udid, caller="watchdog_tunnel_died")
            try:
                from api.websocket import broadcast
                await broadcast("tunnel_lost", {"udid": udid, "reason": "task_exited"})
            except Exception:
                _tunnel_logger.exception("Failed to emit tunnel_lost event")
    except asyncio.CancelledError:
        raise


def _build_tunnel_udid_candidates(req: WifiTunnelStartRequest) -> list[str]:
    """Return udids to try for an incoming /wifi/tunnel/start request,
    in priority order:

    1. The udid the caller explicitly passed (always trusted)
    2. Currently USB-tracked udids (most likely correct in single-device
       use, and for the dual-device USB+WiFi flow)
    3. Cached pair records under ~/.pymobiledevice3/, sorted by mtime
       (most recently used first) — needed when the user opens LocWarp
       without USB and just types an IP

    The list is de-duped while preserving order. Caller iterates them;
    pair-verify fails fast (~200-400ms) on a wrong identifier so trying
    several is cheap. Bug history: v0.2.92 only used the first candidate,
    which broke multi-iPhone users whose target's pair record happened
    to not be the most-recently-used one."""
    candidates: list[str] = []

    def _add(c: str | None) -> None:
        if c and c not in candidates:
            candidates.append(c)

    _add(req.udid)
    try:
        dm = _dm()
        for u in dm._connections.keys():
            _add(u)
    except (RuntimeError, AttributeError):
        pass
    try:
        from pymobiledevice3.pair_records import iter_remote_pair_records
        records = sorted(
            iter_remote_pair_records(),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for rec in records:
            stem = rec.name
            if stem.startswith("remote_"):
                stem = stem.split("remote_", 1)[1]
            ident = stem.split(".", 1)[0]
            _add(ident)
    except Exception:
        _tunnel_logger.debug("Could not enumerate cached pair records", exc_info=True)

    if not candidates:
        candidates.append(f"pending:{req.ip}:{req.port}")
    return candidates


def _build_tunnel_port_candidates(req: WifiTunnelStartRequest) -> list[int]:
    """Return RemotePairing ports to try, in priority order: the port the
    caller asked for, then any extra candidates it passed along.

    Known-wrong ports are dropped up front so they never consume an attempt.
    The list may come back empty (e.g. the caller only had 62078); the start
    loop handles that by falling through to its live re-scan."""
    ports: list[int] = []
    for raw in [req.port, *(req.ports or [])]:
        try:
            p = int(raw)
        except (TypeError, ValueError):
            continue
        if p <= 0 or p > 65535 or p in ports or p in NON_REMOTEPAIRING_PORTS:
            continue
        ports.append(p)
    return ports


@router.post("/wifi/tunnel/start")
async def wifi_tunnel_start(req: WifiTunnelStartRequest):
    """Start an in-process WiFi tunnel for one device (requires admin).

    The runner is keyed in _tunnels by the actual udid once we resolve
    which paired iPhone is at the requested IP/port. Resolution iterates
    candidate udids (req.udid > USB-tracked > cached pair records) and
    keeps the one whose pair-verify handshake actually succeeds. The
    tunnel cap is enforced separately from the device cap so we don't
    accidentally start a 4th tunnel while only 3 devices are visible to
    dm._connections."""
    async with _tunnels_lock:
        # Active runners count toward the cap. Stale entries get pruned
        # so a crashed tunnel doesn't permanently block reconnect.
        live_count = sum(1 for r in _tunnels.values() if r.is_running())
        if live_count >= MAX_DEVICES:
            raise HTTPException(
                status_code=409,
                detail={"code": "max_devices_reached", "message": f"已連接最多 {MAX_DEVICES} 台裝置"},
            )

        candidates = _build_tunnel_udid_candidates(req)
        port_candidates = _build_tunnel_port_candidates(req)
        _tunnel_logger.info(
            "WiFi tunnel start: ip=%s ports=%s candidates=%s",
            req.ip, port_candidates or [req.port], candidates,
        )

        # If any candidate already has a running tunnel for the same
        # (ip, port) target, that one wins immediately — idempotent
        # re-click. We compare target_ip/port (not just udid) so a
        # tunnel for a DIFFERENT iPhone doesn't get returned when the
        # user is now trying to connect a new device.
        for cand in candidates:
            existing = _tunnels.get(cand)
            if (
                existing is not None
                and existing.is_running()
                and existing.target_ip == req.ip
                and existing.target_port in (port_candidates or [req.port])
            ):
                return {
                    "status": "already_running",
                    "udid": cand,
                    "port": existing.target_port,
                    **(existing.info or {}),
                }

        # Resolution walks (port × udid). Ports are the outer loop because a
        # wrong port dooms every udid on it, while a wrong udid fails
        # pair-verify in well under a second. Ports go stale constantly: iOS
        # re-picks its RemotePairing port on every boot and network rebind,
        # and a TCP scan can't tell RemotePairing apart from any other
        # listener in the dynamic range, so whatever the caller remembered
        # is only a starting guess.
        last_error: Exception | None = None
        tried_ports: set[int] = set()
        rescanned = False
        loop = asyncio.get_running_loop()
        deadline = loop.time() + TUNNEL_START_BUDGET

        while True:
            while port_candidates:
                port = port_candidates.pop(0)
                if port in tried_ports:
                    continue
                tried_ports.add(port)
                if loop.time() >= deadline:
                    _tunnel_logger.warning(
                        "WiFi tunnel start budget exhausted for %s after ports %s",
                        req.ip, sorted(tried_ports),
                    )
                    port_candidates.clear()
                    rescanned = True
                    break

                for cand in candidates:
                    existing = _tunnels.get(cand)
                    if existing is not None and existing.is_running():
                        # This udid already owns a tunnel for a DIFFERENT (ip,
                        # port). Don't tear it down — that would kill an active
                        # connection the user isn't asking us to touch. Just skip
                        # this candidate and try the next one.
                        _tunnel_logger.debug(
                            "Skipping candidate %s: already tunneling to %s:%s "
                            "(user requested %s:%s)",
                            cand, existing.target_ip, existing.target_port,
                            req.ip, port,
                        )
                        continue
                    if existing is not None:
                        # Stale entry (runner not running but slot still held);
                        # safe to clean up before reusing.
                        await _tear_down_tunnel(cand, caller="start_replace_stale")

                    _tunnel_logger.info(
                        "Trying WiFi tunnel with udid=%s ip=%s port=%d",
                        cand, req.ip, port,
                    )

                    # Per-candidate timeout is shorter than the legacy 20s
                    # budget. Pair-verify against the wrong iPhone fails in
                    # well under a second.
                    runner = TunnelRunner()
                    try:
                        info = await runner.start(cand, req.ip, port, timeout=8.0)
                    except asyncio.TimeoutError as e:
                        last_error = e
                        _tunnel_logger.warning(
                            "WiFi tunnel timed out for udid=%s on port %d; "
                            "nothing is answering RemotePairing there — moving "
                            "to the next port",
                            cand, port,
                        )
                        # Port-level failure: every other udid on this same
                        # port would hit the identical wall, so stop burning
                        # 8s each on them and move on.
                        break
                    except Exception as e:
                        last_error = e
                        _tunnel_logger.info(
                            "WiFi tunnel candidate %s on port %d failed (%s); "
                            "trying next",
                            cand, port, type(e).__name__,
                        )
                        continue

                    _tunnels[cand] = runner
                    _tunnel_watchdogs[cand] = asyncio.create_task(
                        _per_tunnel_watchdog(cand, runner)
                    )
                    _tunnel_logger.info(
                        "WiFi tunnel started for %s on port %d: %s", cand, port, info,
                    )
                    return {"status": "started", "udid": cand, "port": port, **info}

            if rescanned:
                break

            # Every port the caller knew about is exhausted. Before giving
            # up, scan the iPhone once for what it is actually listening on
            # right now — this is the common case after a reboot, where the
            # remembered port simply no longer exists.
            rescanned = True
            _tunnel_logger.info(
                "All known ports failed for %s; re-scanning 49152-65535 for a "
                "live RemotePairing port", req.ip,
            )
            try:
                fresh = _filter_remotepairing_ports(await _scan_ports_for_ip(req.ip))
            except Exception as e:
                _tunnel_logger.warning("Re-scan of %s failed: %s", req.ip, e)
                fresh = []
            fresh = [p for p in fresh if p not in tried_ports]
            if not fresh:
                _tunnel_logger.warning(
                    "Re-scan of %s found no untried ports", req.ip,
                )
                break
            _tunnel_logger.info("Re-scan found new port candidates: %s", fresh[:8])
            port_candidates.extend(fresh[:8])

        # All (port, udid) combinations exhausted without a successful
        # handshake.
        if isinstance(last_error, asyncio.TimeoutError):
            raise HTTPException(
                status_code=500,
                detail={"code": "tunnel_timeout", "message": "Tunnel 啟動逾時"},
            ) from last_error
        msg = f"無法啟動 tunnel:{last_error}" if last_error else "無法啟動 tunnel"
        raise HTTPException(
            status_code=500,
            detail={"code": "tunnel_spawn_failed", "message": msg},
        )


@router.get("/wifi/tunnel/status")
async def wifi_tunnel_status():
    """Return all active WiFi tunnels with their RSD info.

    The response shape is forward-compatible: the canonical payload is
    `{"tunnels": [{"udid", "rsd_address", "rsd_port", ...}, ...]}`. Legacy
    fields (`running`, `rsd_address`, `rsd_port`) mirror the FIRST tunnel
    so older single-tunnel callers keep working until they migrate."""
    tunnels: list[dict] = []
    for udid, runner in list(_tunnels.items()):
        if not runner.is_running():
            continue
        tunnels.append({"udid": udid, **(runner.info or {})})

    legacy = {"running": len(tunnels) > 0}
    if tunnels:
        legacy.update({k: v for k, v in tunnels[0].items() if k != "udid"})
    return {"tunnels": tunnels, **legacy}


class WifiTunnelStopRequest(BaseModel):
    udid: str | None = None  # None = stop ALL tunnels (legacy stop-all path)


@router.post("/wifi/tunnel/stop")
async def wifi_tunnel_stop(req: WifiTunnelStopRequest | None = None):
    """Stop a specific WiFi tunnel by udid, or all if udid is None.

    Per-udid stop tears down only the named tunnel and its DM
    connection — other tunnels keep running. The legacy stop-all path
    (no udid) preserves prior single-tunnel behaviour for callers that
    haven't migrated yet."""
    target_udid = req.udid if req else None
    dm = _dm()

    _tunnel_logger.warning(
        "/wifi/tunnel/stop endpoint hit. target_udid=%s, active_tunnels=%d, network_conns=%d",
        target_udid,
        sum(1 for r in _tunnels.values() if r.is_running()),
        sum(1 for c in dm._connections.values() if getattr(c, "connection_type", "") == "Network"),
    )

    async with _tunnels_lock:
        if target_udid is not None:
            if target_udid not in _tunnels and target_udid not in dm._connections:
                return {"status": "not_running", "udid": target_udid}
            udids_to_stop = [target_udid]
        else:
            # Stop everything: union of registered tunnels and any orphan
            # WiFi connections (defensive — shouldn't normally happen).
            udids_to_stop = list({
                *_tunnels.keys(),
                *(udid for udid, c in dm._connections.items()
                  if getattr(c, "connection_type", "") == "Network"),
            })

        if not udids_to_stop:
            return {"status": "not_running"}

        # Snapshot for the USB fallback step below: only re-attach via USB
        # the udids that just had a WiFi conn here, AND skip pending: keys
        # which were only ever placeholders.
        was_network_udids = [u for u in udids_to_stop if not u.startswith("pending:")]

        for udid in udids_to_stop:
            await _cleanup_wifi_connection_for(udid, caller="wifi_tunnel_stop_endpoint")
            await _tear_down_tunnel(udid, caller="wifi_tunnel_stop_endpoint")

    # USB fallback: only re-attach udids that were just in WiFi AND show
    # up as USB right now (covers users plugging in a cable mid-stop).
    try:
        from main import app_state
        devices = await dm.discover_devices()
        for udid in was_network_udids:
            usb_dev = next(
                (d for d in devices if d.udid == udid and d.connection_type == "USB"),
                None,
            )
            if usb_dev is None:
                _tunnel_logger.info(
                    "USB fallback: skipping %s (not visible as USB after tunnel stop)",
                    udid,
                )
                continue
            try:
                await dm.connect(usb_dev.udid)
            except Exception:
                _tunnel_logger.exception("USB fallback: connect failed for %s", usb_dev.udid)
                continue
            try:
                app_state.simulation_engines.pop(usb_dev.udid, None)
                await app_state.create_engine_for_device(usb_dev.udid)
                _tunnel_logger.info("Switched back to USB connection: %s", usb_dev.udid)
            except Exception:
                _tunnel_logger.exception(
                    "USB fallback: engine creation failed for %s; rolling back",
                    usb_dev.udid,
                )
                try:
                    await dm.disconnect(usb_dev.udid)
                except Exception:
                    pass
                app_state.simulation_engines.pop(usb_dev.udid, None)
                if app_state._primary_udid == usb_dev.udid:
                    remaining = next(iter(app_state.simulation_engines.keys()), None)
                    app_state._primary_udid = remaining
                try:
                    from api.websocket import broadcast
                    await broadcast("device_error", {
                        "udid": usb_dev.udid,
                        "stage": "usb_fallback",
                        "error": "USB fallback engine creation failed",
                    })
                except Exception:
                    pass
    except Exception:
        _tunnel_logger.exception("USB fallback after tunnel stop failed")

    return {"status": "stopped", "udids": udids_to_stop}


@router.post("/wifi/tunnel/start-and-connect")
async def wifi_tunnel_start_and_connect(req: WifiTunnelStartRequest):
    """Start a WiFi tunnel and immediately connect the device through it.

    Re-keys the runner from any temporary IP-based key to the real udid
    after dm.connect_wifi_tunnel reveals the device identity. This is the
    primary entrypoint the frontend uses; /start and /wifi/tunnel exist as
    separate primitives but are not chained from the UI today."""
    from main import app_state

    # Cap check before we even spawn a runner. Counts active runners,
    # not dm._connections — a tunnel that's mid-handshake but not yet
    # registered as a device connection still consumes a slot.
    async with _tunnels_lock:
        live_count = sum(1 for r in _tunnels.values() if r.is_running())
        if live_count >= MAX_DEVICES:
            raise HTTPException(
                status_code=409,
                detail={"code": "max_devices_reached", "message": f"已連接最多 {MAX_DEVICES} 台裝置"},
            )

    tunnel_result = await wifi_tunnel_start(req)
    if tunnel_result.get("status") not in ("started", "already_running"):
        raise HTTPException(status_code=500, detail="Tunnel failed to start")

    rsd_address = tunnel_result.get("rsd_address")
    rsd_port = tunnel_result.get("rsd_port")
    temp_key = tunnel_result.get("udid")

    if not rsd_address or not rsd_port:
        raise HTTPException(status_code=500, detail="Tunnel started but no RSD info available")

    dm = _dm()
    if len(dm._connections) >= MAX_DEVICES:
        raise HTTPException(
            status_code=409,
            detail={"code": "max_devices_reached", "message": f"已連接最多 {MAX_DEVICES} 台裝置"},
        )
    try:
        info = await dm.connect_wifi_tunnel(rsd_address, rsd_port)
        # v0.2.60: Drop the stale engine from the prior USB conn so
        # create_engine_for_device rebuilds a fresh one bound to the new
        # WiFi RSD. v0.2.57 made create_engine_for_device idempotent (to
        # survive the watchdog loop wiping current_position), but that
        # means on a USB→WiFi conn switch it would keep the old engine —
        # whose location_service._lockdown still points at the now-closed
        # USB RSD. First teleport over WiFi would then throw
        # ConnectionTerminatedError, reconnect would fail because the
        # cached lockdown is dead, and the user would see the device get
        # kicked as device_lost within 8 seconds of the WiFi switch.
        app_state.simulation_engines.pop(info.udid, None)
        await app_state.create_engine_for_device(info.udid)

        # Re-key the runner from temp_key (often "pending:ip:port") to
        # the real udid so per-udid stop / status / watchdog keep working.
        if temp_key and temp_key != info.udid:
            async with _tunnels_lock:
                runner = _tunnels.pop(temp_key, None)
                old_wd = _tunnel_watchdogs.pop(temp_key, None)
                if old_wd is not None and not old_wd.done():
                    old_wd.cancel()
                if runner is not None and runner.is_running():
                    # Replace any pre-existing entry under the real udid
                    # (defensive — shouldn't happen in normal flow).
                    prior = _tunnels.pop(info.udid, None)
                    if prior is not None and prior is not runner:
                        try:
                            await prior.stop()
                        except Exception:
                            pass
                    prior_wd = _tunnel_watchdogs.pop(info.udid, None)
                    if prior_wd is not None and not prior_wd.done():
                        prior_wd.cancel()
                    _tunnels[info.udid] = runner
                    _tunnel_watchdogs[info.udid] = asyncio.create_task(
                        _per_tunnel_watchdog(info.udid, runner)
                    )

        return {
            "status": "connected",
            "udid": info.udid,
            "name": info.name,
            "ios_version": info.ios_version,
            "connection_type": "Network",
            # The port that actually worked, which is not always the one
            # asked for: the start loop falls back to a live re-scan when
            # the caller's remembered port has gone stale. Callers persist
            # this so the next launch starts from a good guess.
            "port": tunnel_result.get("port", req.port),
            "rsd_address": rsd_address,
            "rsd_port": rsd_port,
        }
    except Exception as e:
        # On failure, tear down the runner we just started so we don't
        # leave a zombie tunnel + leaked watchdog.
        if temp_key:
            try:
                async with _tunnels_lock:
                    await _tear_down_tunnel(temp_key, caller="start_and_connect_failed")
            except Exception:
                pass
        raise HTTPException(status_code=500, detail=f"Tunnel started but connection failed: {e}")


class WifiKeepaliveRequest(BaseModel):
    enabled: bool


@router.get("/wifi/tunnel/keepalive")
async def wifi_tunnel_keepalive_get():
    """Return whether the idle-tunnel keep-alive loop is enabled."""
    from main import app_state
    return {"enabled": bool(app_state._wifi_keepalive_enabled)}


@router.post("/wifi/tunnel/keepalive")
async def wifi_tunnel_keepalive_set(req: WifiKeepaliveRequest):
    """Enable / disable the keep-alive that re-pushes the current location
    to idle WiFi tunnels so iOS doesn't drop them when the screen is off."""
    from main import app_state
    app_state._wifi_keepalive_enabled = bool(req.enabled)
    try:
        app_state.save_settings()
    except Exception:
        pass  # best-effort persist; never fail the toggle
    return {"enabled": app_state._wifi_keepalive_enabled}


@router.get("/wifi/host-network")
async def wifi_host_network():
    """Return this machine's primary IPv4 and its /24 prefix.

    The UI tags every saved tunnel IP with the prefix it was reached on, so
    it can keep one entry per (device, LAN) instead of overwriting the
    previous network's address, and only auto-connect the entries that
    belong to the network we are currently on (issue #48).
    """
    ip = _get_primary_local_ip()
    prefix = None
    if ip:
        parts = ip.split(".")
        if len(parts) == 4:
            prefix = ".".join(parts[:3])
    return {"ip": ip, "prefix": prefix}


# ── Generic UDID routes (MUST be defined after all specific /wifi/* routes
#    so that /wifi/* paths do not accidentally match {udid}). ─────────────

@router.post("/{udid}/amfi/reveal-developer-mode")
async def amfi_reveal_developer_mode(udid: str):
    """Make iOS's "Developer Mode" option appear in Settings → Privacy &
    Security. Same end state as side-loading a developer-signed IPA via
    Sideloadly / Xcode, but done directly through AMFI so the user doesn't
    need a third-party side-loader. iOS 16+ only.

    This is action 0 (REVEAL) of the com.apple.amfi.lockdown service. It
    just creates the AMFIShowOverridePath marker file on the device —
    no reboot, no passcode prompt, completely safe. The user still has
    to open Settings and toggle Developer Mode on themselves (which iOS
    will then require passcode removal + reboot for, per Apple's rules).
    """
    dm = _dm()
    conn = dm._connections.get(udid)
    if conn is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "device_not_connected", "message": "裝置未連線,請先連線再試"},
        )

    # iOS 15 and below have no Developer Mode concept.
    try:
        major = int((conn.ios_version or "0.0").split(".")[0])
    except Exception:
        major = 0
    if major < 16:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "ios_too_old",
                "message": f"iOS {conn.ios_version} 沒有開發者模式,不需要此操作",
            },
        )

    try:
        from pymobiledevice3.services.amfi import AmfiService
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail={"code": "amfi_not_available", "message": f"AMFI 服務載入失敗: {exc}"},
        )

    # AMFI is a legacy lockdown service (com.apple.amfi.lockdown) that's only
    # advertised on the classic USB lockdown, NOT on iOS 17+'s RSD tunnel.
    # For iOS 17+ devices we stash the original USB lockdown on
    # conn.usbmux_lockdown; use it here. For iOS 16 devices conn.lockdown
    # IS the USB lockdown, so fall back to it.
    amfi_lockdown = getattr(conn, "usbmux_lockdown", None) or conn.lockdown
    if amfi_lockdown is None:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "amfi_needs_usb",
                "message": "AMFI 需要走 USB 連線。請插 USB 後再試(WiFi tunnel 不 advertise AMFI 服務)。",
            },
        )

    try:
        await AmfiService(amfi_lockdown).reveal_developer_mode_option_in_ui()
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail={
                "code": "amfi_reveal_failed",
                "message": f"AMFI reveal 失敗: {exc.__class__.__name__}: {exc}",
            },
        )

    return {"status": "ok"}


@router.post("/{udid}/connect")
async def connect_device(udid: str):
    from main import app_state
    from core.device_manager import UnsupportedIosVersionError
    dm = _dm()
    # Group-mode device cap. Allow re-connect of an already-connected udid.
    if udid not in dm._connections and len(dm._connections) >= MAX_DEVICES:
        raise HTTPException(
            status_code=409,
            detail={"code": "max_devices_reached", "message": f"已連接最多 {MAX_DEVICES} 台裝置"},
        )
    try:
        await dm.connect(udid)
        await app_state.create_engine_for_device(udid)
        try:
            from api.websocket import broadcast
            devs = await dm.discover_devices()
            info = next((d for d in devs if d.udid == udid), None)
            await broadcast("device_connected", {
                "udid": udid,
                "name": info.name if info else "",
                "ios_version": info.ios_version if info else "",
                "connection_type": info.connection_type if info else "USB",
            })
        except Exception:
            pass
        return {"status": "connected", "udid": udid}
    except UnsupportedIosVersionError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "ios_unsupported",
                "message": (
                    f"偵測到 iOS {e.version},LocWarp 自 v0.1.49 起僅支援 "
                    f"iOS {UnsupportedIosVersionError.MIN_VERSION} 以上。"
                    f"請將裝置升級至 iOS {UnsupportedIosVersionError.MIN_VERSION} 或更新版本後再連線。"
                ),
                "ios_version": e.version,
                "min_version": UnsupportedIosVersionError.MIN_VERSION,
            },
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{udid}/connect")
async def disconnect_device(udid: str):
    from main import app_state
    dm = _dm()

    # WiFi devices: a bare dm.disconnect() closes the RSD but leaves the
    # tunnel runner + its watchdog armed. The watchdog then sees the socket
    # die, assumes a blip, and RESTARTS the tunnel — so the device the user
    # just disconnected pops back as "connected", and the restart churn
    # (engine rebuild + group auto-sync) can knock a sibling device into
    # device_lost. So for Network devices we must cancel the watchdog and
    # stop the runner, exactly like the Stop-Tunnel button (issue: right-
    # click disconnect on one device dropped all of them).
    conn = dm._connections.get(udid)
    is_network = conn is not None and getattr(conn, "connection_type", "") == "Network"
    has_tunnel = udid in _tunnels
    if is_network or has_tunnel:
        async with _tunnels_lock:
            cleaned = await _cleanup_wifi_connection_for(udid, caller="user_disconnect")
            await _tear_down_tunnel(udid, caller="user_disconnect")
        if not cleaned:
            # No Network conn was found to broadcast for (e.g. a pending
            # tunnel with no DM connection yet) — emit it ourselves so the
            # frontend chip + WiFi list still flip to disconnected.
            try:
                from api.websocket import broadcast
                await broadcast("device_disconnected", {"udid": udid, "udids": [udid], "reason": "user"})
            except Exception:
                pass
        return {"status": "disconnected", "udid": udid}

    # USB device: plain teardown.
    await dm.disconnect(udid)
    # Drop the per-udid engine (if any) so _engine() won't route to a dead service.
    app_state.simulation_engines.pop(udid, None)
    if app_state._primary_udid == udid:
        app_state._primary_udid = next(iter(app_state.simulation_engines), None)
    try:
        from api.websocket import broadcast
        await broadcast("device_disconnected", {"udid": udid, "udids": [udid], "reason": "user"})
    except Exception:
        pass
    return {"status": "disconnected", "udid": udid}


@router.get("/{udid}/info", response_model=DeviceInfo | None)
async def device_info(udid: str):
    dm = _dm()
    devices = await dm.discover_devices()
    for d in devices:
        if d.udid == udid:
            return d
    raise HTTPException(status_code=404, detail="Device not found")
