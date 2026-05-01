"""
LocWarp Location Service

Provides a unified interface for iOS location simulation across different
iOS versions, wrapping pymobiledevice3's location simulation capabilities.
"""

from __future__ import annotations

import logging
import inspect
from abc import ABC, abstractmethod

import asyncio

from pymobiledevice3.exceptions import ConnectionTerminatedError
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
from pymobiledevice3.services.simulate_location import DtSimulateLocation

logger = logging.getLogger(__name__)


class DeviceLostError(RuntimeError):
    """Raised when a location service determines the underlying device
    connection is no longer recoverable (e.g. USB unplugged, tunnel dead).
    Callers should drop any cached engine/connection and force a fresh
    discover+connect on the next user action."""


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
        Needed for reconnection.
    """

    def __init__(self, dvt_provider: DvtProvider, lockdown=None) -> None:
        self._dvt = dvt_provider
        self._lockdown = lockdown
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

        Retries with exponential backoff (2s, 4s, 8s, 16s, 30s) up to 5
        times.  This handles the case where the RSD/tunnel needs a moment
        to recover after a screen lock or brief WiFi interruption.
        """
        async with self._reconnect_lock:
            # Close the old DVT provider gracefully
            try:
                await self._dvt.__aexit__(None, None, None)
            except Exception:
                logger.debug("Ignoring error while closing old DvtProvider")

            self._location_sim = None

            if self._lockdown is None:
                raise RuntimeError("Cannot reconnect DVT: no lockdown/RSD reference")

            # Fast-fail: a blip usually recovers within 1-2s. If it doesn't,
            # the device is almost certainly gone (USB unplugged, tunnel dead)
            # — there's no point making the user wait 60s. 2 attempts with
            # 0.5s + 1.5s = ~2s worst case, then raise DeviceLostError.
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
            # Final try without delay
            try:
                new_dvt = DvtProvider(self._lockdown)
                await new_dvt.__aenter__()
                self._dvt = new_dvt
                logger.info("DVT provider reconnected on final attempt")
                return
            except Exception as exc:
                last_exc = exc
            logger.error("DVT provider reconnect exhausted — device likely lost")
            raise DeviceLostError(f"DVT reconnect failed: {last_exc}") from last_exc

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
        """Clear the simulated location via the DVT instrument channel.

        Always attempts to clear regardless of whether set() was called in
        this session — the device may carry a simulated location from a
        previous run that must be removed.
        """
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

    Also used as a fallback on iOS 17+ when DVT is unavailable (e.g. DDI
    not mounted).  When created as a DVT fallback, pass the RSD lockdown
    as ``rsd_lockdown`` so that clear() can retry via DVT before falling
    back to the DtSimulateLocation protocol.

    Parameters
    ----------
    lockdown_client
        Primary lockdown service provider (usbmux/TCP on iOS 17+ fallback,
        plain lockdown on iOS < 17).
    rsd_lockdown
        Optional RSD (Remote Service Discovery) lockdown for iOS 17+.
        When provided, clear() tries DVT LocationSimulation first since it
        is the most reliable path to restore real GPS on newer firmware.
    """

    SERVICE_NAME = "com.apple.dt.simulatelocation"

    def __init__(self, lockdown_client, rsd_lockdown=None) -> None:
        self._lockdown = lockdown_client
        self._rsd_lockdown = rsd_lockdown  # RSD lockdown for DVT fallback on iOS 17+
        self._service: DtSimulateLocation | None = None
        self._active = False

    def _ensure_service(self) -> DtSimulateLocation:
        """Lazily create and cache the DtSimulateLocation service."""
        if self._service is None:
            self._service = DtSimulateLocation(self._lockdown)
            logger.debug("Legacy DtSimulateLocation service initialised")
        return self._service

    async def _maybe_await(self, result) -> None:
        """Support both sync and async DtSimulateLocation methods."""
        if inspect.isawaitable(result):
            await result

    def _reset_service(self) -> None:
        """Drop the cached DtSimulateLocation so the next call reconstructs it."""
        try:
            if self._service is not None and hasattr(self._service, "close"):
                self._service.close()
        except Exception:
            logger.debug("Error closing stale DtSimulateLocation", exc_info=True)
        self._service = None

    async def _send_raw_clear(self, lockdown) -> bool:
        """Send a stop-simulation command directly over *lockdown*.

        Tries the 8-byte format first (``type=1`` + ``length=0``), which is
        what older pymobiledevice3 versions sent and what iOS consistently
        understands.  Current pymobiledevice3 ``DtSimulateLocation.clear()``
        only sends 4 bytes; iOS 17+ may silently ignore this incomplete frame
        because it is still waiting for the ``length`` field.

        Returns True on success.
        """
        import struct
        # Try 8-byte format: [type=1 uint32][length=0 uint32]
        for fmt, label in [(">II", "8-byte"), (">I", "4-byte")]:
            try:
                svc = await lockdown.start_lockdown_developer_service(self.SERVICE_NAME)
                payload = struct.pack(fmt, 1, 0) if fmt == ">II" else struct.pack(fmt, 1)
                await svc.sendall(payload)
                logger.info("DtSimulateLocation clear (%s) sent via %s",
                            label, type(lockdown).__name__)
                return True
            except Exception as exc:
                logger.debug("DtSimulateLocation clear (%s) via %s failed: %s",
                             label, type(lockdown).__name__, exc)
        return False

    async def _dvt_clear(self) -> bool:
        """Attempt DVT LocationSimulation.clear() via the RSD lockdown.

        This is the most reliable clear path on iOS 17+.  Requires the RSD
        lockdown (stored as ``_rsd_lockdown``) and ideally a mounted DDI,
        though some iOS versions work without it.

        Returns True on success.
        """
        if self._rsd_lockdown is None:
            return False
        try:
            from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
            from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
            dvt = DvtProvider(self._rsd_lockdown)
            await dvt.__aenter__()
            try:
                sim = LocationSimulation(dvt)
                await sim.connect()
                await sim.clear()
                logger.info("DVT LocationSimulation.clear() succeeded (RSD lockdown)")
                return True
            finally:
                try:
                    await dvt.__aexit__(None, None, None)
                except Exception:
                    pass
        except Exception as exc:
            logger.debug("DVT clear via RSD lockdown failed: %s", exc)
            return False

    async def set(self, lat: float, lng: float) -> None:
        """Simulate the device location using the legacy service."""
        try:
            svc = self._ensure_service()
            await self._maybe_await(svc.set(lat, lng))
            self._active = True
            logger.info("Legacy location set to (%.6f, %.6f)", lat, lng)
        except (OSError, EOFError, BrokenPipeError, ConnectionResetError) as exc:
            logger.warning("Legacy location channel dropped (%s: %s); reconnecting and retrying",
                           type(exc).__name__, exc)
            self._reset_service()
            try:
                svc = self._ensure_service()
                await self._maybe_await(svc.set(lat, lng))
                self._active = True
                logger.info("Legacy location set to (%.6f, %.6f) after reconnect", lat, lng)
            except Exception as retry_exc:
                logger.error("Legacy reconnect failed — device likely lost (%s)", retry_exc)
                raise DeviceLostError(f"Legacy reconnect failed: {retry_exc}") from retry_exc
        except Exception:
            logger.exception("Failed to set legacy simulated location")
            raise

    async def clear(self) -> None:
        """Restore real GPS by stopping location simulation.

        Tries three strategies in order, stopping at the first success:

        1. DVT LocationSimulation.clear() via the RSD lockdown — the same
           path Xcode uses; most reliable on iOS 17+.
        2. Raw 8-byte stop command via the primary lockdown — fixes the
           known bug where current pymobiledevice3 only sends 4 bytes and
           iOS 17+ silently ignores the incomplete frame.
        3. Raw 8-byte stop command via the RSD lockdown (second attempt).

        Always attempts to clear regardless of whether set() was called in
        this session — the device may carry a simulated location from a
        previous app run that must be removed.
        """
        # Strategy 1: DVT (Xcode path, most reliable on iOS 17+)
        if await self._dvt_clear():
            self._active = False
            return

        # Strategy 2 & 3: raw stop command — 8-byte format on both lockdowns
        cleared = False
        for lockdown in filter(None, [self._lockdown, self._rsd_lockdown]):
            if await self._send_raw_clear(lockdown):
                cleared = True
                break

        if cleared:
            self._active = False
            return

        # Last resort: fall through to pymobiledevice3's own clear() which
        # sends the 4-byte format — may work on older iOS.
        try:
            svc = self._ensure_service()
            await self._maybe_await(svc.clear())
            self._active = False
            logger.info("Legacy simulated location cleared (pymobiledevice3 fallback)")
        except Exception:
            logger.exception("All clear strategies failed for legacy location service")
            raise
