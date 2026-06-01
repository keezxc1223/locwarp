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
from services.route_store import RouteManager
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
        # Per-udid simulation engines (group mode, max 3). The legacy
        # `simulation_engine` attribute still returns the most-recently-
        # created engine for single-device call sites that have not yet
        # been refactored.
        self.simulation_engines: dict = {}
        self._primary_udid: str | None = None
        self.cooldown_timer = CooldownTimer()
        self.bookmark_manager = BookmarkManager()
        self.route_manager = RouteManager()
        self.coord_formatter = CoordinateFormatter()
        self.reconnect_manager = None
        self._last_position = None
        # User-chosen initial map center (persisted between launches). When
        # None, the frontend falls back to a hardcoded default.
        self._initial_map_position: dict | None = None
        # Which bookmark category ids the user has expanded in the panel.
        # None = never set (first-time install); frontend applies the
        # "auto-collapse when total bookmarks > 30" rule. Empty list means
        # explicitly all-collapsed.
        self._bookmark_expanded_categories: list[str] | None = None
        # Geocode provider preference. Mirrors what the desktop UI saves to
        # its own localStorage, so /api/phone/geocode (which runs against
        # the backend, not the renderer) can honour the same choice.
        self._geocode_provider: str = "nominatim"
        self._google_geocode_key: str = ""
        # WiFi tunnel keep-alive: re-push the current simulated location to
        # idle Network tunnels so iOS doesn't drop the RSD socket when the
        # phone screen turns off. Default ON; user can toggle in the panel.
        self._wifi_keepalive_enabled: bool = True
        self._load_settings()

    def _load_settings(self):
        from services.json_safe import safe_load_json
        data = safe_load_json(SETTINGS_FILE)
        if not isinstance(data, dict):
            return
        try:
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
            bmExp = data.get("bookmark_expanded_categories")
            if isinstance(bmExp, list):
                self._bookmark_expanded_categories = [str(x) for x in bmExp]
            gp = data.get("geocode_provider")
            if isinstance(gp, str) and gp in ("nominatim", "photon", "google"):
                self._geocode_provider = gp
            gk = data.get("google_geocode_key")
            if isinstance(gk, str):
                self._google_geocode_key = gk
            ka = data.get("wifi_keepalive_enabled")
            if isinstance(ka, bool):
                self._wifi_keepalive_enabled = ka
        except (ValueError, KeyError):
            logger.warning("Settings payload field malformed; keeping defaults", exc_info=True)

    def save_settings(self):
        from services.json_safe import safe_write_json
        data = {
            "last_position": self._last_position,
            "coord_format": self.coord_formatter.format.value,
            "initial_map_position": self._initial_map_position,
            "bookmark_expanded_categories": self._bookmark_expanded_categories,
            "geocode_provider": self._geocode_provider,
            "google_geocode_key": self._google_geocode_key,
            "wifi_keepalive_enabled": self._wifi_keepalive_enabled,
        }
        safe_write_json(SETTINGS_FILE, data)

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
        """Create a SimulationEngine for the connected device.

        Idempotent: if an engine already exists for this udid, we
        reuse it instead of overwriting. The watchdog sometimes calls
        this every second (e.g. when list_devices()'s udid string
        doesn't byte-match our _connections key due to case / separator
        differences in certain pymobiledevice3 versions). Without this
        guard the re-created engine would wipe current_position back to
        None, so the user teleports successfully but any subsequent
        navigate / loop / multi-stop / random-walk raises "Cannot
        navigate: no current position" because the engine they're
        aiming at is a fresh one that never saw the teleport.
        """
        if udid in self.simulation_engines:
            logger.debug("Simulation engine already exists for %s; preserving current_position", udid)
            return
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

    # 2) If the primary is running a dynamic sim, attach the new device
    #    as a position-follower instead of replaying the sim from scratch.
    #    Why not replay: each sim mode restarts at its own "beginning"
    #      * loop:      _move_along_route emits coords[0] first → iPhone
    #                   teleports back to waypoint[0] before walking
    #      * multi_stop: routes from current pos back to waypoint[0]
    #                   first if >50m away → iPhone walks back to start
    #      * random_walk: rng resets at walk_count=0 → iPhone walks the
    #                   first random destination from scratch
    #    All three desync the rejoining iPhone from the surviving one and
    #    show up on Google Maps as the rejoining phone going back to the
    #    route's beginning. Following primary's positions instead keeps
    #    both iPhones perfectly in sync.
    from models.schemas import SimulationState
    dynamic = {
        SimulationState.NAVIGATING,
        SimulationState.LOOPING,
        SimulationState.MULTI_STOP,
        SimulationState.RANDOM_WALK,
    }
    if primary_eng.state not in dynamic:
        return

    logger.info("Auto-sync: attaching %s as position-follower of primary %s", new_udid, primary_udid)
    asyncio.create_task(_follow_primary_positions(new_udid, primary_udid))


async def _follow_primary_positions(follower_udid: str, primary_udid: str) -> None:
    """Mirror the primary engine's current_position onto the follower
    device. Runs until the primary changes, the follower disconnects,
    the follower starts its own simulation (which sets _stop_event via
    _ensure_stopped), or the primary engine is gone."""
    import asyncio
    poll_interval = 0.5  # 500ms — primary's own updates run ~1 Hz, so this oversamples slightly without thrashing
    last_pushed_lat: float | None = None
    last_pushed_lng: float | None = None
    while True:
        # Tear down conditions
        if app_state._primary_udid != primary_udid:
            logger.info("Follower %s: primary changed (%s → %s), stopping follow",
                        follower_udid, primary_udid, app_state._primary_udid)
            return
        follower_eng = app_state.simulation_engines.get(follower_udid)
        if follower_eng is None:
            logger.info("Follower %s: engine gone, stopping follow", follower_udid)
            return
        if follower_eng._stop_event.is_set():
            logger.info("Follower %s: stop_event set (own sim started or stop pressed), stopping follow",
                        follower_udid)
            return
        primary_eng = app_state.simulation_engines.get(primary_udid)
        if primary_eng is None:
            logger.info("Follower %s: primary engine gone, stopping follow", follower_udid)
            return

        pos = primary_eng.current_position
        if pos is not None and (pos.lat != last_pushed_lat or pos.lng != last_pushed_lng):
            try:
                await follower_eng._set_position(pos.lat, pos.lng)
                last_pushed_lat, last_pushed_lng = pos.lat, pos.lng
            except Exception:
                logger.debug("Follower %s: _set_position failed", follower_udid, exc_info=True)
        await asyncio.sleep(poll_interval)


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
    # Per-udid consecutive failure count. Drives exponential backoff so a
    # device that consistently fails to connect (Trust pending, Windows
    # firewall blocking the RSD loopback, no admin rights, dead USB cable)
    # doesn't get hammered every 5 seconds for the rest of the session and
    # spam the log with hundreds of identical tracebacks. Reset on success
    # OR on disappearance (the user re-plugged after fixing whatever).
    reconnect_failure_count: dict[str, int] = {}
    reconnect_cooldown_base = 5.0  # seconds for first retry
    reconnect_cooldown_max = 300.0  # cap at 5 minutes per UDID

    while True:
        await asyncio.sleep(1.0)
        try:
            dm = app_state.device_manager
            # Build two views: the ORIGINAL-case serials (needed for
            # downstream look-ups into dm._connections /
            # app_state.simulation_engines that use whatever case was
            # originally stored) and a LOWERCASE set used only for the
            # present_usb - connected set difference. Some pymobiledevice3
            # versions return list_devices()'s serial in different casing
            # from what connect() stores, which previously made every
            # tick look like "new device detected" and triggered a
            # (pre-idempotency-fix) engine recreation that wiped the
            # user's teleported current_position.
            connected_original: dict[str, str] = {}  # lowercase → original
            for udid, conn in dm._connections.items():
                if getattr(conn, "connection_type", "USB") == "USB":
                    connected_original[udid.lower()] = udid
            connected = set(connected_original.keys())

            try:
                raw = await list_devices()
            except Exception:
                logger.debug("usbmux list_devices failed in watchdog", exc_info=True)
                continue
            present_usb_original: dict[str, str] = {}  # lowercase → original
            for r in raw:
                if getattr(r, "connection_type", "USB") == "USB":
                    present_usb_original[r.serial.lower()] = r.serial
            present_usb = set(present_usb_original.keys())

            # --- Disappearance detection ---
            # connected / present_usb are lowercase for set math; map
            # back to original-case when touching simulation_engines /
            # _connections so whichever case was stored in those maps
            # is what we use for look-ups.
            lost_now: list[str] = []
            for udid_lc in connected:
                if udid_lc in present_usb:
                    miss_counts.pop(udid_lc, None)
                else:
                    miss_counts[udid_lc] = miss_counts.get(udid_lc, 0) + 1
                    if miss_counts[udid_lc] >= miss_threshold:
                        lost_now.append(connected_original[udid_lc])

            if lost_now:
                logger.warning("usbmux watchdog: device(s) gone → %s", lost_now)
                # If the leader is among the lost devices, capture its
                # snapshot BEFORE we cancel its task so we can hand the
                # in-flight sim off to whichever follower we promote.
                leader_lost = app_state._primary_udid in lost_now
                handoff_snapshot: dict | None = None
                if leader_lost:
                    leader_eng = app_state.simulation_engines.get(app_state._primary_udid)
                    if leader_eng is not None:
                        try:
                            handoff_snapshot = leader_eng.capture_resumable_snapshot()
                            if handoff_snapshot:
                                logger.info(
                                    "watchdog: captured handoff snapshot from leader %s (kind=%s, segment=%d)",
                                    app_state._primary_udid,
                                    handoff_snapshot.get("kind"),
                                    handoff_snapshot.get("segment_index", 0),
                                )
                        except Exception:
                            logger.exception("watchdog: capture_resumable_snapshot failed")

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

                # Promote: if the leader was among the lost AND there's
                # a successor still connected AND we captured a usable
                # snapshot, kick off resume_from_snapshot on the new
                # leader so the simulation continues seamlessly from the
                # exact segment / lap / walk-count the old leader had
                # reached. Other surviving devices then re-attach as
                # followers of the new leader (their old follower task,
                # if any, self-terminates on _primary_udid change).
                new_leader = app_state._primary_udid
                if leader_lost and new_leader and handoff_snapshot:
                    new_leader_eng = app_state.simulation_engines.get(new_leader)
                    if new_leader_eng is not None:
                        # The new leader was a follower of the old leader
                        # and was constantly being teleported by that
                        # follower task. _set_position never sets
                        # _stop_event, so we don't need to clear it
                        # before resume_from_snapshot — but we DO need to
                        # ensure the snapshot's teleport-to-current-pos
                        # is the last thing the old follower task can do
                        # before it sees the primary swap and exits.
                        logger.info(
                            "watchdog: promoting %s to leader, resuming sim from snapshot",
                            new_leader,
                        )
                        asyncio.create_task(new_leader_eng.resume_from_snapshot(handoff_snapshot))
                        # Re-attach any remaining devices (besides the
                        # new leader) as followers of the new leader.
                        for other_udid in app_state.simulation_engines.keys():
                            if other_udid == new_leader:
                                continue
                            asyncio.create_task(
                                _follow_primary_positions(other_udid, new_leader)
                            )

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

            # --- Appearance (auto-connect up to 3 devices, group mode) ---
            # Auto-connect any USB device not yet connected, up to the multi-
            # device cap. The user environment is assumed to only ever have
            # their own iPhones plugged in.
            MAX_DEVICES = 3
            new_udids_lc = present_usb - connected
            if not new_udids_lc or len(connected) >= MAX_DEVICES:
                continue
            # Map back to the original-case serials from list_devices so
            # downstream dm.connect() sees the format pymobiledevice3
            # itself expects.
            new_udids = [present_usb_original[lc] for lc in new_udids_lc]

            # Reset backoff for any UDID that just disappeared from usbmux —
            # the next time it shows up (re-plug) we want to try immediately,
            # not at the previous slot's accumulated cooldown.
            stale = [u for u in reconnect_failure_count if u not in present_usb_original]
            for u in stale:
                reconnect_failure_count.pop(u, None)
                last_reconnect_attempt.pop(u, None)

            now = time.monotonic()
            for udid in new_udids:
                if len(dm._connections) >= MAX_DEVICES:
                    break
                fail_count = reconnect_failure_count.get(udid, 0)
                # 5s, 10s, 20s, 40s, 80s, 160s, 300s, 300s ...
                cooldown = min(
                    reconnect_cooldown_base * (2 ** fail_count),
                    reconnect_cooldown_max,
                )
                last = last_reconnect_attempt.get(udid, 0.0)
                if now - last < cooldown:
                    continue
                last_reconnect_attempt[udid] = now
                logger.info(
                    "usbmux watchdog: new USB device %s detected, auto-connecting (fail_count=%d, cooldown=%.0fs)",
                    udid, fail_count, cooldown,
                )
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
                    reconnect_failure_count.pop(udid, None)

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
                    reconnect_failure_count[udid] = fail_count + 1
                    next_cooldown = min(
                        reconnect_cooldown_base * (2 ** (fail_count + 1)),
                        reconnect_cooldown_max,
                    )
                    # Drop full traceback after the first 3 failures so the
                    # log doesn't fill with identical stacks. Cause is always
                    # the same: Trust pending, no admin rights, or firewall
                    # blocking the RSD loopback handshake.
                    log_with_trace = fail_count < 3
                    logger.warning(
                        "Auto-connect for %s failed (attempt %d, will retry in %.0fs): likely Trust pending / no admin / firewall",
                        udid, fail_count + 1, next_cooldown,
                        exc_info=log_with_trace,
                    )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("usbmux watchdog iteration crashed; continuing")


async def _wifi_tunnel_keepalive():
    """Keep idle WiFi tunnels alive across phone screen-off.

    During active navigation the engine pushes coordinates every cycle,
    which is exactly why a moving WiFi tunnel survives the screen turning
    off while an idle one drops within seconds. This loop mirrors that
    traffic: every KEEPALIVE_INTERVAL it re-pushes the current simulated
    location for each Network-connected device whose engine is idle. The
    re-push doubles as keeping the fake location pinned. Active sims are
    skipped (they already generate traffic). Toggleable via settings —
    issue #33."""
    import asyncio
    from models.schemas import SimulationState
    KEEPALIVE_INTERVAL = 20.0
    # States where the engine is NOT actively pushing on its own, so the
    # socket would otherwise go quiet and iOS could reap it.
    IDLE_STATES = {SimulationState.IDLE, SimulationState.PAUSED}
    while True:
        try:
            await asyncio.sleep(KEEPALIVE_INTERVAL)
            if not app_state._wifi_keepalive_enabled:
                continue
            dm = app_state.device_manager
            for udid, conn in list(dm._connections.items()):
                if getattr(conn, "connection_type", "USB") != "Network":
                    continue
                eng = app_state.simulation_engines.get(udid)
                if eng is None or eng.state not in IDLE_STATES:
                    continue
                pos = eng.current_position
                if pos is None:
                    continue
                try:
                    await eng.location_service.set(pos.lat, pos.lng)
                except Exception:
                    logger.debug(
                        "WiFi keepalive re-push failed for %s", udid, exc_info=True,
                    )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("WiFi keepalive loop iteration error", exc_info=True)


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
    keepalive_task = asyncio.create_task(_wifi_tunnel_keepalive())

    yield

    # ── Shutdown ──
    watchdog_task.cancel()
    keepalive_task.cancel()
    for _t in (watchdog_task, keepalive_task):
        try:
            await _t
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
from api.recent import router as recent_router
from api.websocket import router as ws_router
from api.system import router as system_router
from api.phone_control import router as phone_router

app.include_router(device_router)
app.include_router(location_router)
app.include_router(route_router)
app.include_router(geocode_router)
app.include_router(system_router)
app.include_router(bookmarks_router)
app.include_router(recent_router)
app.include_router(ws_router)
app.include_router(phone_router)


@app.get("/")
async def root():
    return {
        "name": "LocWarp",
        "version": "0.1.0",
        "status": "running",
        "initial_position": app_state.get_initial_position(),
    }



if __name__ == "__main__":
    # v0.2.59: enable uvicorn access logging so we can see which HTTP
    # endpoints the frontend is hitting (needed to debug the "WiFi tunnel
    # drops on USB unplug" report — we need to confirm whether the UI is
    # POSTing /wifi/tunnel/stop or something else is triggering the
    # cleanup).
    uvicorn_access = logging.getLogger("uvicorn.access")
    uvicorn_access.setLevel(logging.INFO)
    uvicorn_access.propagate = True  # route through our basicConfig handlers
    uvicorn.run("main:app", host=API_HOST, port=API_PORT, reload=False, access_log=True)
