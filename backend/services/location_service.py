"""
LocWarp Location Service

Provides a unified interface for iOS location simulation across different
iOS versions, wrapping pymobiledevice3's location simulation capabilities.
"""

from __future__ import annotations

import logging
import struct
from abc import ABC, abstractmethod
from typing import Awaitable, Callable

import asyncio

from pymobiledevice3.exceptions import ConnectionFailedError, ConnectionTerminatedError
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
from pymobiledevice3.services.simulate_location import DtSimulateLocation

logger = logging.getLogger(__name__)

# Failures of one legacy command that are worth another try on a fresh
# connection: socket errors, the device closing or refusing the connection,
# and a command that hangs.
_LEGACY_TRANSIENT_ERRORS = (
    OSError, EOFError, ConnectionTerminatedError, ConnectionFailedError,
    asyncio.TimeoutError,
)


class DeviceLostError(RuntimeError):
    """Raised when a location service determines the underlying device
    connection is no longer recoverable (e.g. USB unplugged, tunnel dead).
    Callers should drop any cached engine/connection and force a fresh
    discover+connect on the next user action.

    The optional ``reason`` slot categorises the root cause so the API
    layer can pick a specific user-facing message:

    * ``tunnel_dead``   — WiFi tunnel (RemotePairing) is gone
    * ``lockdown_dead`` — RSD / lockdown is unreachable but tunnel is up
    * ``ddi_missing``   — Personalized DDI is no longer mounted
    * ``usb_gone``      — USB cable disconnected / device removed
    * ``unknown``       — fallback when the cause cannot be classified
    """

    REASON_TUNNEL_DEAD = "tunnel_dead"
    REASON_LOCKDOWN_DEAD = "lockdown_dead"
    REASON_DDI_MISSING = "ddi_missing"
    REASON_USB_GONE = "usb_gone"
    REASON_UNKNOWN = "unknown"

    def __init__(self, *args, reason: str = "unknown") -> None:
        super().__init__(*args)
        self.reason = reason


class LocationService(ABC):
    """
    Abstract base for location simulation services.

    Subclasses implement version-specific simulation using either the DVT
    instrumentation channel (iOS 17+) or the legacy DtSimulateLocation
    service (iOS < 17).
    """

    @abstractmethod
    async def set(self, lat: float, lng: float) -> None:
        """Simulate the device location to the given coordinates."""

    @abstractmethod
    async def clear(self) -> None:
        """Stop simulating and restore the real device location."""


class DvtLocationService(LocationService):
    """
    Location simulation for iOS 17+ devices via the DVT LocationSimulation
    instrument.

    Holds a reference to the underlying lockdown/RSD service so it can
    fully recreate the DvtProvider when the channel drops (e.g. screen
    lock over WiFi).

    Parameters
    ----------
    dvt_provider
        An active DvtProvider session connected to the target device.
    lockdown
        The lockdown or RSD service used to create the DvtProvider.
        Needed for the legacy reconnect path when no factory is supplied.
    dvt_factory
        Async callable returning a fresh DvtProvider for this device.
        When provided (the preferred path), ``_reconnect`` defers to it
        instead of rebuilding directly from the cached lockdown — this
        lets device_manager wait for an in-flight WiFi tunnel restart
        and hand back a DvtProvider built on the live lockdown.
    """

    def __init__(
        self,
        dvt_provider: DvtProvider,
        lockdown=None,
        dvt_factory: Callable[[], Awaitable[DvtProvider]] | None = None,
    ) -> None:
        self._dvt = dvt_provider
        self._lockdown = lockdown
        self._dvt_factory = dvt_factory
        self._location_sim: LocationSimulation | None = None
        self._active = False
        self._reconnect_lock = asyncio.Lock()

    async def _ensure_instrument(self) -> LocationSimulation:
        """Lazily create, connect, and cache the LocationSimulation instrument."""
        if self._location_sim is None:
            self._location_sim = LocationSimulation(self._dvt)
            await self._location_sim.connect()
            logger.debug("DVT LocationSimulation instrument initialised and connected")
        return self._location_sim

    async def _reconnect(self) -> None:
        """Tear down and fully recreate the DVT provider and instrument.

        Preferred path (``dvt_factory`` provided): defer rebuild to
        device_manager. The factory probes tunnel health, waits for any
        in-flight WiFi tunnel restart, and hands back a DvtProvider built
        on the *current* live lockdown. This is what aligns this service
        with the WiFi tunnel auto-recovery added in v0.2.119 — the cached
        ``self._lockdown`` reference can become an orphan after a tunnel
        restart, so we no longer rebuild against it directly.

        Legacy path (no factory): keeps the original ~2s fast-fail loop
        rebuilding from the cached lockdown, for callers that haven't
        wired up the factory yet (and for unit tests).
        """
        async with self._reconnect_lock:
            # Close the old DVT provider gracefully.
            try:
                await self._dvt.__aexit__(None, None, None)
            except Exception:
                logger.debug("Ignoring error while closing old DvtProvider")

            self._location_sim = None

            if self._dvt_factory is not None:
                try:
                    self._dvt = await self._dvt_factory()
                    logger.info("DVT provider re-acquired via factory")
                    return
                except DeviceLostError:
                    raise
                except Exception as exc:
                    logger.error("DVT factory raised: %s", exc)
                    raise DeviceLostError(
                        f"DVT factory failed: {exc}",
                        reason=DeviceLostError.REASON_LOCKDOWN_DEAD,
                    ) from exc

            if self._lockdown is None:
                raise DeviceLostError(
                    "Cannot reconnect DVT: no lockdown reference and no factory",
                    reason=DeviceLostError.REASON_LOCKDOWN_DEAD,
                )

            # Legacy fast-fail (kept only for back-compat).
            delays = [0.5, 1.5]
            last_exc: Exception | None = None
            for attempt, delay in enumerate(delays, start=1):
                try:
                    new_dvt = DvtProvider(self._lockdown)
                    await new_dvt.__aenter__()
                    self._dvt = new_dvt
                    logger.info("DVT provider reconnected on attempt %d", attempt)
                    return
                except Exception as exc:
                    last_exc = exc
                    logger.warning(
                        "DVT reconnect attempt %d/%d failed (%s); retrying in %.1fs",
                        attempt, len(delays), type(exc).__name__, delay,
                    )
                    await asyncio.sleep(delay)
            try:
                new_dvt = DvtProvider(self._lockdown)
                await new_dvt.__aenter__()
                self._dvt = new_dvt
                logger.info("DVT provider reconnected on final attempt")
                return
            except Exception as exc:
                last_exc = exc
            logger.error("DVT provider reconnect exhausted — device likely lost")
            raise DeviceLostError(
                f"DVT reconnect failed: {last_exc}",
                reason=DeviceLostError.REASON_LOCKDOWN_DEAD,
            ) from last_exc

    async def set(self, lat: float, lng: float) -> None:
        """Simulate the device location using the DVT instrument channel."""
        try:
            sim = await self._ensure_instrument()
            await sim.set(lat, lng)
            self._active = True
            logger.info("DVT location set to (%.6f, %.6f)", lat, lng)
        except (ConnectionTerminatedError, OSError, EOFError, BrokenPipeError,
                ConnectionResetError, asyncio.TimeoutError) as exc:
            logger.warning("DVT channel dropped (%s: %s); reconnecting and retrying",
                           type(exc).__name__, exc)
            await self._reconnect()
            sim = await self._ensure_instrument()
            await sim.set(lat, lng)
            self._active = True
            logger.info("DVT location set to (%.6f, %.6f) after reconnect", lat, lng)
        except Exception:
            logger.exception("Failed to set DVT simulated location")
            raise

    async def clear(self) -> None:
        """Clear the simulated location via the DVT instrument channel."""
        if not self._active:
            logger.debug("DVT clear called but no simulation is active")
            return
        try:
            sim = await self._ensure_instrument()
            await sim.clear()
            self._active = False
            logger.info("DVT simulated location cleared")
        except (ConnectionTerminatedError, OSError, EOFError, BrokenPipeError,
                ConnectionResetError, asyncio.TimeoutError) as exc:
            logger.warning("DVT channel dropped during clear (%s: %s); reconnecting",
                           type(exc).__name__, exc)
            await self._reconnect()
            sim = await self._ensure_instrument()
            await sim.clear()
            self._active = False
            logger.info("DVT simulated location cleared after reconnect")
        except Exception:
            logger.exception("Failed to clear DVT simulated location")
            raise


class LegacyLocationService(LocationService):
    """
    Location simulation for iOS < 17 devices via DtSimulateLocation.

    Parameters
    ----------
    lockdown_client
        A lockdown service provider (LockdownClient) for the target device.
    """

    SERVICE_NAME = DtSimulateLocation.SERVICE_NAME

    def __init__(self, lockdown_client) -> None:
        self._lockdown = lockdown_client
        self._active = False
        # Connections whose close is still in flight; the set only keeps the
        # tasks referenced until they finish.
        self._closing: set[asyncio.Task] = set()

    def _close_later(self, service) -> None:
        """Close a command connection without holding up the caller.

        The service takes one command per connection, and an iOS 16 device
        never answers the TLS close, so awaiting it costs the full 1 s close
        timeout on every position push: a 0.5 s tick turned into 1.08 s and
        the device fell behind the others on the same route (issue #51).
        """
        task = asyncio.create_task(service.close())
        self._closing.add(task)
        task.add_done_callback(self._closing.discard)

    async def _send(self, *chunks: bytes) -> None:
        """Open a fresh command connection and send ``chunks`` on it."""
        service = await self._lockdown.start_lockdown_developer_service(self.SERVICE_NAME)
        try:
            for chunk in chunks:
                await service.sendall(chunk)
        finally:
            self._close_later(service)

    async def _send_set(self, lat: float, lng: float) -> None:
        enc_lat = str(lat).encode()
        enc_lng = str(lng).encode()
        await self._send(
            struct.pack(">I", 0),
            struct.pack(">I", len(enc_lat)) + enc_lat,
            struct.pack(">I", len(enc_lng)) + enc_lng,
        )

    async def _send_clear(self) -> None:
        await self._send(struct.pack(">I", 1))

    # One command, connection setup included. A healthy iOS 16 device answers
    # in under 0.1 s; issue #51's log shows a stuck one hanging 7.5 s before
    # usbmuxd refused the connection.
    _SEND_TIMEOUT_S = 3.0
    _SEND_ATTEMPTS = 3

    async def set(self, lat: float, lng: float) -> None:
        """Simulate the device location using the legacy service.

        Every command opens a new connection, and the device now and then
        refuses one (usbmuxd answers ``ConnectionFailedError``) or leaves it
        hanging. Those are retried here: left to propagate, a single refusal
        made the movement loop abandon the rest of the current leg, so the
        device jumped ahead of the others on the same route (issue #51).
        """
        last_exc: Exception | None = None
        for attempt in range(1, self._SEND_ATTEMPTS + 1):
            try:
                await asyncio.wait_for(self._send_set(lat, lng), timeout=self._SEND_TIMEOUT_S)
                self._active = True
                if attempt == 1:
                    logger.info("Legacy location set to (%.6f, %.6f)", lat, lng)
                else:
                    logger.info("Legacy location set to (%.6f, %.6f) on attempt %d", lat, lng, attempt)
                return
            except _LEGACY_TRANSIENT_ERRORS as exc:
                last_exc = exc
                logger.warning("Legacy location push failed (attempt %d/%d, %s: %s)",
                               attempt, self._SEND_ATTEMPTS, type(exc).__name__, exc)
                if attempt < self._SEND_ATTEMPTS:
                    await asyncio.sleep(0.2 * attempt)
            except Exception:
                logger.exception("Failed to set legacy simulated location")
                raise
        logger.error("Legacy location push failed %d times; device likely lost (%s)",
                     self._SEND_ATTEMPTS, last_exc)
        raise DeviceLostError(
            f"Legacy location push failed: {last_exc}",
            reason=DeviceLostError.REASON_LOCKDOWN_DEAD,
        ) from last_exc

    async def clear(self) -> None:
        """Clear the simulated location using the legacy service."""
        if not self._active:
            logger.debug("Legacy clear called but no simulation is active")
            return
        try:
            await self._send_clear()
            self._active = False
            logger.info("Legacy simulated location cleared")
        except _LEGACY_TRANSIENT_ERRORS as exc:
            logger.warning("Legacy clear channel dropped (%s: %s); reconnecting",
                           type(exc).__name__, exc)
            try:
                await self._send_clear()
                self._active = False
            except Exception:
                logger.exception("Legacy clear failed after reconnect")
        except Exception:
            logger.exception("Failed to clear legacy simulated location")
            raise
