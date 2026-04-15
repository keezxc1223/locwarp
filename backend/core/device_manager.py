"""
LocWarp Device Manager

Handles iOS device detection, connection lifecycle, tunnel establishment,
and location service creation.  Wraps pymobiledevice3 internals so the
rest of the application never touches low-level device APIs directly.

Supports both USB and WiFi connections.  ``list_devices()`` from usbmuxd
returns devices with ``connection_type`` of ``"USB"`` or ``"Network"``.
WiFi requires the device to be paired and on the same local network.

For iOS 17+, a TCP tunnel via CoreDeviceTunnelProxy is established first,
then a RemoteServiceDiscoveryService (RSD) is created over the tunnel to
access DVT services.  This requires administrator privileges on Windows.
"""

from __future__ import annotations

import asyncio
import logging
import socket
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional

from pymobiledevice3.lockdown import create_using_usbmux, create_using_tcp
from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
from pymobiledevice3.remote.tunnel_service import CoreDeviceTunnelProxy
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
from pymobiledevice3.services.simulate_location import DtSimulateLocation
from pymobiledevice3.usbmux import list_devices

from models.schemas import DeviceInfo
from services.location_service import (
    DvtLocationService,
    LegacyLocationService,
    LocationService,
)


class UnsupportedIosVersionError(RuntimeError):
    """Raised when a connecting device's iOS version is below the minimum
    supported by LocWarp (currently 16.0). Surfaces a structured error to
    the API layer so the frontend can show an actionable message rather
    than a stack trace."""

    MIN_VERSION = "16.0"

    def __init__(self, version: str) -> None:
        self.version = version
        super().__init__(f"iOS {version} is not supported (requires {self.MIN_VERSION}+)")

logger = logging.getLogger(__name__)


def _parse_ios_version(version_string: str) -> tuple[int, ...]:
    """Convert an iOS version string like '17.4.1' into a comparable tuple."""
    try:
        return tuple(int(p) for p in version_string.split("."))
    except (ValueError, AttributeError):
        logger.warning("Unable to parse iOS version '%s', assuming 0.0", version_string)
        return (0, 0)


@dataclass
class _ActiveConnection:
    """Internal bookkeeping for a single connected device."""
    udid: str
    lockdown: object  # LockdownClient or RemoteServiceDiscoveryService
    ios_version: str
    connection_type: str = "USB"  # "USB" or "Network"
    dvt_provider: Optional[DvtProvider] = None
    tunnel_proxy: Optional[CoreDeviceTunnelProxy] = None
    tunnel_context: object = None  # async context manager for the tunnel
    rsd: Optional[RemoteServiceDiscoveryService] = None
    location_service: Optional[LocationService] = None
    usbmux_lockdown: object = None  # Original lockdown client (for legacy fallback on iOS 17+)


class DeviceManager:
    """
    Manages the full lifecycle of iOS device connections.

    Usage::

        dm = DeviceManager()
        devices = await dm.discover_devices()
        await dm.connect(devices[0].udid)
        loc = await dm.get_location_service(devices[0].udid)
        await loc.set(37.7749, -122.4194)
        await dm.disconnect(devices[0].udid)
    """

    def __init__(self) -> None:
        self._connections: Dict[str, _ActiveConnection] = {}
        self._lock = asyncio.Lock()
        # Serialise DDI downloads/mounts across devices. Without this, two
        # parallel connects on a fresh machine race to write the same DDI
        # cache path and corrupt each other.
        self._ddi_mount_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    async def discover_devices(self) -> list[DeviceInfo]:
        """
        Scan for all iOS devices visible over USB and WiFi (usbmuxd).

        usbmuxd returns both USB-connected and WiFi-paired devices on
        the same network.  Each device carries a ``connection_type`` of
        ``"USB"`` or ``"Network"``.

        Returns a list of ``DeviceInfo`` objects with basic identification
        data.  This does **not** establish a persistent connection.
        """
        devices: list[DeviceInfo] = []
        seen_udids: set[str] = set()

        try:
            raw_devices = await list_devices()
        except Exception:
            logger.exception("Failed to list usbmux devices")
            return devices

        for raw in raw_devices:
            try:
                conn_type = getattr(raw, "connection_type", "USB")
                # If we already saw this device via USB, skip the Network duplicate
                if raw.serial in seen_udids:
                    # But upgrade to USB if this entry is USB (prefer USB info)
                    if conn_type == "USB":
                        for d in devices:
                            if d.udid == raw.serial:
                                d.connection_type = "USB"
                    continue
                seen_udids.add(raw.serial)

                lockdown = await create_using_usbmux(serial=raw.serial)
                all_values = lockdown.all_values
                # If device is already connected, report the active connection type
                active_conn = self._connections.get(raw.serial)
                if active_conn:
                    conn_type = active_conn.connection_type
                info = DeviceInfo(
                    udid=raw.serial,
                    name=all_values.get("DeviceName", "Unknown"),
                    ios_version=all_values.get("ProductVersion", "0.0"),
                    connection_type=conn_type,
                )
                info.is_connected = raw.serial in self._connections
                devices.append(info)
                logger.debug("Discovered device %s (%s) running iOS %s via %s (connected=%s)",
                             info.name, info.udid, info.ios_version, conn_type, info.is_connected)
            except Exception:
                logger.exception("Failed to query device %s", getattr(raw, "serial", "?"))

        return devices

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    async def connect(self, udid: str) -> None:
        """
        Establish a connection appropriate for the device's iOS version.

        Supports both USB and WiFi (Network) connections via usbmuxd.

        * **iOS 17+** -- TCP tunnel via CoreDeviceTunnelProxy + RSD.
        * **iOS 16.x** -- plain lockdown over usbmux + legacy location service.
        """
        async with self._lock:
            if udid in self._connections:
                logger.info("Device %s is already connected", udid)
                return

        # Detect connection type from usbmux device list.
        connection_type = "USB"
        try:
            raw_devices = await list_devices()
            for raw in raw_devices:
                if raw.serial == udid:
                    connection_type = getattr(raw, "connection_type", "USB")
                    # Prefer USB if device shows up as both
                    if connection_type == "USB":
                        break
        except Exception:
            logger.debug("Could not determine connection type for %s, assuming USB", udid)

        logger.info("Connecting to %s via %s", udid, connection_type)

        # Create a fresh lockdown client to read the iOS version.
        try:
            lockdown = await create_using_usbmux(serial=udid)
        except Exception:
            logger.exception("Cannot create lockdown client for %s via %s", udid, connection_type)
            raise

        ios_version_str: str = lockdown.all_values.get("ProductVersion", "0.0")
        ver = _parse_ios_version(ios_version_str)

        if ver < (16, 0):
            logger.warning(
                "Refusing connect: %s reports iOS %s, below minimum %s",
                udid, ios_version_str, UnsupportedIosVersionError.MIN_VERSION,
            )
            raise UnsupportedIosVersionError(ios_version_str)

        if ver >= (17, 0):
            conn = await self._connect_tunnel(udid, lockdown, ios_version_str)
        else:
            conn = self._connect_legacy(udid, lockdown, ios_version_str)
        conn.connection_type = connection_type

        async with self._lock:
            self._connections[udid] = conn

        logger.info("Connected to %s (iOS %s) via %s", udid, ios_version_str, connection_type)

    # -- iOS 17+ via CoreDeviceTunnelProxy ---------------------------------

    async def _connect_tunnel(
        self, udid: str, lockdown, ios_version: str
    ) -> _ActiveConnection:
        """TCP tunnel for iOS 17+ using CoreDeviceTunnelProxy + RSD."""
        logger.debug("Establishing TCP tunnel for %s (iOS %s)", udid, ios_version)

        try:
            proxy = await CoreDeviceTunnelProxy.create(lockdown)
            tunnel_ctx = proxy.start_tcp_tunnel()
            tunnel_result = await tunnel_ctx.__aenter__()

            logger.info("Tunnel established for %s: %s:%s",
                        udid, tunnel_result.address, tunnel_result.port)

            # Create RSD over the tunnel
            rsd = RemoteServiceDiscoveryService((tunnel_result.address, tunnel_result.port))
            await rsd.connect()
            logger.info("RSD connected for %s", udid)

            return _ActiveConnection(
                udid=udid,
                lockdown=rsd,
                ios_version=ios_version,
                tunnel_proxy=proxy,
                tunnel_context=tunnel_ctx,
                rsd=rsd,
                usbmux_lockdown=lockdown,
            )
        except Exception:
            logger.exception(
                "TCP tunnel failed for %s (iOS %s). "
                "Ensure you are running as administrator.",
                udid, ios_version,
            )
            raise RuntimeError(
                f"無法建立裝置通道 (iOS {ios_version})。"
                f"請以系統管理員身份執行 LocWarp。"
            )

    # iOS < 17 path removed in v0.1.49 — see UnsupportedIosVersionError.

    def _connect_legacy(
        self, udid: str, lockdown, ios_version: str
    ) -> _ActiveConnection:
        """Direct usbmux lockdown connection for iOS 16.x devices."""
        logger.info("Using legacy lockdown connection for %s (iOS %s)", udid, ios_version)
        return _ActiveConnection(
            udid=udid,
            lockdown=lockdown,
            ios_version=ios_version,
            usbmux_lockdown=lockdown,
        )

    # ------------------------------------------------------------------
    # Disconnection
    # ------------------------------------------------------------------

    async def disconnect(self, udid: str) -> None:
        """Tear down the connection and clean up resources for *udid*."""
        async with self._lock:
            conn = self._connections.pop(udid, None)

        if conn is None:
            logger.warning("Disconnect requested for unknown device %s", udid)
            return

        # Clear any active location simulation first.
        if conn.location_service is not None:
            try:
                await conn.location_service.clear()
            except Exception:
                logger.exception("Error clearing location on disconnect for %s", udid)

        # Shut down the DVT provider if it was opened.
        if conn.dvt_provider is not None:
            try:
                await conn.dvt_provider.__aexit__(None, None, None)
            except Exception:
                logger.exception("Error closing DvtProvider for %s", udid)

        # Close RSD.
        if conn.rsd is not None:
            try:
                await conn.rsd.close()
            except Exception:
                logger.exception("Error closing RSD for %s", udid)

        # Close tunnel context.
        if conn.tunnel_context is not None:
            try:
                await conn.tunnel_context.__aexit__(None, None, None)
            except Exception:
                logger.exception("Error closing tunnel for %s", udid)

        # Close tunnel proxy.
        if conn.tunnel_proxy is not None:
            try:
                conn.tunnel_proxy.close()
            except Exception:
                logger.exception("Error closing tunnel proxy for %s", udid)

        logger.info("Disconnected device %s", udid)

    # ------------------------------------------------------------------
    # Location service
    # ------------------------------------------------------------------

    async def get_location_service(self, udid: str) -> LocationService:
        """
        Return a ``LocationService`` instance for the given device.

        The concrete type depends on the iOS version:

        * iOS 17+  ->  ``DvtLocationService`` (uses DVT instrumentation)
        * iOS < 17 ->  ``LegacyLocationService`` (uses DtSimulateLocation)

        The service is cached on the connection so subsequent calls are cheap.
        """
        async with self._lock:
            conn = self._connections.get(udid)

        if conn is None:
            raise RuntimeError(
                f"Device {udid} is not connected. Call connect() first."
            )

        if conn.location_service is not None:
            return conn.location_service

        ver = _parse_ios_version(conn.ios_version)
        if ver >= (17, 0):
            loc = await self._create_dvt_location_service(conn)
        else:
            loc = await self._create_legacy_location_service(conn)
        conn.location_service = loc
        return loc

    async def _ensure_personalized_ddi_mounted(self, conn: _ActiveConnection) -> None:
        """For iOS 17+ devices, make sure the Personalized Developer Disk Image
        is mounted. Without the DDI, the DVT service hub won't advertise and
        DvtProvider will fail with "No such service: com.apple.instruments.dtservicehub".

        If already mounted, this is a no-op. Otherwise it downloads the image
        from the pymobiledevice3 DDI repository (GitHub) and mounts it. The
        per-device signing (TSS) is handled internally by pymobiledevice3.
        """
        try:
            from pymobiledevice3.services.mobile_image_mounter import (
                MobileImageMounterService,
                auto_mount_personalized,
                AlreadyMountedError,
            )
        except ImportError:
            logger.warning("pymobiledevice3 mobile_image_mounter not available; skipping DDI mount")
            return

        # 1. Check whether a Personalized image is already mounted.
        try:
            mounter = MobileImageMounterService(lockdown=conn.lockdown)
            try:
                await mounter.connect()
                if await mounter.is_image_mounted("Personalized"):
                    logger.debug("Personalized DDI already mounted on %s", conn.udid)
                    return
            finally:
                try:
                    await mounter.close()
                except Exception:
                    pass
        except Exception:
            logger.warning("Could not query image mount status; will attempt to mount anyway", exc_info=True)

        # 2. Not mounted — download + mount. Notify frontend so the user
        # sees a "preparing device" overlay instead of a frozen UI.
        logger.info("Personalized DDI not mounted on %s; mounting (may download ~20MB)...", conn.udid)
        try:
            from api.websocket import broadcast
            await broadcast("ddi_mounting", {"udid": conn.udid})
        except Exception:
            pass
        mount_succeeded = False
        try:
            # auto_mount_personalized internally uses requests.get for the
            # GitHub DDI download. Hard-cap the whole operation so a slow or
            # blocked network can't freeze us indefinitely.
            # Serialise across devices so parallel connects don't corrupt
            # the shared DDI cache.
            async with self._ddi_mount_lock:
                await asyncio.wait_for(auto_mount_personalized(conn.lockdown), timeout=120.0)
            logger.info("Personalized DDI mounted successfully for %s", conn.udid)
            mount_succeeded = True
        except AlreadyMountedError:
            logger.info("DDI was mounted concurrently for %s", conn.udid)
            mount_succeeded = True
        except asyncio.TimeoutError:
            logger.error("DDI mount timed out after 120s for %s", conn.udid)
            try:
                from api.websocket import broadcast
                await broadcast("ddi_mount_failed", {
                    "udid": conn.udid,
                    "error": "DDI download/mount timed out (120s). Check network access to github.com.",
                })
            except Exception:
                pass
            raise RuntimeError("DDI mount timed out — check network access to github.com")
        except Exception as exc:
            logger.exception("auto_mount_personalized failed for %s", conn.udid)
            try:
                from api.websocket import broadcast
                await broadcast("ddi_mount_failed", {
                    "udid": conn.udid,
                    "error": f"{exc.__class__.__name__}: {exc}",
                })
            except Exception:
                pass
            raise
        finally:
            if mount_succeeded:
                try:
                    from api.websocket import broadcast
                    await broadcast("ddi_mounted", {"udid": conn.udid})
                except Exception:
                    pass

    async def _ensure_classic_ddi_mounted(self, conn: _ActiveConnection) -> None:
        """Best-effort Developer Disk Image mount for iOS 16.x devices."""
        try:
            import pymobiledevice3.services.mobile_image_mounter as mim
        except ImportError:
            logger.warning("mobile_image_mounter not available; skipping classic DDI mount")
            return

        mounter_cls = getattr(mim, "MobileImageMounterService", None)
        if mounter_cls is not None:
            try:
                mounter = mounter_cls(lockdown=conn.lockdown)
                try:
                    await mounter.connect()
                    if await mounter.is_image_mounted("Developer"):
                        logger.debug("Classic DDI already mounted on %s", conn.udid)
                        return
                finally:
                    try:
                        await mounter.close()
                    except Exception:
                        pass
            except Exception:
                logger.warning("Could not query classic DDI mount state", exc_info=True)

        mount_fn = None
        for name in ("auto_mount_developer", "auto_mount", "auto_mount_disk_image"):
            candidate = getattr(mim, name, None)
            if callable(candidate):
                mount_fn = candidate
                break
        if mount_fn is None:
            logger.warning("No classic DDI auto-mount helper found; continuing without mount")
            return

        logger.info("Classic DDI not mounted on %s; attempting auto-mount", conn.udid)
        try:
            from api.websocket import broadcast
            await broadcast("ddi_mounting", {"udid": conn.udid})
        except Exception:
            pass

        mounted = False
        try:
            await asyncio.wait_for(mount_fn(conn.lockdown), timeout=120.0)
            mounted = True
            logger.info("Classic DDI mounted successfully for %s", conn.udid)
        except Exception:
            logger.warning("Classic DDI auto-mount failed for %s", conn.udid, exc_info=True)
        finally:
            try:
                from api.websocket import broadcast
                event = "ddi_mounted" if mounted else "ddi_mount_failed"
                payload = {"udid": conn.udid}
                if not mounted:
                    payload["error"] = "Classic DDI mount failed"
                await broadcast(event, payload)
            except Exception:
                pass

    async def _create_dvt_location_service(
        self, conn: _ActiveConnection
    ) -> DvtLocationService:
        """Spin up a DVT provider and hand it to ``DvtLocationService``.

        If DVT fails because the Developer Disk Image is not mounted,
        we try to mount it automatically and retry once.
        """
        # Try to mount DDI proactively (fast no-op when already mounted).
        try:
            await self._ensure_personalized_ddi_mounted(conn)
        except Exception:
            logger.warning("DDI auto-mount failed; DVT may still fail", exc_info=True)

        try:
            dvt = DvtProvider(conn.lockdown)
            await dvt.__aenter__()
            conn.dvt_provider = dvt
            logger.debug("DVT provider opened for %s", conn.udid)
            return DvtLocationService(dvt, lockdown=conn.lockdown)
        except Exception as dvt_exc:
            logger.warning(
                "DVT location service failed for %s (%s). Falling back to "
                "legacy DtSimulateLocation over lockdown.",
                conn.udid, dvt_exc,
            )
            # iOS 17+ still exposes com.apple.dt.simulatelocation on some
            # devices (reported working on iOS 26 by multiple users), so
            # try the legacy service before giving up entirely.
            try:
                # Prefer the original usbmux/TCP lockdown for DtSimulateLocation;
                # fall back to whatever we have stored if not available.
                legacy_lockdown = conn.usbmux_lockdown or conn.lockdown
                legacy = LegacyLocationService(legacy_lockdown)
                logger.info("Using LegacyLocationService fallback for %s", conn.udid)
                return legacy
            except Exception:
                logger.exception(
                    "Both DVT and legacy location services failed for %s", conn.udid
                )
                raise dvt_exc

    async def _create_legacy_location_service(
        self, conn: _ActiveConnection
    ) -> LegacyLocationService:
        """Build the legacy location service for iOS 16.x devices."""
        try:
            await self._ensure_classic_ddi_mounted(conn)
        except Exception:
            logger.warning("Classic DDI auto-mount failed; legacy location may still fail", exc_info=True)
        logger.info("Using LegacyLocationService for %s", conn.udid)
        return LegacyLocationService(conn.lockdown)

    # _ensure_classic_ddi_mounted, _create_legacy_location_service, and
    # connect_wifi (legacy direct-IP WiFi) removed in v0.1.49 — see
    # UnsupportedIosVersionError. iOS 17+ continues to use the
    # personalized DDI mount path + DvtLocationService (with
    # LegacyLocationService as a runtime fallback inside
    # _create_dvt_location_service when DVT itself fails).

    # ------------------------------------------------------------------
    # WiFi connection (iOS 17+ tunnel only)
    # ------------------------------------------------------------------

    async def connect_wifi_tunnel(
        self, rsd_address: str, rsd_port: int
    ) -> DeviceInfo:
        """Connect to a device via an existing WiFi tunnel.

        Use this when a WiFi tunnel has already been established by
        ``wifi_tunnel.py`` (or ``pymobiledevice3 remote start-tunnel``).
        The caller provides the RSD address and port printed by the
        tunnel process.

        Returns a ``DeviceInfo`` describing the connected device.
        """
        logger.info("Connecting via WiFi tunnel RSD at %s:%d", rsd_address, rsd_port)

        import asyncio as _asyncio
        rsd = None
        last_exc: Exception | None = None
        # TUN interface routes may take a few seconds to become reachable
        # after the tunnel process reports ready, so retry with backoff.
        for attempt in range(1, 11):
            rsd = RemoteServiceDiscoveryService((rsd_address, rsd_port))
            try:
                await rsd.connect()
                last_exc = None
                break
            except Exception as exc:
                last_exc = exc
                logger.warning(
                    "RSD connect attempt %d/10 failed (%s): %s",
                    attempt, exc.__class__.__name__, exc,
                )
                try:
                    await rsd.close()
                except (OSError, ConnectionError):
                    pass
                await _asyncio.sleep(min(0.5 * attempt, 2.0))

        if last_exc is not None:
            logger.error("Failed to connect to RSD at %s:%d after retries", rsd_address, rsd_port)
            raise RuntimeError(
                f"無法連線到 WiFi tunnel RSD ({rsd_address}:{rsd_port})。"
                "請確認 wifi_tunnel.py 正在執行且 tunnel 仍然活躍。"
            ) from last_exc

        peer = rsd.peer_info or {}
        props = peer.get("Properties", {})
        udid = props.get("UniqueDeviceID", "")
        ios_version_str = props.get("OSVersion", "0.0")
        device_name = props.get("DeviceClass", "iPhone")

        if udid in self._connections:
            await self.disconnect(udid)

        conn = _ActiveConnection(
            udid=udid,
            lockdown=rsd,
            ios_version=ios_version_str,
            connection_type="Network",
            rsd=rsd,
        )

        async with self._lock:
            self._connections[udid] = conn

        logger.info("WiFi tunnel connected to %s (iOS %s)", udid, ios_version_str)

        return DeviceInfo(
            udid=udid,
            name=device_name,
            ios_version=ios_version_str,
            connection_type="Network",
            is_connected=True,
        )

    async def scan_wifi_devices(
        self,
        subnet: str | None = None,
        timeout: float = 0.5,
    ) -> list[dict]:
        """Scan the local network for iOS devices on port 62078 (lockdownd).

        Tries each IP in the subnet concurrently.  Returns a list of
        ``{"ip": ..., "name": ..., "udid": ...}`` dicts for reachable
        devices.

        If *subnet* is not given, the local machine's subnet is guessed
        from the default route interface.
        """
        if subnet is None:
            subnet = _guess_local_subnet()
            if subnet is None:
                logger.warning("Cannot determine local subnet for WiFi scan")
                return []

        logger.info("Scanning subnet %s for iOS devices...", subnet)

        # Generate IPs: e.g. "192.168.1" → .1 to .254
        base = subnet.rsplit(".", 1)[0]
        ips = [f"{base}.{i}" for i in range(1, 255)]

        async def _probe(ip: str) -> dict | None:
            try:
                _, writer = await asyncio.wait_for(
                    asyncio.open_connection(ip, 62078),
                    timeout=timeout,
                )
                writer.close()
                await writer.wait_closed()
                # Port is open — try a quick lockdown to get device info
                try:
                    pair_rec = _load_pair_record()
                    lockdown = await asyncio.wait_for(
                        create_using_tcp(
                            ip,
                            pair_record=pair_rec,
                            autopair=pair_rec is None,
                        ),
                        timeout=5.0,
                    )
                    vals = lockdown.all_values
                    return {
                        "ip": ip,
                        "name": vals.get("DeviceName", "Unknown"),
                        "udid": vals.get("UniqueDeviceID", lockdown.udid or ""),
                        "ios_version": vals.get("ProductVersion", "0.0"),
                    }
                except Exception:
                    # Port open but lockdown failed — still report it
                    return {"ip": ip, "name": "iOS Device", "udid": "", "ios_version": ""}
            except (OSError, asyncio.TimeoutError):
                return None

        results = await asyncio.gather(*[_probe(ip) for ip in ips])
        found = [r for r in results if r is not None]
        logger.info("WiFi scan found %d device(s)", len(found))
        return found

    # ------------------------------------------------------------------
    # Utilities
    # ------------------------------------------------------------------

    @property
    def connected_udids(self) -> list[str]:
        """Return the UDIDs of all currently connected devices."""
        return list(self._connections.keys())

    def is_connected(self, udid: str) -> bool:
        """Check whether a device is currently connected."""
        return udid in self._connections

    def get_connection_type(self, udid: str) -> str:
        """Return ``'USB'`` or ``'Network'`` for a connected device."""
        conn = self._connections.get(udid)
        return conn.connection_type if conn else "USB"

    async def disconnect_all(self) -> None:
        """Disconnect every active device."""
        udids = list(self._connections.keys())
        for udid in udids:
            await self.disconnect(udid)
        logger.info("All devices disconnected")


def _load_pair_record(udid: str | None = None) -> dict | None:
    """Load a USB pair record from Apple's system Lockdown store.

    On Windows, pair records live in ``%ALLUSERSPROFILE%\\Apple\\Lockdown``.
    If *udid* is given, loads that specific record; otherwise loads the
    first ``.plist`` found (most setups have only one device).
    """
    import os
    import plistlib

    lockdown_dir = Path(os.environ.get("ALLUSERSPROFILE", "C:/ProgramData")) / "Apple" / "Lockdown"
    if not lockdown_dir.exists():
        logger.debug("Apple Lockdown directory not found: %s", lockdown_dir)
        return None

    target: Path | None = None
    if udid:
        candidate = lockdown_dir / f"{udid}.plist"
        if candidate.exists():
            target = candidate
    else:
        # Pick the first device plist (skip SystemConfiguration.plist)
        for f in lockdown_dir.glob("*.plist"):
            if f.stem != "SystemConfiguration":
                target = f
                break

    if target is None:
        logger.debug("No pair record found in %s", lockdown_dir)
        return None

    try:
        with open(target, "rb") as fh:
            record = plistlib.load(fh)
        logger.debug("Loaded pair record from %s", target)
        return record
    except Exception:
        logger.exception("Failed to load pair record from %s", target)
        return None


def _guess_local_subnet() -> str | None:
    """Best-effort guess of the local LAN subnet (e.g. '192.168.1.0/24').

    Returns the base IP like '192.168.1.0' or ``None`` if unable to determine.
    """
    try:
        # Open a UDP socket to a public IP (doesn't actually send)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        # Return the /24 base
        parts = local_ip.rsplit(".", 1)
        return f"{parts[0]}.0"
    except (OSError, IndexError):
        return None
