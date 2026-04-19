"""USB watchdog — polls usbmuxd every 2 s to detect iOS device plug/unplug.

Previously an inner function of ``main.py``; moved here so ``main.py`` can
focus on FastAPI wiring and so the watchdog can be tested in isolation
(by swapping the dependencies passed to ``start_watchdog``).

Behavior covered:

* **Disappearance** — a UDID tracked by ``DeviceManager._connections`` that
  drops off the usbmux list for 2 consecutive polls is treated as a real
  unplug (not a transient re-enumeration). On confirmation:
    - every stale connection is closed,
    - ``app_state.simulation_engine`` is cleared,
    - a ``device_disconnected`` WS frame is broadcast.

* **Appearance** — a USB device showing up while nothing is connected
  triggers an auto-connect + engine rebuild. Failed attempts are
  cooldown-gated (5 s per UDID) so we don't hammer ``connect()`` while
  the user is still tapping "Trust this computer?".

WiFi (Network) devices are skipped on both sides — those are handled by
the separate WiFi tunnel watchdog. The 2-consecutive-miss debounce
protects against usbmuxd re-enumeration hiccups that would otherwise
disconnect healthy devices.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

from pymobiledevice3.usbmux import list_devices

from api.websocket import broadcast

if TYPE_CHECKING:
    # Type-only import — ``main.AppState`` would create a runtime cycle
    # (main.py imports this module). We only need the type name for the
    # signature.
    from main import AppState

logger = logging.getLogger("locwarp.usb_watchdog")

POLL_INTERVAL_SECONDS = 2.0
# Consecutive missed polls before we declare a device gone. Low enough to
# feel responsive, high enough to absorb a single usbmuxd hiccup.
MISS_THRESHOLD = 2
# Minimum seconds between auto-reconnect attempts for the same UDID.
# Longer than the user's typical Trust-dialog dismissal so we don't spam.
RECONNECT_COOLDOWN_SECONDS = 5.0


async def _watchdog_loop(app_state: AppState) -> None:
    """The actual forever-loop. Factored out so ``start_watchdog`` can
    wrap it in a task and the tests can call it once with a cancel scope.

    Never raises — a failed poll logs and continues. CancelledError is
    re-raised so shutdown can clean up.
    """
    miss_counts: dict[str, int] = {}
    last_reconnect_attempt: dict[str, float] = {}

    while True:
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
        try:
            await _tick(app_state, miss_counts, last_reconnect_attempt)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("usbmux watchdog iteration crashed; continuing")


async def _tick(
    app_state: AppState,
    miss_counts: dict[str, int],
    last_reconnect_attempt: dict[str, float],
) -> None:
    """One poll cycle. Split from the loop so the logic is unit-testable
    without dealing with ``asyncio.sleep``."""
    dm = app_state.device_manager
    connected = {
        udid for udid, conn in dm._connections.items()
        if getattr(conn, "connection_type", "USB") == "USB"
    }

    try:
        raw = await list_devices()
    except Exception:
        # usbmuxd itself can blip — we don't want that to affect our
        # miss-counts, so just skip this tick entirely.
        logger.debug("usbmux list_devices failed in watchdog", exc_info=True)
        return

    present_usb = {
        r.serial for r in raw
        if getattr(r, "connection_type", "USB") == "USB"
    }

    # ── Disappearance detection ─────────────────────────────────────────
    lost_now: list[str] = []
    for udid in connected:
        if udid in present_usb:
            miss_counts.pop(udid, None)
        else:
            miss_counts[udid] = miss_counts.get(udid, 0) + 1
            if miss_counts[udid] >= MISS_THRESHOLD:
                lost_now.append(udid)

    if lost_now:
        logger.warning("usbmux watchdog: device(s) gone → %s", lost_now)
        for udid in lost_now:
            miss_counts.pop(udid, None)
            try:
                await dm.disconnect(udid)
            except Exception:
                logger.exception("watchdog: disconnect failed for %s", udid)
        app_state.simulation_engine = None
        try:
            await broadcast("device_disconnected", {
                "udids": lost_now,
                "reason": "usb_unplugged",
            })
        except Exception:
            logger.exception("watchdog: broadcast (disconnected) failed")
        return  # don't fall through to appearance logic this tick

    # ── Appearance (auto-reconnect) ─────────────────────────────────────
    if connected or not present_usb:
        return
    if app_state.simulation_engine is not None:
        # Already have an engine — something else built one. Don't
        # stomp on it.
        return

    now = time.monotonic()
    for udid in present_usb:
        last = last_reconnect_attempt.get(udid, 0.0)
        if now - last < RECONNECT_COOLDOWN_SECONDS:
            continue
        last_reconnect_attempt[udid] = now
        logger.info(
            "usbmux watchdog: new USB device %s detected, auto-reconnecting",
            udid,
        )
        try:
            await dm.connect(udid)
            await app_state.create_engine_for_device(udid)
            # Only broadcast success once we actually built an engine.
            if app_state.simulation_engine is not None:
                try:
                    await broadcast("device_reconnected", {"udid": udid})
                except Exception:
                    logger.exception("watchdog: broadcast (reconnected) failed")
                logger.info("Auto-reconnect succeeded for %s", udid)
                last_reconnect_attempt.pop(udid, None)
                return  # one device per tick is enough
        except Exception:
            logger.warning(
                "Auto-reconnect for %s failed (will retry in %.0fs): likely Trust pending",
                udid, RECONNECT_COOLDOWN_SECONDS, exc_info=True,
            )


def start_watchdog(app_state: AppState) -> asyncio.Task:
    """Spawn the watchdog as a background task.

    Returns the task so the caller (typically ``main.lifespan``) can
    cancel it on shutdown.
    """
    return asyncio.create_task(_watchdog_loop(app_state))
