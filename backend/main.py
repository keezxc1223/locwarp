import asyncio
import json
import logging
import sys

# 使用 uvloop 替換預設事件迴圈，提升計時精度與效能（macOS/Linux）
try:
    import uvloop
    asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())
except ImportError:
    pass  # Windows 不支援 uvloop，靜默跳過
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse

from config import API_HOST, API_PORT, SETTINGS_FILE
from core.device_manager import DeviceManager
from services.bookmarks import BookmarkManager
from services.cooldown import CooldownTimer
from services.coord_format import CoordinateFormatter
from services.location_history import LocationHistory
from services.multi_location_service import MultiLocationService
from services.position_resolver import PositionResolver
from services.reconnect import ReconnectManager
from services.scheduler import ScheduledReturn
from services.usb_watchdog import start_watchdog

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
    """Central application state — shared across API endpoints.

    Not a god object: these attributes *do* all share the "device
    connected" lifecycle. The class is kept as a service registry so
    routers can reach subsystems via ``app_state.<name>``. The
    orchestration methods (``create_engine_for_device``,
    ``add_sync_device``) are decomposed into private helpers below so
    the top-level flow reads like a table of contents.
    """

    # Number of retries when pushing the initial GPS position on device
    # connect. 3× matches the pre-refactor behavior — usually succeeds
    # on attempt 1; retries cover the window where the mounter has
    # succeeded but the LocationService isn't quite ready.
    _INITIAL_POSITION_RETRIES = 3
    _INITIAL_POSITION_RETRY_DELAY_SECONDS = 1.0

    def __init__(self):
        self.device_manager = DeviceManager()
        self.simulation_engine = None  # Created when a device connects
        self.cooldown_timer = CooldownTimer()
        self.bookmark_manager = BookmarkManager()
        self.coord_formatter = CoordinateFormatter()
        self.reconnect_manager = None
        self.scheduled_return = ScheduledReturn()   # 定時回家
        self.location_history = LocationHistory()   # 地點歷史
        self.jitter_enabled = True                  # GPS 抖動偽裝
        # Multi-device GPS sync — reused across engine rebuilds so that
        # previously-registered sync devices stay active after the
        # primary is swapped (e.g. on reconnect).
        self._multi_loc = MultiLocationService()
        self._sync_device_names: dict[str, str] = {}  # udid → display name
        # Position state lives in a dedicated resolver. on_change wires
        # through to save_settings so any change to home/last is
        # persisted automatically.
        self.position = PositionResolver(on_change=self.save_settings)
        self._load_settings()

    # ── Back-compat shims ──────────────────────────────────────────────
    # scheduler.py + api/location.py still read/write these attributes
    # directly. Keeping them as properties means no caller change.

    @property
    def _last_position(self) -> dict | None:
        return self.position.last

    @property
    def _home_position(self) -> dict | None:
        return self.position.home

    @_home_position.setter
    def _home_position(self, value: dict | None) -> None:
        self.position.home = value  # fires on_change → save_settings

    def update_last_position(self, lat: float, lng: float) -> None:
        self.position.update_last(lat, lng)

    def get_initial_position(self) -> dict:
        """Synchronous variant used by endpoints that can't await.
        Skips IP geolocation by design."""
        return self.position.get_initial_position_sync()

    # ── Settings persistence ───────────────────────────────────────────

    def _load_settings(self):
        if not SETTINGS_FILE.exists():
            return
        try:
            data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            self.position.load(last=data.get("last_position"), home=data.get("home_position"))
            fmt = data.get("coord_format")
            if fmt:
                from models.schemas import CoordinateFormat
                self.coord_formatter.format = CoordinateFormat(fmt)
            cd = data.get("cooldown_enabled")
            if cd is not None:
                self.cooldown_timer.enabled = cd
        except (json.JSONDecodeError, OSError, ValueError, KeyError):
            logger.warning("Settings file malformed or unreadable; using defaults", exc_info=True)

    def save_settings(self):
        data = {
            "last_position": self.position.last,
            "home_position": self.position.home,
            "coord_format": self.coord_formatter.format.value,
            "cooldown_enabled": self.cooldown_timer.enabled,
        }
        try:
            SETTINGS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception as e:
            logger.warning("Failed to save settings: %s", e)

    # ── Engine lifecycle ───────────────────────────────────────────────

    async def create_engine_for_device(self, udid: str) -> None:
        """Build the SimulationEngine for ``udid`` and push the initial
        GPS fix to the device.

        High-level flow (each step is a helper below):
          1. Register the device as primary in the fan-out service.
          2. Cache the device's display name (best-effort).
          3. Create the engine with a broadcast+persist callback.
          4. Resolve + set the initial position, with retry.
          5. Wire up the reconnect manager.
        """
        loc_service = await self.device_manager.get_location_service(udid)
        self._multi_loc.set_primary(udid, loc_service)
        await self._cache_device_name(udid)

        self.simulation_engine = self._build_engine()
        init = await self.position.get_initial_position()
        await self._set_engine_position(init)

        ok = await self._push_initial_position_with_retry(loc_service, init)
        await self._broadcast_initial_position_result(udid, init, ok)

        self.reconnect_manager = ReconnectManager(self.device_manager)
        logger.info("Simulation engine created for device %s", udid)

    async def _cache_device_name(self, udid: str) -> None:
        """Remember ``device.name`` for the sync-device panel. Falls back
        to the UDID if discovery fails — degraded but non-fatal."""
        try:
            devices = await self.device_manager.discover_devices()
            for d in devices:
                if d.udid == udid:
                    self._sync_device_names[udid] = d.name
                    return
        except Exception:
            pass
        self._sync_device_names[udid] = udid

    def _build_engine(self):
        """Create the SimulationEngine wired to broadcast WS frames and
        persist ``position_update`` events into last-position + history."""
        from api.websocket import broadcast
        from core.simulation_engine import SimulationEngine

        async def event_callback(event_type: str, data: dict):
            await broadcast(event_type, data)
            if event_type == "position_update" and "lat" in data:
                lat, lng = data["lat"], data["lng"]
                self.update_last_position(lat, lng)
                self.location_history.record(lat, lng)

        return SimulationEngine(self._multi_loc, event_callback)

    async def _set_engine_position(self, init: dict) -> None:
        from models.schemas import Coordinate
        self.simulation_engine.current_position = Coordinate(
            lat=init["lat"], lng=init["lng"],
        )

    async def _push_initial_position_with_retry(self, loc_service, init: dict) -> bool:
        """Try to push the initial fix to the device's LocationService up
        to ``_INITIAL_POSITION_RETRIES`` times. Returns True on success.

        Pushes only to the primary device (not via the fan-out service)
        because sync devices may not be ready yet at this stage.
        """
        for attempt in range(1, self._INITIAL_POSITION_RETRIES + 1):
            try:
                await loc_service.set(init["lat"], init["lng"])
                logger.info(
                    "Initial position set on device: (%.6f, %.6f) [attempt %d]",
                    init["lat"], init["lng"], attempt,
                )
                return True
            except Exception as exc:
                logger.warning(
                    "Initial position push failed (attempt %d/%d): %s",
                    attempt, self._INITIAL_POSITION_RETRIES, exc,
                )
                if attempt < self._INITIAL_POSITION_RETRIES:
                    await asyncio.sleep(self._INITIAL_POSITION_RETRY_DELAY_SECONDS)
        return False

    async def _broadcast_initial_position_result(self, udid: str, init: dict, ok: bool) -> None:
        """On success, broadcast position_update so the map pins immediately.
        On failure, broadcast device_error so the user gets a banner; the
        engine stays alive (current_position is set) so the next user
        action (e.g. Teleport) can retry the push."""
        from api.websocket import broadcast
        if not ok:
            logger.error(
                "Could not push initial position to device after %d attempts. "
                "Engine kept alive; user action will trigger next push.",
                self._INITIAL_POSITION_RETRIES,
            )
            try:
                await broadcast("device_error", {
                    "udid": udid,
                    "stage": "initial_position",
                    "error": "Initial GPS set failed after 3 retries. Try teleporting manually.",
                })
            except Exception:
                pass
            return
        try:
            await broadcast("position_update", {
                "lat": init["lat"],
                "lng": init["lng"],
                "bearing": 0.0,
                "speed_mps": 0.0,
            })
        except Exception:
            pass

    async def add_sync_device(self, udid: str) -> None:
        """Connect a secondary iOS device and add it to the GPS fan-out group.

        Immediately pushes the current position so the new device is in sync.
        """
        from api.websocket import broadcast

        dm = self.device_manager
        if udid not in dm._connections:
            await dm.connect(udid)

        loc_service = await dm.get_location_service(udid)
        self._multi_loc.add_sync(udid, loc_service)

        # Cache device name
        try:
            devices = await dm.discover_devices()
            for d in devices:
                if d.udid == udid:
                    self._sync_device_names[udid] = d.name
                    break
            else:
                self._sync_device_names[udid] = udid
        except Exception:
            self._sync_device_names[udid] = udid

        # Immediately sync current position to the new device
        if self.simulation_engine and self.simulation_engine.current_position:
            pos = self.simulation_engine.current_position
            try:
                await loc_service.set(pos.lat, pos.lng)
                logger.info("Sync device %s received current position (%.6f, %.6f)", udid, pos.lat, pos.lng)
            except Exception:
                logger.warning("Could not push initial position to sync device %s", udid, exc_info=True)

        name = self._sync_device_names.get(udid, udid)
        logger.info("Sync device added: %s (%s) — total in group: %d", name, udid, self._multi_loc.count)
        try:
            await broadcast("sync_device_added", {"udid": udid, "name": name, "total": self._multi_loc.count})
        except Exception:
            pass

    def remove_sync_device(self, udid: str) -> None:
        """Remove a secondary device from the GPS fan-out group."""
        import asyncio as _asyncio

        from api.websocket import broadcast as _broadcast

        self._multi_loc.remove_sync(udid)
        name = self._sync_device_names.pop(udid, udid)
        logger.info("Sync device removed: %s (%s) — total in group: %d", name, udid, self._multi_loc.count)
        try:
            _asyncio.get_event_loop().call_soon_threadsafe(
                lambda: _asyncio.ensure_future(
                    _broadcast("sync_device_removed", {"udid": udid, "name": name, "total": self._multi_loc.count})
                )
            )
        except Exception:
            pass


app_state = AppState()


# ── Frontend dist detection ───────────────────────────────

def _find_dist() -> Path | None:
    """Locate frontend/dist for production-mode static serving.

    Search order:
      1. ../frontend/dist  — relative to backend/main.py (dev tree or Makefile build)
      2. sys._MEIPASS/../frontend/dist — PyInstaller one-file bundle
    Returns None when the dist folder is absent (dev server mode expected).
    """
    # Normal project layout: backend/main.py → ../frontend/dist
    candidate = Path(__file__).resolve().parent.parent / "frontend" / "dist"
    if (candidate / "index.html").is_file():
        return candidate

    # PyInstaller bundle: _MEIPASS is the temp extraction root
    if hasattr(sys, "_MEIPASS"):
        candidate2 = Path(sys._MEIPASS).parent / "frontend" / "dist"
        if (candidate2 / "index.html").is_file():
            return candidate2

    return None


_DIST_PATH: Path | None = _find_dist()
if _DIST_PATH:
    logger.info("Production mode: serving frontend from %s", _DIST_PATH)
else:
    logger.info("Development mode: expecting Vite dev server on port 5173")


# ── Lifespan ─────────────────────────────────────────────

@asynccontextmanager
async def lifespan(application: FastAPI):
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

    watchdog_task = start_watchdog(app_state)

    yield

    # ── Shutdown ──
    watchdog_task.cancel()
    try:
        await watchdog_task
    except (asyncio.CancelledError, Exception):
        pass

    app_state.save_settings()
    # 將尚未批量寫入的地點歷史強制寫入磁碟，避免正常關閉時遺失最後幾筆記錄
    app_state.location_history.flush()
    await app_state.device_manager.disconnect_all()
    logger.info("LocWarp shut down")


# ── FastAPI app ───────────────────────────────────────────

app = FastAPI(title="LocWarp", version="0.1.0", description="iOS Virtual Location Simulator", lifespan=lifespan)

# CORS：限制為 localhost + 區網（RFC1918）。手機從 LAN 連 Vite dev server
# 時，瀏覽器 Origin 會是區網 IP（如 http://192.168.x.x:5173），需允許。
# 公網網站即使發出 request 也會被瀏覽器擋下 preflight。
_LAN_ORIGIN_REGEX = (
    r"^https?://("
    r"localhost|127\.0\.0\.1"
    r"|192\.168\.\d{1,3}\.\d{1,3}"
    r"|10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
    r")(:\d+)?$"
)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=_LAN_ORIGIN_REGEX,
    allow_credentials=False,  # 本 app 不使用 cookies／session，關閉以收斂攻擊面
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Content-Type"],
)

# Register routers
from api.bookmarks import router as bookmarks_router
from api.device import router as device_router
from api.geocode import router as geocode_router
from api.history import router as history_router
from api.location import router as location_router
from api.route import router as route_router
from api.sync_device import router as sync_router
from api.websocket import router as ws_router

app.include_router(device_router)
app.include_router(location_router)
app.include_router(route_router)
app.include_router(geocode_router)
app.include_router(bookmarks_router)
app.include_router(ws_router)
app.include_router(history_router)
app.include_router(sync_router)

# ── Static file serving (production mode) ────────────────
# Mounted AFTER all API routers so API paths always take priority.
# StaticFiles mounts are handled before the catch-all route below.

if _DIST_PATH:
    _assets_dir = _DIST_PATH / "assets"
    if _assets_dir.is_dir():
        # Vite puts hashed JS/CSS bundles under dist/assets/
        app.mount("/assets", StaticFiles(directory=str(_assets_dir)), name="assets")

    # Serve other top-level static files (favicon, vite.svg, manifest…)
    _extra_statics = [f for f in _DIST_PATH.iterdir()
                      if f.is_file() and f.name != "index.html"]
    if _extra_statics:
        # Mount the whole dist root as a read-only directory for exact-name files.
        # Starlette's StaticFiles raises 404 for missing entries, falling through
        # to the SPA catch-all below.
        app.mount("/static-root", StaticFiles(directory=str(_DIST_PATH)), name="static-root")


# ── Root & SPA catch-all ──────────────────────────────────

_NO_CACHE_HEADERS = {
    # index.html 引用的 JS bundle 檔名會隨每次 build 改變 hash，
    # 若 browser 繼續用舊的 cached index.html，它就會載到被刪掉的舊 JS
    # 或是根本沒更新到。對 index.html 強制 no-cache 確保版本一定是最新。
    # assets 下的 JS/CSS 已有 hash，交給 StaticFiles 預設快取即可。
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}


@app.get("/")
async def root():
    """Serve SPA index.html in production, or JSON status in dev mode."""
    if _DIST_PATH:
        return FileResponse(str(_DIST_PATH / "index.html"), headers=_NO_CACHE_HEADERS)
    return {
        "name": "LocWarp",
        "version": "0.1.0",
        "status": "running",
        "initial_position": app_state.get_initial_position(),
    }


@app.get("/api/status")
async def api_status():
    """Always-available JSON health-check endpoint (also in production mode)."""
    return {
        "name": "LocWarp",
        "version": "0.1.0",
        "status": "running",
        "mode": "production" if _DIST_PATH else "development",
        "initial_position": app_state.get_initial_position(),
    }


if _DIST_PATH:
    # SPA catch-all: any path not matched by an API route or StaticFiles mount
    # gets index.html so React Router can handle client-side navigation.
    # MUST be registered last.
    @app.get("/{catchall:path}")
    async def serve_spa(catchall: str):
        # Serve real files from dist root when they exist (favicon.ico, robots.txt…)
        candidate = _DIST_PATH / catchall
        if candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(_DIST_PATH / "index.html"), headers=_NO_CACHE_HEADERS)


if __name__ == "__main__":
    uvicorn.run("main:app", host=API_HOST, port=API_PORT, reload=False)
