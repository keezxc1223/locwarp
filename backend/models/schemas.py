from __future__ import annotations

from enum import Enum
from pydantic import BaseModel, Field


class Coordinate(BaseModel):
    lat: float = Field(ge=-90.0, le=90.0, description="Latitude in degrees")
    lng: float = Field(ge=-180.0, le=180.0, description="Longitude in degrees")


class SimulationState(str, Enum):
    IDLE = "idle"
    TELEPORTING = "teleporting"
    NAVIGATING = "navigating"
    LOOPING = "looping"
    JOYSTICK = "joystick"
    RANDOM_WALK = "random_walk"
    MULTI_STOP = "multi_stop"
    PAUSED = "paused"
    RECONNECTING = "reconnecting"
    DISCONNECTED = "disconnected"


class MovementMode(str, Enum):
    WALKING = "walking"
    RUNNING = "running"
    DRIVING = "driving"


class CoordinateFormat(str, Enum):
    DD = "dd"
    DMS = "dms"
    DM = "dm"


# ── Device ───────────────────────────────────────────────
class DeviceInfo(BaseModel):
    udid: str
    name: str
    ios_version: str
    connection_type: str = "usb"
    is_connected: bool = False
    # iOS 16+ "Developer Mode" toggle state. None means we couldn't query
    # (not connected, iOS <16, or service call failed). Frontend uses this
    # to decide whether to show the "Reveal Developer Mode option" button.
    developer_mode_enabled: bool | None = None


# ── Location requests ────────────────────────────────────
class TeleportRequest(BaseModel):
    lat: float = Field(ge=-90.0, le=90.0)
    lng: float = Field(ge=-180.0, le=180.0)
    udid: str | None = None


class NavigateRequest(BaseModel):
    lat: float = Field(ge=-90.0, le=90.0)
    lng: float = Field(ge=-180.0, le=180.0)
    mode: MovementMode = MovementMode.WALKING
    speed_kmh: float | None = None
    speed_min_kmh: float | None = None
    speed_max_kmh: float | None = None
    straight_line: bool = False
    route_engine: str | None = None
    udid: str | None = None


class LoopRequest(BaseModel):
    waypoints: list[Coordinate]
    mode: MovementMode = MovementMode.WALKING
    speed_kmh: float | None = None
    speed_min_kmh: float | None = None
    speed_max_kmh: float | None = None
    pause_enabled: bool = True
    pause_min: float = 5.0
    pause_max: float = 20.0
    straight_line: bool = False
    route_engine: str | None = None
    udid: str | None = None
    # Number of laps to run before auto-stopping. None / 0 / negative means
    # infinite laps (current default behaviour, user stops manually).
    lap_count: int | None = None
    # Jump mode: teleport point-to-point instead of walking the routed
    # path. jump_pre_delay is the wait before each teleport; jump_post_delay
    # is the wait after. Both honour pause/stop so the user can interrupt.
    jump_mode: bool = False
    jump_pre_delay: float = 2.0
    jump_post_delay: float = 4.0


class MultiStopRequest(BaseModel):
    waypoints: list[Coordinate]
    mode: MovementMode = MovementMode.WALKING
    stop_duration: int = 0
    loop: bool = False
    speed_kmh: float | None = None
    speed_min_kmh: float | None = None
    speed_max_kmh: float | None = None
    pause_enabled: bool = True
    pause_min: float = 5.0
    pause_max: float = 20.0
    straight_line: bool = False
    route_engine: str | None = None
    udid: str | None = None
    # Jump mode: teleport point-to-point instead of walking the routed
    # path. See LoopRequest.jump_mode for details.
    jump_mode: bool = False
    jump_pre_delay: float = 2.0
    jump_post_delay: float = 4.0


class RandomWalkRequest(BaseModel):
    center: Coordinate
    radius_m: float = 500.0
    mode: MovementMode = MovementMode.WALKING
    speed_kmh: float | None = None
    speed_min_kmh: float | None = None
    speed_max_kmh: float | None = None
    pause_enabled: bool = True
    pause_min: float = 5.0
    pause_max: float = 20.0
    straight_line: bool = False
    route_engine: str | None = None
    udid: str | None = None
    # Dual-device group mode: both devices pass the same seed so they pick
    # identical sequences of random destinations, keeping their paths synced.
    seed: int | None = None
    # Where the sampling circle sits each leg:
    #   "fixed"  → pinned to the start point (bounded walk, never leaves it)
    #   "follow" → re-centred on the current position (free wander, drifts)
    center_mode: str = "fixed"
    # Directional persistence (correlated random walk) so the path flows
    # forward instead of doubling straight back onto the road it just walked.
    forward_enabled: bool = False
    forward_turn_deg: float = 35.0


class JoystickStartRequest(BaseModel):
    mode: MovementMode = MovementMode.WALKING
    speed_kmh: float | None = None
    udid: str | None = None


class JoystickInput(BaseModel):
    direction: float = Field(ge=0, le=360)
    intensity: float = Field(ge=0, le=1)


class GoldDittoCycleRequest(BaseModel):
    lat: float = Field(ge=-90.0, le=90.0)
    lng: float = Field(ge=-180.0, le=180.0)
    udid: str | None = None


# ── Simulation status ────────────────────────────────────
class SimulationStatus(BaseModel):
    state: SimulationState = SimulationState.IDLE
    current_position: Coordinate | None = None
    destination: Coordinate | None = None
    progress: float = 0.0
    speed_mps: float = 0.0
    eta_seconds: float = 0.0
    eta_arrival: str = ""
    distance_remaining: float = 0.0
    distance_traveled: float = 0.0
    lap_count: int = 0
    segment_index: int = 0
    total_segments: int = 0
    cooldown_remaining: float = 0.0
    is_paused: bool = False


# ── Route ─────────────────────────────────────────────────
class RoutePlanRequest(BaseModel):
    start: Coordinate
    end: Coordinate
    profile: str = "foot"


class RouteCategory(BaseModel):
    id: str = ""
    name: str
    color: str = "#6c8cff"
    sort_order: int = 0
    created_at: str = ""


class SavedRoute(BaseModel):
    id: str = ""
    name: str
    waypoints: list[Coordinate]
    profile: str = "walking"
    created_at: str = ""
    # Default keeps legacy routes.json files (which have no category_id field)
    # working with no migration step: pydantic populates "default" on load.
    category_id: str = "default"
    # Set whenever the route is replaced (PUT /saved/{id}) so the UI can
    # show a "last modified" timestamp distinct from created_at.
    updated_at: str = ""


class RouteMoveRequest(BaseModel):
    route_ids: list[str]
    target_category_id: str


class RouteStore(BaseModel):
    categories: list[RouteCategory] = []
    routes: list[SavedRoute] = []


# ── Bookmarks ─────────────────────────────────────────────
class BookmarkCategory(BaseModel):
    id: str = ""
    name: str
    color: str = "#6c8cff"
    sort_order: int = 0
    created_at: str = ""


class Bookmark(BaseModel):
    id: str = ""
    name: str
    lat: float
    lng: float
    address: str = ""
    category_id: str = "default"
    created_at: str = ""
    last_used_at: str = ""
    # ISO 3166-1 alpha-2 (lowercase), populated at add time via reverse
    # geocode. Used to render a flag next to the bookmark. Empty = unknown
    # (legacy bookmarks or offline-added); UI simply skips the flag.
    country_code: str = ""


class BookmarkMoveRequest(BaseModel):
    bookmark_ids: list[str]
    target_category_id: str


class BookmarkStore(BaseModel):
    categories: list[BookmarkCategory] = []
    bookmarks: list[Bookmark] = []


# ── Cooldown ──────────────────────────────────────────────
class CooldownSettings(BaseModel):
    enabled: bool = True


class CooldownStatus(BaseModel):
    enabled: bool = True
    is_active: bool = False
    remaining_seconds: float = 0.0
    total_seconds: float = 0.0
    distance_km: float = 0.0


# ── Coord format ─────────────────────────────────────────
class CoordFormatRequest(BaseModel):
    format: CoordinateFormat


# ── Geocoding ─────────────────────────────────────────────
class GeocodingResult(BaseModel):
    display_name: str
    lat: float
    lng: float
    type: str = ""
    importance: float = 0.0
    country_code: str = ""  # ISO 3166-1 alpha-2 (lowercase), for flag lookup
    # Short, human-friendly name for UI (bookmark auto-name, POI label).
    # Picks the best available tag from Nominatim's address details.
    short_name: str = ""


class TimezoneInfo(BaseModel):
    zone: str  # IANA zone, e.g. 'Asia/Taipei'
    gmt_offset_seconds: int  # offset vs UTC in seconds (positive = east)
    abbreviation: str = ""  # e.g. 'CST', 'EDT'
    timestamp: int = 0  # unix timestamp at the zone's current wall time


class NearbyPoi(BaseModel):
    id: str
    name: str
    category: str  # 'amenity', 'shop', 'tourism', etc.
    subcategory: str  # 'restaurant', 'cafe', ...
    lat: float
    lng: float
    distance_m: float


class RouteOptimizeRequest(BaseModel):
    waypoints: list[Coordinate]
    profile: str = "foot"  # 'foot' or 'car'
    keep_first: bool = True  # first waypoint is the fixed start
    # Routing engine for the duration matrix used by the TSP solver.
    # The selected engine drives the simulation path between points;
    # for ordering we additionally cascade across matrix providers
    # (OSRM /table → Valhalla /sources_to_targets → haversine) since
    # BRouter has no matrix API of its own. used_estimate is only set
    # when every road-aware matrix is unavailable.
    engine: str = "osrm"
    # When the user moves in straight lines (no OSRM), order by straight-line
    # (haversine) distance instead of road duration. Road-based ordering is
    # wrong for crow-flight travel; here haversine IS the real distance.
    straight_line: bool = False


class RouteOptimizeResponse(BaseModel):
    waypoints: list[Coordinate]
    total_distance_m: float
    total_duration_s: float
    # True when the durations came from a straight-line haversine fallback
    # (OSRM /table unavailable or too many waypoints). Frontend uses this
    # to label the result as an estimate vs a road-distance optimum.
    used_estimate: bool = False
