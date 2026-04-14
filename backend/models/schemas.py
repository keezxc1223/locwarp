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
    udid: str | None = None


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
    udid: str | None = None


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
    udid: str | None = None
    # Dual-device group mode: both devices pass the same seed so they pick
    # identical sequences of random destinations, keeping their paths synced.
    seed: int | None = None


class JoystickStartRequest(BaseModel):
    mode: MovementMode = MovementMode.WALKING
    speed_kmh: float | None = None
    udid: str | None = None


class JoystickInput(BaseModel):
    direction: float = Field(ge=0, le=360)
    intensity: float = Field(ge=0, le=1)


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


class SavedRoute(BaseModel):
    id: str = ""
    name: str
    waypoints: list[Coordinate]
    profile: str = "walking"
    created_at: str = ""


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
