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


# ── WiFi connection ─────────────────────────────────────

class WifiConnectRequest(BaseModel):
    ip: str


@router.post("/wifi/connect")
async def wifi_connect(req: WifiConnectRequest):
    """Connect to an iOS device over WiFi by IP address."""
    from main import app_state
    dm = _dm()
    try:
        info = await dm.connect_wifi(req.ip)
        await app_state.create_engine_for_device(info.udid)
        return {
            "status": "connected",
            "udid": info.udid,
            "name": info.name,
            "ios_version": info.ios_version,
            "connection_type": "Network",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
    dm = _dm()
    try:
        info = await dm.connect_wifi_tunnel(req.rsd_address, req.rsd_port)
        await app_state.create_engine_for_device(info.udid)
        return {
            "status": "connected",
            "udid": info.udid,
            "name": info.name,
            "ios_version": info.ios_version,
            "connection_type": "Network",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── WiFi Tunnel lifecycle (start / status / stop) ───────

import asyncio
import json
import subprocess
import sys
import logging
from pathlib import Path

_tunnel_logger = logging.getLogger("wifi_tunnel")


class _TunnelManager:
    """Owns the subprocess + info state for the WiFi tunnel, serialised behind
    an asyncio.Lock so concurrent /start or /stop requests never race."""

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.info: dict | None = None
        self.lock = asyncio.Lock()
        self.watchdog_task: asyncio.Task | None = None

    def is_running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None


_tunnel = _TunnelManager()


def _kill_stale_tunnel_processes() -> int:
    """Kill any leftover wifi_tunnel.py python processes from previous runs.
    Returns the number of processes killed."""
    killed = 0
    # wmic was removed from Windows 11 — use PowerShell CIM instead.
    ps_script = (
        "Get-CimInstance Win32_Process -Filter \"Name like 'py%.exe' or Name like 'python%.exe'\" "
        "| Where-Object { $_.CommandLine -like '*wifi_tunnel.py*' } "
        "| Select-Object -ExpandProperty ProcessId"
    )
    try:
        out = subprocess.check_output(
            ["powershell", "-NoProfile", "-Command", ps_script],
            stderr=subprocess.DEVNULL, timeout=10, text=True,
        )
        for line in out.splitlines():
            pid = line.strip()
            if not pid.isdigit():
                continue
            try:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", pid],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=5,
                )
                killed += 1
                _tunnel_logger.info("Killed stale tunnel process PID=%s", pid)
            except Exception:
                _tunnel_logger.exception("Failed to kill PID=%s", pid)
    except FileNotFoundError:
        _tunnel_logger.warning("PowerShell not found; skipping stale tunnel cleanup")
    except Exception:
        _tunnel_logger.exception("Failed to enumerate stale tunnel processes")
    # Remove stale info file
    try:
        info_path = Path.home() / ".locwarp" / "wifi_tunnel_info.json"
        if info_path.exists():
            info_path.unlink()
    except OSError:
        _tunnel_logger.debug("Could not remove stale tunnel info file", exc_info=True)
    return killed


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
            ipv4s = [str(a) for a in (inst.addresses or []) if ":" not in str(a)]
            addrs = ipv4s if ipv4s else [str(a) for a in (inst.addresses or [])]
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


def _find_python313() -> list[str] | None:
    """Find a Python 3.13+ interpreter on the system.  Returns the
    command as a list of strings suitable for ``subprocess.Popen``."""
    import shutil
    import os

    # Build a search list: explicit version names first, then generic ones.
    # Also prepend Homebrew paths (/opt/homebrew/bin, /usr/local/bin) so macOS
    # can find python3.13 even when PATH isn't fully set by the parent process.
    candidates = ["py", "python3.13", "python3.14", "python3.15", "python3", "python"]

    # Prepend well-known macOS Homebrew locations
    homebrew_bins = ["/opt/homebrew/bin", "/usr/local/bin"]
    extra_paths = [
        os.path.join(base, name)
        for base in homebrew_bins
        for name in ("python3.13", "python3.14", "python3.15")
    ]

    checked: set[str] = set()

    def _try(path: str, is_py_launcher: bool = False) -> list[str] | None:
        if path in checked:
            return None
        checked.add(path)
        if not os.path.isfile(path):
            return None
        try:
            cmd = [path, "-3.13", "--version"] if is_py_launcher else [path, "--version"]
            out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, timeout=5)
            ver = out.decode().strip()
            parts = ver.split()[-1].split(".")
            if int(parts[0]) >= 3 and int(parts[1]) >= 13:
                return [path, "-3.13"] if is_py_launcher else [path]
        except (subprocess.SubprocessError, ValueError, IndexError, OSError):
            pass
        return None

    # 0. Highest priority: project-local .venv313 (has pymobiledevice3 pre-installed)
    try:
        project_root = Path(__file__).resolve().parent.parent.parent
        venv313_py = project_root / ".venv313" / "bin" / "python3.13"
        result = _try(str(venv313_py))
        if result:
            _tunnel_logger.info("Using .venv313 Python 3.13: %s", venv313_py)
            return result
    except Exception:
        pass

    # 1. Try absolute Homebrew paths (macOS)
    for p in extra_paths:
        result = _try(p)
        if result:
            return result

    # 2. Try PATH-resolved names
    for name in candidates:
        is_py = (name == "py")
        path = shutil.which(name)
        if path:
            result = _try(path, is_py_launcher=is_py)
            if result:
                return result

    return None


async def _cleanup_wifi_connections() -> list[str]:
    """Disconnect any Network devices + drop the simulation engine.
    Broadcasts device_disconnected so the frontend banners/disables context
    menu items immediately instead of waiting for the next failed action.
    Returns the UDIDs that were disconnected."""
    from main import app_state
    dm = _dm()
    udids: list[str] = []
    try:
        udids = [
            udid for udid, conn in list(dm._connections.items())
            if getattr(conn, "connection_type", "") == "Network"
        ]
        for udid in udids:
            try:
                await dm.disconnect(udid)
                _tunnel_logger.info("Disconnected WiFi device %s", udid)
            except (OSError, RuntimeError):
                _tunnel_logger.exception("Failed to disconnect %s", udid)
        if udids and app_state.simulation_engine is not None:
            app_state.simulation_engine = None
        if udids:
            try:
                from api.websocket import broadcast
                await broadcast("device_disconnected", {
                    "udids": udids,
                    "reason": "wifi_tunnel_stopped",
                })
            except Exception:
                _tunnel_logger.exception("WiFi cleanup: broadcast failed")
    except Exception:
        _tunnel_logger.exception("WiFi cleanup step failed")
    return udids


async def _tunnel_watchdog() -> None:
    """Poll the tunnel subprocess; if it dies unexpectedly (e.g. WiFi blip,
    iPhone locked, admin revoked) while we still think it is running, clean
    up any dependent WiFi connections so the UI can recover gracefully."""
    try:
        while True:
            await asyncio.sleep(2.0)
            proc = _tunnel.proc
            if proc is None:
                return
            if proc.poll() is None:
                continue  # still alive
            _tunnel_logger.warning(
                "Tunnel subprocess exited (code=%s); entering 5s grace period before cleanup",
                proc.returncode,
            )
            # Grace window: warn the UI but don't kill the engine yet.
            # A brief WiFi blip sometimes lets the subprocess self-recover;
            # if it does (e.g. restarted via /start) we avoid a false disconnect.
            try:
                from api.websocket import broadcast
                await broadcast("tunnel_degraded", {"reason": "subprocess_exited"})
            except Exception:
                _tunnel_logger.exception("Failed to emit tunnel_degraded event")

            await asyncio.sleep(5.0)

            async with _tunnel.lock:
                # Recovered in the meantime — a new proc was spawned.
                if _tunnel.proc is not proc and _tunnel.proc is not None and _tunnel.proc.poll() is None:
                    _tunnel_logger.info("Tunnel recovered within grace period; keeping engine alive")
                    try:
                        from api.websocket import broadcast
                        await broadcast("tunnel_recovered", {})
                    except Exception:
                        pass
                    return
                # Still down — now it's a real disconnect.
                if _tunnel.proc is proc or _tunnel.proc is None:
                    await _cleanup_wifi_connections()
                    _tunnel.proc = None
                    _tunnel.info = None
                    info_path = Path.home() / ".locwarp" / "wifi_tunnel_info.json"
                    if info_path.exists():
                        try:
                            info_path.unlink()
                        except OSError:
                            pass
                    try:
                        from api.websocket import broadcast
                        await broadcast("tunnel_lost", {"reason": "subprocess_exited"})
                    except Exception:
                        _tunnel_logger.exception("Failed to emit tunnel_lost event")
            return
    except asyncio.CancelledError:
        raise


@router.post("/wifi/tunnel/start")
async def wifi_tunnel_start(req: WifiTunnelStartRequest):
    """Start a WiFi tunnel subprocess (requires Python 3.13+ and admin)."""
    async with _tunnel.lock:
        if _tunnel.is_running():
            if _tunnel.info:
                return {"status": "already_running", **_tunnel.info}
            return {"status": "already_running"}

        stale_killed = _kill_stale_tunnel_processes()
        if stale_killed:
            _tunnel_logger.info("Cleaned up %d stale tunnel process(es)", stale_killed)
            await asyncio.sleep(1.5)

        bundled_tunnel = None
        if getattr(sys, "frozen", False):
            candidate = Path(sys.executable).resolve().parent.parent / "wifi-tunnel" / "wifi-tunnel.exe"
            if candidate.exists():
                bundled_tunnel = candidate

        resolved_udid = req.udid
        if not resolved_udid:
            try:
                dm = _dm()
                conns = list(dm._connections.keys())
                if conns:
                    resolved_udid = conns[0]
            except (RuntimeError, AttributeError):
                pass
        if not resolved_udid:
            resolved_udid = "auto"

        if bundled_tunnel is not None:
            cmd_parts = [str(bundled_tunnel), "--ip", req.ip, "--port", str(req.port), "--udid", resolved_udid]
        else:
            py = _find_python313()
            if py is None:
                raise HTTPException(
                    status_code=500,
                    detail={"code": "python313_missing", "message": "需要 Python 3.13+ 才能啟動 WiFi Tunnel"},
                )
            script = Path(__file__).resolve().parent.parent.parent / "wifi_tunnel.py"
            if not script.exists():
                raise HTTPException(status_code=500, detail={"code": "tunnel_script_missing", "message": f"找不到 wifi_tunnel.py:{script}"})
            cmd_parts = py + [str(script), "--ip", req.ip, "--port", str(req.port), "--udid", resolved_udid]

        _tunnel_logger.info("Starting WiFi tunnel: %s", " ".join(cmd_parts))

        try:
            _tunnel.proc = subprocess.Popen(
                cmd_parts,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except (OSError, FileNotFoundError) as e:
            raise HTTPException(status_code=500, detail={"code": "tunnel_spawn_failed", "message": f"無法啟動 tunnel 進程:{e}"})

        info_path = Path.home() / ".locwarp" / "wifi_tunnel_info.json"
        for _ in range(40):
            await asyncio.sleep(0.5)
            if _tunnel.proc.poll() is not None:
                output = _tunnel.proc.stdout.read() if _tunnel.proc.stdout else ""
                _tunnel.proc = None
                # Provide actionable message for the most common failure modes
                tail = output[-800:]
                if "ConnectionTerminated" in output or "connection_terminated" in output.lower():
                    friendly = (
                        "裝置已透過 tunneld 建立連線，拒絕第二條 RemotePairing 通道。\n"
                        "請先停止 tunneld（關閉執行 tunneld 的終端機視窗），再重試 WiFi Tunnel。\n"
                        f"原始訊息：{tail[-300:]}"
                    )
                    raise HTTPException(status_code=409, detail={"code": "tunnel_already_connected", "message": friendly})
                if "PasswordRequired" in output or "password" in output.lower():
                    friendly = f"Tunnel 需要管理員密碼，請確認以 sudo 執行。\n原始訊息：{tail[-300:]}"
                    raise HTTPException(status_code=403, detail={"code": "tunnel_password_required", "message": friendly})
                raise HTTPException(
                    status_code=500,
                    detail={"code": "tunnel_exited", "message": f"Tunnel 進程異常結束:\n{tail}"},
                )
            if info_path.exists():
                try:
                    data = json.loads(info_path.read_text())
                    _tunnel.info = data
                    _tunnel_logger.info("WiFi tunnel started: %s", data)
                    if _tunnel.watchdog_task is None or _tunnel.watchdog_task.done():
                        _tunnel.watchdog_task = asyncio.create_task(_tunnel_watchdog())
                    return {"status": "started", **data}
                except json.JSONDecodeError:
                    continue

        if _tunnel.is_running():
            try:
                _tunnel.proc.terminate()
            except OSError:
                pass
        _tunnel.proc = None
        raise HTTPException(status_code=500, detail={"code": "tunnel_timeout", "message": "Tunnel 啟動逾時(20 秒)"})


@router.get("/wifi/tunnel/status")
async def wifi_tunnel_status():
    """Check if the WiFi tunnel subprocess is running."""
    if not _tunnel.is_running():
        _tunnel.proc = None
        _tunnel.info = None
        return {"running": False}
    return {"running": True, **(_tunnel.info or {})}


@router.post("/wifi/tunnel/stop")
async def wifi_tunnel_stop():
    """Stop the WiFi tunnel subprocess and clean up any network-based
    device connections that were routed through it."""
    from main import app_state
    dm = _dm()

    async with _tunnel.lock:
        await _cleanup_wifi_connections()

        if not _tunnel.is_running():
            _tunnel.proc = None
            _tunnel.info = None
            return {"status": "not_running"}

        # Cancel watchdog first so it doesn't race on our cleanup
        if _tunnel.watchdog_task and not _tunnel.watchdog_task.done():
            _tunnel.watchdog_task.cancel()

        try:
            _tunnel.proc.terminate()
            try:
                _tunnel.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                _tunnel.proc.kill()
        except OSError:
            _tunnel_logger.exception("Failed to terminate tunnel process")

        _tunnel.proc = None
        _tunnel.info = None

    info_path = Path.home() / ".locwarp" / "wifi_tunnel_info.json"
    if info_path.exists():
        try:
            info_path.unlink()
        except OSError:
            pass

    # Try to fall back to USB if a device is still plugged in.
    # Keep both connect() and engine creation atomic under the tunnel lock —
    # if engine creation fails, roll back the connection so the device list
    # doesn't advertise a connected device with no engine behind it.
    try:
        devices = await dm.discover_devices()
        usb_dev = next((d for d in devices if d.connection_type != "Network"), None)
        if usb_dev:
            try:
                await dm.connect(usb_dev.udid)
            except Exception:
                _tunnel_logger.exception("USB fallback: connect failed for %s", usb_dev.udid)
                usb_dev = None
            if usb_dev is not None:
                try:
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
                    app_state.simulation_engine = None
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

    return {"status": "stopped"}


@router.post("/wifi/tunnel/start-and-connect")
async def wifi_tunnel_start_and_connect(req: WifiTunnelStartRequest):
    """Start a WiFi tunnel and immediately connect the device through it."""
    from main import app_state

    # Start the tunnel
    tunnel_result = await wifi_tunnel_start(req)
    if tunnel_result.get("status") not in ("started", "already_running"):
        raise HTTPException(status_code=500, detail="Tunnel failed to start")

    rsd_address = tunnel_result.get("rsd_address")
    rsd_port = tunnel_result.get("rsd_port")

    if not rsd_address or not rsd_port:
        raise HTTPException(status_code=500, detail="Tunnel started but no RSD info available")

    # Connect through the tunnel
    dm = _dm()
    try:
        info = await dm.connect_wifi_tunnel(rsd_address, rsd_port)
        await app_state.create_engine_for_device(info.udid)
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
        raise HTTPException(status_code=500, detail=f"Tunnel started but connection failed: {e}")


# ── Generic UDID routes (MUST be defined after all specific /wifi/* routes
#    so that /wifi/* paths do not accidentally match {udid}). ─────────────

@router.post("/{udid}/connect")
async def connect_device(udid: str):
    from main import app_state
    dm = _dm()
    try:
        await dm.connect(udid)
        await app_state.create_engine_for_device(udid)
        return {"status": "connected", "udid": udid}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{udid}/connect")
async def disconnect_device(udid: str):
    dm = _dm()
    await dm.disconnect(udid)
    return {"status": "disconnected", "udid": udid}


@router.get("/{udid}/info", response_model=DeviceInfo | None)
async def device_info(udid: str):
    dm = _dm()
    devices = await dm.discover_devices()
    for d in devices:
        if d.udid == udid:
            return d
    raise HTTPException(status_code=404, detail="Device not found")
