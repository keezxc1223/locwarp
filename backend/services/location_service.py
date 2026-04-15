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

    def __init__(self, lockdown_client) -> None:
        self._lockdown = lockdown_client
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
        """Clear the simulated location using the legacy service."""
        if not self._active:
            logger.debug("Legacy clear called but no simulation is active")
            return
        try:
            svc = self._ensure_service()
            await self._maybe_await(svc.clear())
            self._active = False
            logger.info("Legacy simulated location cleared")
        except (OSError, EOFError, BrokenPipeError, ConnectionResetError) as exc:
            logger.warning("Legacy clear channel dropped (%s: %s); reconnecting",
                           type(exc).__name__, exc)
            self._reset_service()
            try:
                svc = self._ensure_service()
                await self._maybe_await(svc.clear())
                self._active = False
            except Exception:
                logger.exception("Legacy clear failed after reconnect")
        except Exception:
            logger.exception("Failed to clear legacy simulated location")
            raise
