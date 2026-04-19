import asyncio
import json
import logging

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

from config import API_HOST, API_PORT, SETTINGS_FILE, DEFAULT_LOCATION
from core.device_manager import DeviceManager
from services.cooldown import CooldownTimer
from services.bookmarks import BookmarkManager
from services.coord_format import CoordinateFormatter
from services.reconnect import ReconnectManager
from services.scheduler import ScheduledReturn
from services.location_history import LocationHistory
from services.multi_location_service import MultiLocationService

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
        self.simulation_engine = None  # Created when a device connects
        self.cooldown_timer = CooldownTimer()
        self.bookmark_manager = BookmarkManager()
        self.coord_formatter = CoordinateFormatter()
        self.reconnect_manager = None
        self._last_position = None
        self._home_position: dict | None = None  # 手動設定的固定起始位置
        self.scheduled_return = ScheduledReturn()   # 定時回家
        self.location_history = LocationHistory()   # 地點歷史
        self.jitter_enabled = True                  # GPS 抖動偽裝
        # Multi-device GPS sync
        self._multi_loc = MultiLocationService()                 # fan-out service (reused across engine rebuilds)
        self._sync_device_names: dict[str, str] = {}            # udid → display name
        self._load_settings()

    def _load_settings(self):
        if SETTINGS_FILE.exists():
            try:
                data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
                pos = data.get("last_position")
                if pos:
                    self._last_position = pos
                home = data.get("home_position")
                if home:
                    self._home_position = home
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
            "last_position": self._last_position,
            "home_position": self._home_position,
            "coord_format": self.coord_formatter.format.value,
            "cooldown_enabled": self.cooldown_timer.enabled,
        }
        try:
            SETTINGS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception as e:
            logger.warning("Failed to save settings: %s", e)

    def get_initial_position(self) -> dict:
        """Return last saved position, or DEFAULT_LOCATION as synchronous fallback."""
        if self._last_position:
            return self._last_position
        return DEFAULT_LOCATION

    async def _fetch_ip_location(self) -> dict | None:
        """Fetch approximate location via IP geolocation (ip-api.com, free, no key).

        Returns a ``{"lat": float, "lng": float}`` dict on success, or ``None``
        if the request fails or the response is not actionable.
        """
        try:
            import httpx
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(
                    "http://ip-api.com/json?fields=status,lat,lon,city,country"
                )
                data = resp.json()
                if data.get("status") == "success":
                    lat, lng = float(data["lat"]), float(data["lon"])
                    city = data.get("city", "")
                    country = data.get("country", "")
                    logger.info(
                        "IP geolocation: (%.4f, %.4f) — %s, %s",
                        lat, lng, city, country,
                    )
                    return {"lat": lat, "lng": lng}
                logger.debug("IP geolocation returned non-success status: %s", data)
        except Exception as exc:
            logger.debug("IP geolocation failed (%s: %s); using default", type(exc).__name__, exc)
        return None

    async def get_initial_position_async(self) -> dict:
        """Return the best available initial position, in priority order:

        1. Manually pinned home position (user-set via UI)
        2. Last saved position from settings.json
        3. IP geolocation (city-level, no API key required)
        4. DEFAULT_LOCATION (Taipei City Hall hardcoded fallback)
        """
        if self._home_position:
            logger.info(
                "Using home position: (%.6f, %.6f)",
                self._home_position["lat"], self._home_position["lng"],
            )
            return self._home_position
        if self._last_position:
            logger.info(
                "Using last saved position: (%.6f, %.6f)",
                self._last_position["lat"], self._last_position["lng"],
            )
            return self._last_position
        ip_loc = await self._fetch_ip_location()
        if ip_loc:
            return ip_loc
        logger.info("Falling back to DEFAULT_LOCATION")
        return DEFAULT_LOCATION

    def update_last_position(self, lat: float, lng: float):
        self._last_position = {"lat": lat, "lng": lng}
        # 每 10 次位置更新儲存一次，防止異常退出遺失資料
        self._position_update_count = getattr(self, "_position_update_count", 0) + 1
        if self._position_update_count % 10 == 0:
            self.save_settings()

    async def create_engine_for_device(self, udid: str):
        """Create a SimulationEngine for the connected device.

        Uses the persistent MultiLocationService (_multi_loc) so that any
        previously registered sync devices remain active across engine rebuilds.
        """
        from core.simulation_engine import SimulationEngine
        from api.websocket import broadcast

        loc_service = await self.device_manager.get_location_service(udid)

        # Register as primary in the fan-out service (keeps existing sync devices)
        self._multi_loc.set_primary(udid, loc_service)

        # Store device name for the sync list
        try:
            devices = await self.device_manager.discover_devices()
            for d in devices:
                if d.udid == udid:
                    self._sync_device_names[udid] = d.name
                    break
        except Exception:
            self._sync_device_names[udid] = udid

        async def event_callback(event_type: str, data: dict):
            await broadcast(event_type, data)
            if event_type == "position_update" and "lat" in data:
                lat, lng = data["lat"], data["lng"]
                self.update_last_position(lat, lng)
                self.location_history.record(lat, lng)

        # Engine always uses the multi-location service
        self.simulation_engine = SimulationEngine(self._multi_loc, event_callback)

        # 決定起始位置（優先順序：home > last > IP > 預設）
        init = await self.get_initial_position_async()
        from models.schemas import Coordinate
        self.simulation_engine.current_position = Coordinate(
            lat=init["lat"], lng=init["lng"]
        )

        # 將起始位置注入手機 GPS（只推送給主要裝置，避免 fan-out 到尚未就緒的同步裝置）
        _set_ok = False
        for _attempt in range(3):
            try:
                await loc_service.set(init["lat"], init["lng"])
                _set_ok = True
                logger.info(
                    "Initial position set on device: (%.6f, %.6f) [attempt %d]",
                    init["lat"], init["lng"], _attempt + 1,
                )
                break
            except Exception as exc:
                logger.warning(
                    "Initial position push failed (attempt %d/3): %s",
                    _attempt + 1, exc,
                )
                if _attempt < 2:
                    await asyncio.sleep(1.0)

        if not _set_ok:
            # 3 次均失敗：保留 engine（current_position 已設定，UI 仍可顯示位置）
            # 讓使用者自行操作（如 Teleport）觸發下一次 set()
            logger.error(
                "Could not push initial position to device after 3 attempts. "
                "Engine kept alive; user action will trigger next push."
            )
            try:
                await broadcast("device_error", {
                    "udid": udid,
                    "stage": "initial_position",
                    "error": "Initial GPS set failed after 3 retries. Try teleporting manually.",
                })
            except Exception:
                pass
        else:
            # 成功後廣播 position_update 讓前端地圖立即定位
            try:
                await broadcast("position_update", {
                    "lat": init["lat"],
                    "lng": init["lng"],
                    "bearing": 0.0,
                    "speed_mps": 0.0,
                })
            except Exception:
                pass

        # Setup reconnect manager
        self.reconnect_manager = ReconnectManager(self.device_manager)

        logger.info("Simulation engine created for device %s", udid)

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
        from api.websocket import broadcast as _broadcast
        import asyncio as _asyncio

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
    miss_threshold = 2
    last_reconnect_attempt: dict[str, float] = {}
    reconnect_cooldown = 5.0  # seconds between retry attempts per UDID

    while True:
        await asyncio.sleep(2.0)
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
                continue  # skip appearance logic this tick

            # --- Appearance (auto-reconnect) ---
            # If nothing is connected but a USB device shows up, connect it.
            if connected or not present_usb:
                continue
            if app_state.simulation_engine is not None:
                continue  # already got one somehow

            now = time.monotonic()
            for udid in present_usb:
                last = last_reconnect_attempt.get(udid, 0.0)
                if now - last < reconnect_cooldown:
                    continue
                last_reconnect_attempt[udid] = now
                logger.info("usbmux watchdog: new USB device %s detected, auto-reconnecting", udid)
                try:
                    await dm.connect(udid)
                    await app_state.create_engine_for_device(udid)
                    # Only broadcast success when an engine was actually built
                    if app_state.simulation_engine is not None:
                        try:
                            await broadcast("device_reconnected", {"udid": udid})
                        except Exception:
                            logger.exception("watchdog: broadcast (reconnected) failed")
                        logger.info("Auto-reconnect succeeded for %s", udid)
                        last_reconnect_attempt.pop(udid, None)
                        break  # connected one device, done for this tick
                except Exception:
                    logger.warning(
                        "Auto-reconnect for %s failed (will retry in %.0fs): likely Trust pending",
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
from api.device import router as device_router
from api.location import router as location_router
from api.route import router as route_router
from api.geocode import router as geocode_router
from api.bookmarks import router as bookmarks_router
from api.websocket import router as ws_router
from api.history import router as history_router
from api.sync_device import router as sync_router

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
