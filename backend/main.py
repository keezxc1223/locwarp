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
        self.simulation_engine = None  # Created when a device connects
        self.cooldown_timer = CooldownTimer()
        self.bookmark_manager = BookmarkManager()
        self.coord_formatter = CoordinateFormatter()
        self.reconnect_manager = None
        self._last_position = None
        self._home_position: dict | None = None  # 手動設定的固定起始位置
        self._simulator_udid: str | None = None   # 目前連線的模擬器 UDID
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
        """Create a SimulationEngine for the connected device."""
        from core.simulation_engine import SimulationEngine
        from api.websocket import broadcast

        loc_service = await self.device_manager.get_location_service(udid)

        async def event_callback(event_type: str, data: dict):
            await broadcast(event_type, data)
            if event_type == "position_update" and "lat" in data:
                self.update_last_position(data["lat"], data["lng"])

        self.simulation_engine = SimulationEngine(loc_service, event_callback)

        # 決定起始位置（優先順序：home > last > IP > 預設）
        init = await self.get_initial_position_async()
        from models.schemas import Coordinate
        self.simulation_engine.current_position = Coordinate(
            lat=init["lat"], lng=init["lng"]
        )

        # 將起始位置注入手機 GPS，最多重試 3 次（冷啟動時 DVT 可能需要時間初始化）
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

    async def create_engine_for_simulator(self, udid: str, name: str, loc_service):
        """Create a SimulationEngine for an iOS Simulator via simctl."""
        from core.simulation_engine import SimulationEngine
        from api.websocket import broadcast

        self._simulator_udid = udid

        async def event_callback(event_type: str, data: dict):
            await broadcast(event_type, data)
            if event_type == "position_update" and "lat" in data:
                self.update_last_position(data["lat"], data["lng"])

        self.simulation_engine = SimulationEngine(loc_service, event_callback)

        init = await self.get_initial_position_async()
        from models.schemas import Coordinate
        self.simulation_engine.current_position = Coordinate(lat=init["lat"], lng=init["lng"])

        # 注入初始位置
        for attempt in range(3):
            try:
                await loc_service.set(init["lat"], init["lng"])
                logger.info("Simulator initial position set: (%.6f, %.6f)", init["lat"], init["lng"])
                break
            except Exception as exc:
                logger.warning("Simulator initial position push failed (attempt %d/3): %s", attempt + 1, exc)
                if attempt < 2:
                    await asyncio.sleep(1.0)

        try:
            await broadcast("position_update", {"lat": init["lat"], "lng": init["lng"],
                                                "bearing": 0.0, "speed_mps": 0.0})
        except Exception:
            pass

        logger.info("Simulation engine created for simulator %s (%s)", name, udid)


app_state = AppState()


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
from api.simulator import router as simulator_router

app.include_router(device_router)
app.include_router(location_router)
app.include_router(route_router)
app.include_router(geocode_router)
app.include_router(bookmarks_router)
app.include_router(ws_router)
app.include_router(simulator_router)


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
