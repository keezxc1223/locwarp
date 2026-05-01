import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from models.schemas import DeviceInfo

logger = logging.getLogger(__name__)

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


async def _tcp_probe(ip: str, port: int, timeout: float = 0.4) -> bool:
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, port), timeout=timeout,
        )
        writer.close()
        try:
            await writer.wait_closed()
        except (OSError, ConnectionError):
            pass
        return True
    except (OSError, ConnectionError, asyncio.TimeoutError):
        return False


async def _scan_subnet_for_port(port: int = 49152) -> list[str]:
    """Scan the local /24 subnet for hosts responding on the given TCP port."""
    my_ip = _get_primary_local_ip()
    if not my_ip:
        return []
    try:
        parts = my_ip.split(".")
        prefix = ".".join(parts[:3])
    except (AttributeError, IndexError):
        return []

    candidates = [f"{prefix}.{i}" for i in range(1, 255) if f"{prefix}.{i}" != my_ip]
    results = await asyncio.gather(
        *[_tcp_probe(ip, port, 0.4) for ip in candidates],
        return_exceptions=True,
    )
    hits = [ip for ip, ok in zip(candidates, results) if ok is True]
    return hits


@router.get("/wifi/tunnel/discover")
async def wifi_tunnel_discover():
    """Find iPhones on the local network. First tries mDNS (Bonjour RemotePairing
    broadcast); if that yields nothing, falls back to a /24 subnet TCP scan on the
    standard RemotePairing port (49152)."""
    results: list[dict] = []

    # --- 1) mDNS / Bonjour broadcast ---
    try:
        from pymobiledevice3.bonjour import browse_remotepairing
        instances = await browse_remotepairing(timeout=3.0)
        for inst in instances:
            ipv4s = [a for a in (inst.addresses or []) if ":" not in a]
            addrs = ipv4s if ipv4s else list(inst.addresses or [])
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

    # --- 2) Fallback: TCP subnet scan on port 49152 ---
    if not results:
        _tunnel_logger.info("mDNS empty; falling back to /24 TCP scan on port 49152")
        try:
            hits = await _scan_subnet_for_port(49152)
            for ip in hits:
                results.append({
                    "ip": ip,
                    "port": 49152,
                    "host": ip,
                    "name": ip,
                    "method": "tcp_scan",
                })
        except Exception as e:
            _tunnel_logger.warning("TCP scan failed: %s", e)

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
    and torn down."""
    from main import app_state
    dm = _dm()
    conn = dm._connections.get(udid)
    if conn is None or getattr(conn, "connection_type", "") != "Network":
        return False
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


async def _per_tunnel_watchdog(udid: str, runner: TunnelRunner) -> None:
    """Watch a single device's tunnel. If the runner's task dies (WiFi
    blip, iPhone locked, admin revoked), give 5s grace then tear down
    only this device's WiFi connection. Other tunnels continue running."""
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

        _tunnel_logger.warning("Tunnel for %s exited unexpectedly; 5s grace", udid)
        try:
            from api.websocket import broadcast
            await broadcast("tunnel_degraded", {"udid": udid, "reason": "task_exited"})
        except Exception:
            _tunnel_logger.exception("Failed to emit tunnel_degraded event")

        await asyncio.sleep(5.0)

        async with _tunnels_lock:
            current = _tunnels.get(udid)
            if current is not runner:
                # Replaced or removed during grace; nothing to do.
                return
            if current.is_running():
                _tunnel_logger.info("Tunnel for %s recovered within grace period", udid)
                try:
                    from api.websocket import broadcast
                    await broadcast("tunnel_recovered", {"udid": udid})
                except Exception:
                    pass
                return
            # Final teardown for this udid only.
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
        _tunnel_logger.info(
            "WiFi tunnel start: ip=%s port=%d candidates=%s",
            req.ip, req.port, candidates,
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
                and existing.target_port == req.port
            ):
                return {"status": "already_running", "udid": cand, **(existing.info or {})}

        last_error: Exception | None = None
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
                    req.ip, req.port,
                )
                continue
            if existing is not None:
                # Stale entry (runner not running but slot still held);
                # safe to clean up before reusing.
                await _tear_down_tunnel(cand, caller="start_replace_stale")

            _tunnel_logger.info(
                "Trying WiFi tunnel with udid=%s ip=%s port=%d",
                cand, req.ip, req.port,
            )

            # Per-candidate timeout is shorter than the legacy 20s budget.
            # Pair-verify against the wrong iPhone fails in well under a
            # second; if a candidate hasn't responded in 8s the iPhone is
            # almost certainly unreachable on the network and the next
            # candidate would just hit the same wall, so the loop bails
            # below on TimeoutError.
            runner = TunnelRunner()
            try:
                info = await runner.start(cand, req.ip, req.port, timeout=8.0)
            except asyncio.TimeoutError as e:
                last_error = e
                _tunnel_logger.warning(
                    "WiFi tunnel timed out for udid=%s; iPhone may be "
                    "unreachable on the network — stopping further "
                    "candidates",
                    cand,
                )
                # Network-level timeout: trying more udids is unlikely to
                # help. Surface the timeout error to the caller.
                raise HTTPException(
                    status_code=500,
                    detail={"code": "tunnel_timeout", "message": "Tunnel 啟動逾時"},
                ) from e
            except Exception as e:
                last_error = e
                _tunnel_logger.info(
                    "WiFi tunnel candidate %s failed (%s); trying next",
                    cand, type(e).__name__,
                )
                continue

            _tunnels[cand] = runner
            _tunnel_watchdogs[cand] = asyncio.create_task(
                _per_tunnel_watchdog(cand, runner)
            )
            _tunnel_logger.info("WiFi tunnel started for %s: %s", cand, info)
            return {"status": "started", "udid": cand, **info}

        # All candidates exhausted without a successful handshake.
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


# ── Device GPS via Safari Web Inspector ────────────────────────────────────────

async def _read_gps_via_webinspector(lockdown, gps_timeout: float = 10.0) -> dict | None:
    """Execute navigator.geolocation in Safari via Web Inspector and return GPS fix.

    Works on both real GPS (after restore) and simulated GPS (during teleport),
    so it always reflects the coordinate the phone thinks it is at.

    Requirements on the device:
    • Safari open with at least one web page tab
    • Settings > Safari > Advanced > Web Inspector = ON
    • Location permission granted to Safari (or to the current page's origin)

    Returns {"lat", "lng", "accuracy"} or None on failure.
    """
    from pymobiledevice3.services.webinspector import WebinspectorService, WirTypes
    from pymobiledevice3.exceptions import WebInspectorNotEnabledError

    inspector = WebinspectorService(lockdown)
    try:
        # Attempt connection; WebInspectorNotEnabledError means the toggle is off.
        # Use a 2-second inner timeout so we fail fast when Web Inspector is disabled.
        await asyncio.wait_for(inspector.connect(timeout=2.0), timeout=3.0)
    except (asyncio.TimeoutError, WebInspectorNotEnabledError, Exception) as exc:
        logger.debug("WebInspector connect failed: %s", exc)
        return None

    try:
        # Collect open page listings (wait 1 s for webinspectord to reply).
        try:
            ap_list = await asyncio.wait_for(
                inspector.get_open_application_pages(timeout=1.0), timeout=3.0
            )
        except asyncio.TimeoutError:
            ap_list = []

        # Keep only real web pages (not JS contexts, service workers, etc.)
        web_pages = [
            ap for ap in ap_list
            if ap.page.type_ in (WirTypes.WEB, WirTypes.WEB_PAGE, WirTypes.PAGE)
        ]
        if not web_pages:
            logger.debug("WebInspector: no open Safari web pages found")
            return None

        ap = web_pages[0]
        logger.debug("WebInspector: using page %s", ap)

        try:
            session = await asyncio.wait_for(
                inspector.inspector_session(ap.application, ap.page), timeout=5.0
            )
        except asyncio.TimeoutError:
            logger.debug("WebInspector: inspector_session timed out")
            return None

        # Kick off geolocation in Safari; store the result in window globals so
        # we can poll without needing awaitPromise support in the protocol stack.
        init_js = (
            "(function(){"
            "window._lw_done=false;window._lw_loc=null;"
            "if(!navigator.geolocation){window._lw_loc={error:'no geolocation'};window._lw_done=true;return;}"
            "navigator.geolocation.getCurrentPosition("
            "function(p){window._lw_loc={lat:p.coords.latitude,lng:p.coords.longitude,acc:p.coords.accuracy};window._lw_done=true;},"
            "function(e){window._lw_loc={error:e.message||String(e.code)};window._lw_done=true;},"
            "{timeout:" + str(int(gps_timeout * 1000)) + ",enableHighAccuracy:true,maximumAge:300000}"
            ");return 'started';})()"
        )
        # Timeout the JS evaluation itself to prevent infinite hang if WebKit
        # accepts the session but never responds to Runtime.evaluate messages.
        try:
            await asyncio.wait_for(
                session.runtime_evaluate(init_js, return_by_value=True), timeout=4.0
            )
        except asyncio.TimeoutError:
            logger.debug("WebInspector: runtime_evaluate(init) timed out")
            return None

        # Poll until done or timeout.
        poll_js = "window._lw_done?JSON.stringify(window._lw_loc):null"
        deadline = asyncio.get_event_loop().time() + gps_timeout + 1.0
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.3)
            try:
                raw = await asyncio.wait_for(
                    session.runtime_evaluate(poll_js, return_by_value=True), timeout=3.0
                )
            except asyncio.TimeoutError:
                continue

            if raw is None:
                continue  # not done yet

            try:
                loc = json.loads(raw) if isinstance(raw, str) else raw
            except Exception:
                continue

            if isinstance(loc, dict):
                if "lat" in loc:
                    return {
                        "lat": float(loc["lat"]),
                        "lng": float(loc["lng"]),
                        "accuracy": float(loc.get("acc", 10)),
                    }
                elif "error" in loc:
                    logger.debug("WebInspector geolocation error: %s", loc["error"])
                    return None

        logger.debug("WebInspector geolocation timed out after %.1f s", gps_timeout)
        return None

    except Exception as exc:
        logger.debug("WebInspector GPS read failed: %s", exc)
        return None
    finally:
        try:
            await inspector.close()
        except Exception:
            pass


@router.get("/{udid}/gps")
async def get_device_gps(udid: str):
    """Return the phone's current GPS position by executing navigator.geolocation
    in an open Safari tab via Web Inspector.

    This returns the *phone's* actual coordinates — real GPS after restore, or
    the simulated position while teleporting.  Accuracy is whatever the device
    reports (typically 5–65 m with GPS/WiFi).

    Prerequisites (on the device):
    • Safari open with at least one web tab
    • Settings > Safari > Advanced > Web Inspector = ON
    • Safari has Location Services permission (any page that has previously
      been granted location access works; a fresh allow-prompt may appear)
    """
    dm = _dm()
    conn = dm._connections.get(udid)
    if not conn:
        raise HTTPException(
            status_code=404,
            detail={"code": "NOT_CONNECTED", "message": "Device not connected"},
        )

    # Prefer usbmux lockdown for WebInspector; fall back to RSD lockdown.
    lockdown = conn.usbmux_lockdown or conn.lockdown

    loc = await _read_gps_via_webinspector(lockdown, gps_timeout=10.0)

    # If WebInspector failed (Safari not open / Web Inspector off), try the RSD
    # lockdown path as well (iOS 17+ shim remote service).
    if loc is None and conn.usbmux_lockdown and conn.lockdown is not conn.usbmux_lockdown:
        loc = await _read_gps_via_webinspector(conn.lockdown, gps_timeout=6.0)

    if loc:
        return {
            "ok": True,
            "lat": loc["lat"],
            "lng": loc["lng"],
            "accuracy": loc["accuracy"],
            "via": "device_gps",
        }

    raise HTTPException(
        status_code=503,
        detail={
            "code": "GPS_UNAVAILABLE",
            "message": (
                "無法讀取手機 GPS。請確認：\n"
                "1. 手機上 Safari 已開啟至少一個分頁\n"
                "2. 設定 > Safari > 進階 > 網頁檢查器 = 開啟\n"
                "3. Safari 已取得定位權限"
            ),
        },
    )
