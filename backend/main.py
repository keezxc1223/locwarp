import asyncio
import json
import logging
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import API_HOST, API_PORT, SETTINGS_FILE, DEFAULT_LOCATION
from core.device_manager import DeviceManager
from services.cooldown import CooldownTimer
from services.bookmarks import BookmarkManager
from services.coord_format import CoordinateFormatter
from services.reconnect import ReconnectManager

# Configure logging — console + rotating file in ~/.locwarp/logs/
_log_fmt = "%(asctime)s [%(name)s] %(levelname)s: %(message)s"
_log_dir = Path.home() / ".locwarp" / "logs"
try:
    _log_dir.mkdir(parents=True, exist_ok=True)
    _file_handler = RotatingFileHandler(
        _log_dir / "backend.log",
        maxBytes=2 * 1024 * 1024,  # 2 MB
        backupCount=3,
        encoding="utf-8",
    )
    _file_handler.setFormatter(logging.Formatter(_log_fmt))
    _file_handler.setLevel(logging.INFO)
    _handlers = [logging.StreamHandler(), _file_handler]
except Exception:
    _handlers = [logging.StreamHandler()]
logging.basicConfig(level=logging.INFO, format=_log_fmt, handlers=_handlers, force=True)
logger = logging.getLogger("locwarp")


class AppState:
    """Central application state — shared across API endpoints."""

    def __init__(self):
        self.device_manager = DeviceManager()
        # Per-udid simulation engines (group mode, max 2). The legacy
        # `simulation_engine` attribute still returns the most-recently-
        # created engine for single-device call sites that have not yet
        # been refactored.
        self.simulation_engines: dict = {}
        self._primary_udid: str | None = None
        self.cooldown_timer = CooldownTimer()
        self.bookmark_manager = BookmarkManager()
        self.coord_formatter = CoordinateFormatter()
        self.reconnect_manager = None
        self._last_position = None
        # User-chosen initial map center (persisted between launches). When
        # None, the frontend falls back to a hardcoded default.
        self._initial_map_position: dict | None = None
        self._load_settings()

    def _load_settings(self):
        if SETTINGS_FILE.exists():
            try:
                data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
                pos = data.get("last_position")
                if pos:
                    self._last_position = pos
                fmt = data.get("coord_format")
                if fmt:
                    from models.schemas import CoordinateFormat
                    self.coord_formatter.format = CoordinateFormat(fmt)
                imp = data.get("initial_map_position")
                if isinstance(imp, dict) and "lat" in imp and "lng" in imp:
                    self._initial_map_position = {"lat": float(imp["lat"]), "lng": float(imp["lng"])}
            except (json.JSONDecodeError, OSError, ValueError, KeyError):
                logger.warning("Settings file malformed or unreadable; using defaults", exc_info=True)

    def save_settings(self):
        data = {
            "last_position": self._last_position,
            "coord_format": self.coord_formatter.format.value,
            "initial_map_position": self._initial_map_position,
        }
        try:
            SETTINGS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception as e:
            logger.warning("Failed to save settings: %s", e)

    def get_initial_position(self) -> dict:
        if self._last_position:
            return self._last_position
        # Could try IP geolocation here; fallback to default
        return DEFAULT_LOCATION

    def update_last_position(self, lat: float, lng: float):
        self._last_position = {"lat": lat, "lng": lng}

    @property
    def simulation_engine(self):
        """Legacy accessor: the most-recently-created engine.
        Prefer get_engine(udid) in new code."""
        if self._primary_udid and self._primary_udid in self.simulation_engines:
            return self.simulation_engines[self._primary_udid]
        return None

    @simulation_engine.setter
    def simulation_engine(self, value):
        """Legacy setter. Only `= None` (clear all) is meaningful."""
        if value is None:
            self.simulation_engines.clear()
            self._primary_udid = None
        else:
            # Best-effort: stash under a synthetic key if udid unknown
            self.simulation_engines["__legacy__"] = value
            self._primary_udid = "__legacy__"

    def get_engine(self, udid: str | None):
        """Return the engine for *udid*, or the primary engine if udid is None."""
        if udid is None:
            return self.simulation_engine
        return self.simulation_engines.get(udid)

    async def create_engine_for_device(self, udid: str):
        """Create a SimulationEngine for the connected device."""
        from core.simulation_engine import SimulationEngine
        from api.websocket import broadcast

        loc_service = await self.device_manager.get_location_service(udid)

        async def event_callback(event_type: str, data: dict):
            # Always tag emissions with udid so the frontend can route per-device.
            if isinstance(data, dict) and "udid" not in data:
                data = {**data, "udid": udid}
            await broadcast(event_type, data)
            if event_type == "position_update" and "lat" in data:
                self.update_last_position(data["lat"], data["lng"])

        engine = SimulationEngine(loc_service, event_callback)
        self.simulation_engines[udid] = engine
        # Keep the existing primary on additional device connects. If no
        # primary is set (e.g. fresh install, first device), this udid
        # becomes primary. Second device plugging in no longer hijacks
        # the map view away from the first device.
        if self._primary_udid is None:
            self._primary_udid = udid

        # DO NOT push any initial location to the device on connect. The
        # engine's current_position stays None until the user explicitly
        # teleports / navigates / picks a bookmark. iPhone's real GPS is
        # left untouched by merely plugging the phone into LocWarp.
        #
        # The map UI still shows a default center (Taipei or the user's
        # `initial_map_position` setting) — that's purely a visual default
        # for the Leaflet view, not a virtual GPS coordinate.

        # Setup reconnect manager
        self.reconnect_manager = ReconnectManager(self.device_manager)

        logger.info("Simulation engine created for device %s (no initial location pushed)", udid)


app_state = AppState()


# ── Lifespan ─────────────────────────────────────────────

async def _auto_sync_new_device_to_primary(new_udid: str) -> None:
    """Align a freshly-connected second device to whatever the primary
    device is doing, so dual-device mode behaves as one unit without the
    user having to explicitly restart actions.

    Behaviour:
      * No primary yet, or primary is the same as *new_udid* → noop
      * Primary has a ``current_position`` → teleport new device there
      * Primary is running navigate / loop / multi_stop / random_walk →
        replay the same action (with the same args) on the new engine so
        both devices share the target / waypoints / seed
      * Primary is idle / paused / teleport-only → only the position
        sync happens; the user's next action will fan-out to both
    """
    import asyncio
    primary_udid = app_state._primary_udid
    if primary_udid is None or primary_udid == new_udid:
        return
    primary_eng = app_state.simulation_engines.get(primary_udid)
    new_eng = app_state.simulation_engines.get(new_udid)
    if primary_eng is None or new_eng is None:
        return

    pos = primary_eng.current_position
    if pos is None:
        # Primary hasn't been given a position yet — nothing to sync.
        logger.info("Auto-sync: primary %s has no position, skipping %s", primary_udid, new_udid)
        return

    # 1) Teleport the new device to match the primary's current virtual
    #    position (keeps the 'one marker' invariant in dual mode).
    try:
        await new_eng.teleport(pos.lat, pos.lng)
        logger.info("Auto-sync: %s teleported to primary %s position (%.6f, %.6f)",
                    new_udid, primary_udid, pos.lat, pos.lng)
    except Exception:
        logger.exception("Auto-sync: teleport failed for %s", new_udid)
        return

    # 2) If the primary is running a dynamic sim, kick off the same one
    #    on the new device. `paused` / `idle` / `teleporting` / etc. don't
    #    need action replay — the user's next command will fan-out.
    from models.schemas import SimulationState
    dynamic = {
        SimulationState.NAVIGATING,
        SimulationState.LOOPING,
        SimulationState.MULTI_STOP,
        SimulationState.RANDOM_WALK,
    }
    if primary_eng.state not in dynamic:
        return

    kind = primary_eng._last_sim_kind
    args = primary_eng._last_sim_args
    if not kind or not args:
        logger.info("Auto-sync: primary %s active but has no replayable last_sim; skipping", primary_udid)
        return

    method = getattr(new_eng, kind, None)
    if method is None:
        logger.warning("Auto-sync: new engine has no method '%s'", kind)
        return

    logger.info("Auto-sync: replaying %s on %s", kind, new_udid)
    # Fire-and-forget — the handler runs until stop/disconnect.
    asyncio.create_task(method(**args))


async def _usbmux_presence_watchdog():
    """Poll usbmuxd every 2 s for both directions:

    * **Disappearance** — a UDID present in DeviceManager._connections that
      drops off the usbmux list for 2 consecutive polls is treated as USB
      unplug: disconnect, clear simulation_engine, broadcast device_disconnected.
    * **Appearance** — a USB device showing up while we have no active
      connection triggers an auto-connect + engine rebuild, broadcasting
      device_reconnected when it succeeds. Failed attempts are throttled
      (min 5 s between retries per UDID) so we don't spam connect() while
      the device is still in the "Trust this computer?" dialog.

    WiFi (Network) devices are skipped on both sides — those are covered by
    the WiFi tunnel watchdog. Consecutive-miss debouncing protects against
    usbmuxd re-enumeration hiccups.
    """
    import asyncio
    import time
    from pymobiledevice3.usbmux import list_devices
    from api.websocket import broadcast

    miss_counts: dict[str, int] = {}
    miss_threshold = 3
    last_reconnect_attempt: dict[str, float] = {}
    reconnect_cooldown = 5.0  # seconds between retry attempts per UDID

    while True:
        await asyncio.sleep(1.0)
        try:
            dm = app_state.device_manager
            connected = {
                udid for udid, conn in dm._connections.items()
                if getattr(conn, "connection_type", "USB") == "USB"
            }

            try:
                raw = await list_devices()
            except Exception:
                logger.debug("usbmux list_devices failed in watchdog", exc_info=True)
                continue
            present_usb = {
                r.serial for r in raw
                if getattr(r, "connection_type", "USB") == "USB"
            }

            # --- Disappearance detection ---
            lost_now: list[str] = []
            for udid in connected:
                if udid in present_usb:
                    miss_counts.pop(udid, None)
                else:
                    miss_counts[udid] = miss_counts.get(udid, 0) + 1
                    if miss_counts[udid] >= miss_threshold:
                        lost_now.append(udid)

            if lost_now:
                logger.warning("usbmux watchdog: device(s) gone → %s", lost_now)
                for udid in lost_now:
                    miss_counts.pop(udid, None)
                    # Signal any simulation in flight (random-walk / loop /
                    # multi-stop) to exit its inner loop cleanly. Without
                    # this, the handler would keep trying to push positions
                    # through the now-dead DVT channel, silently log fake
                    # 'arrived at destination' events, and leave a zombie
                    # task running against a stale engine reference.
                    old_eng = app_state.simulation_engines.get(udid)
                    if old_eng is not None:
                        try:
                            # Mark DISCONNECTED before cancelling the active
                            # task. Otherwise _run_handler's finally block sees
                            # a non-IDLE state and forces it to IDLE, emitting
                            # state_change=idle. In dual-device mode, if the
                            # primary is the one being unplugged, that idle
                            # event slips through the frontend filter (primary
                            # match) and wipes the global routePath / dest so
                            # the surviving device's polyline disappears.
                            from models.schemas import SimulationState as _SS
                            old_eng.state = _SS.DISCONNECTED
                            try:
                                await old_eng._emit("state_change", {"state": old_eng.state.value})
                            except Exception:
                                logger.debug("watchdog: disconnected state_change emit failed", exc_info=True)
                            old_eng._stop_event.set()
                            old_eng._pause_event.set()  # unstick anyone awaiting pause_event
                            active = getattr(old_eng, "_active_task", None)
                            if active is not None and not active.done():
                                active.cancel()
                        except Exception:
                            logger.debug("watchdog: failed to stop old engine %s", udid, exc_info=True)
                    try:
                        await dm.disconnect(udid)
                    except Exception:
                        logger.exception("watchdog: disconnect failed for %s", udid)
                    # Only remove the lost device's engine. The legacy setter
                    # `simulation_engine = None` wipes *all* engines, which
                    # destroys the surviving device's engine in dual mode.
                    app_state.simulation_engines.pop(udid, None)
                    if app_state._primary_udid == udid:
                        remaining = next(iter(app_state.simulation_engines.keys()), None)
                        app_state._primary_udid = remaining
                try:
                    await broadcast("device_disconnected", {
                        "udids": lost_now,
                        "reason": "usb_unplugged",
                        # Remaining connected count AFTER cleanup. Frontend
                        # suppresses the full-screen banner when > 0 since
                        # the other device(s) are still usable; only the
                        # affected chip in the sidebar needs updating.
                        "remaining_count": len(dm._connections),
                    })
                except Exception:
                    logger.exception("watchdog: broadcast (disconnected) failed")
                continue  # skip appearance logic this tick

            # --- Appearance (auto-connect up to 2 devices, group mode) ---
            # Auto-connect any USB device not yet connected, up to the dual-
            # device cap. The user environment is assumed to only ever have
            # their own iPhones plugged in.
            MAX_DEVICES = 2
            new_udids = present_usb - connected
            if not new_udids or len(connected) >= MAX_DEVICES:
                continue

            now = time.monotonic()
            for udid in new_udids:
                if len(dm._connections) >= MAX_DEVICES:
                    break
                last = last_reconnect_attempt.get(udid, 0.0)
                if now - last < reconnect_cooldown:
                    continue
                last_reconnect_attempt[udid] = now
                logger.info("usbmux watchdog: new USB device %s detected, auto-connecting", udid)
                try:
                    await dm.connect(udid)
                    await app_state.create_engine_for_device(udid)
                    # Broadcast device_connected so the frontend chip row updates.
                    try:
                        devs = await dm.discover_devices()
                        info = next((d for d in devs if d.udid == udid), None)
                        await broadcast("device_connected", {
                            "udid": udid,
                            "name": info.name if info else "",
                            "ios_version": info.ios_version if info else "",
                            "connection_type": info.connection_type if info else "USB",
                        })
                    except Exception:
                        logger.exception("watchdog: broadcast (connected) failed")
                    logger.info("Auto-connect succeeded for %s", udid)
                    last_reconnect_attempt.pop(udid, None)

                    # Auto-sync the new device to the primary device: if the
                    # primary has a virtual position set, teleport the new
                    # device there; if the primary is running a dynamic
                    # simulation (navigate / loop / multi_stop / random_walk),
                    # also replay that action on the new device so both move
                    # together. Dual-device group mode semantics: one marker,
                    # two phones in lockstep.
                    try:
                        await _auto_sync_new_device_to_primary(udid)
                    except Exception:
                        logger.exception("Auto-sync of new device %s to primary failed", udid)
                except Exception:
                    logger.warning(
                        "Auto-connect for %s failed (will retry in %.0fs): likely Trust pending",
                        udid, reconnect_cooldown, exc_info=True,
                    )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("usbmux watchdog iteration crashed; continuing")


@asynccontextmanager
async def lifespan(application: FastAPI):
    import asyncio
    # ── Startup ──
    logger.info("LocWarp starting — scanning for devices…")
    try:
        devices = await app_state.device_manager.discover_devices()
        if devices:
            target = devices[0]
            logger.info("Found device %s (%s), auto-connecting…", target.name, target.udid)
            await app_state.device_manager.connect(target.udid)
            await app_state.create_engine_for_device(target.udid)
            logger.info("Auto-connected to %s", target.udid)
        else:
            logger.info("No iOS devices found on startup")
    except Exception:
        logger.exception("Auto-connect on startup failed (device may need manual connect)")

    watchdog_task = asyncio.create_task(_usbmux_presence_watchdog())

    yield

    # ── Shutdown ──
    watchdog_task.cancel()
    try:
        await watchdog_task
    except (asyncio.CancelledError, Exception):
        pass

    app_state.save_settings()
    await app_state.device_manager.disconnect_all()
    logger.info("LocWarp shut down")


# ── FastAPI app ───────────────────────────────────────────

app = FastAPI(title="LocWarp", version="0.1.0", description="iOS Virtual Location Simulator", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
from api.device import router as device_router
from api.location import router as location_router
from api.route import router as route_router
from api.geocode import router as geocode_router
from api.bookmarks import router as bookmarks_router
from api.websocket import router as ws_router
from api.system import router as system_router

app.include_router(device_router)
app.include_router(location_router)
app.include_router(route_router)
app.include_router(geocode_router)
app.include_router(system_router)
app.include_router(bookmarks_router)
app.include_router(ws_router)


@app.get("/")
async def root():
    return {
        "name": "LocWarp",
        "version": "0.1.0",
        "status": "running",
        "initial_position": app_state.get_initial_position(),
    }



if __name__ == "__main__":
    uvicorn.run("main:app", host=API_HOST, port=API_PORT, reload=False)
