from pathlib import Path
from typing import TypedDict

# Paths
DATA_DIR = Path.home() / ".locwarp"
DATA_DIR.mkdir(exist_ok=True)
SETTINGS_FILE = DATA_DIR / "settings.json"
BOOKMARKS_FILE = DATA_DIR / "bookmarks.json"

# OSRM
OSRM_BASE_URL = "https://router.project-osrm.org"

# Nominatim
NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org"
NOMINATIM_USER_AGENT = "LocWarp/0.1"


class SpeedProfile(TypedDict):
    """Runtime speed profile consumed by the simulation engine."""
    speed_mps: float        # metres per second
    jitter: float           # ± random GPS noise radius (metres)
    update_interval: float  # tick period (seconds) — always 1.0 to match iOS 1 Hz GPS


# ── GPS update interval ────────────────────────────────────────────────────
# iOS CoreLocation 硬體 GPS 更新速率為 1 Hz。
# DVT LocationSimulation 雖可接受更快的注入，但超過 1 Hz 時 iOS 會做平滑
# 處理，導致 app 感知的速度偏離真實值。
#
# 正確做法：固定 interval = 1.0s，讓「步長 = speed_mps × 1.0s」直接決定
# 速度感知。每秒跳越的公尺數 = 手機 app 計算到的速度（km/h）。
#
#   走路   5 km/h  ≈  1.39 m/s  → 每秒移動 1.39 m  → app 顯示 ~5 km/h   ✓
#   跑步  18 km/h  ≈  5.00 m/s  → 每秒移動 5.00 m  → app 顯示 ~18 km/h  ✓
#   開車 100 km/h  ≈ 27.78 m/s  → 每秒移動 27.78 m → app 顯示 ~100 km/h ✓
GPS_UPDATE_INTERVAL = 1.0   # 秒，所有速度模式統一使用

# Speed profiles (m/s)
SPEED_PROFILES: dict[str, SpeedProfile] = {
    "walking": {"speed_mps": 1.39,  "jitter": 0.4, "update_interval": GPS_UPDATE_INTERVAL},
    "running": {"speed_mps": 5.00,  "jitter": 0.7, "update_interval": GPS_UPDATE_INTERVAL},
    "driving": {"speed_mps": 27.78, "jitter": 2.5, "update_interval": GPS_UPDATE_INTERVAL},
}


def make_speed_profile(speed_kmh: float) -> SpeedProfile:
    """Build a SpeedProfile from km/h.

    update_interval 固定為 GPS_UPDATE_INTERVAL（1.0s）。
    速度透過步長（speed_mps × 1.0s）呈現，而非加快更新頻率。
    """
    speed_mps = max(speed_kmh / 3.6, 0.1)

    # jitter：低速時小 (0.3m)，高速時稍大 (最大 2.5m) 模擬車速 GPS 誤差
    jitter = min(0.3 + speed_mps * 0.08, 2.5)

    return {
        "speed_mps": speed_mps,
        "jitter": jitter,
        "update_interval": GPS_UPDATE_INTERVAL,
    }


def resolve_speed_profile(
    profile_name: str,
    speed_kmh: float | None = None,
    speed_min_kmh: float | None = None,
    speed_max_kmh: float | None = None,
) -> SpeedProfile:
    """Return a SpeedProfile.  Precedence: range > fixed custom > mode default."""
    import random
    if speed_min_kmh is not None and speed_max_kmh is not None:
        lo, hi = sorted((float(speed_min_kmh), float(speed_max_kmh)))
        lo = max(lo, 0.1)
        return make_speed_profile(random.uniform(lo, hi))
    if speed_kmh is not None:
        return make_speed_profile(float(speed_kmh))
    return SPEED_PROFILES[profile_name]


def get_osrm_profile(
    mode: str,
    speed_kmh: float | None = None,
    speed_min_kmh: float | None = None,
    speed_max_kmh: float | None = None,
) -> str:
    """Return the OSRM routing profile string (``"foot"`` or ``"car"``) that
    best matches the requested movement mode and optional custom speed.

    Decision logic (in order):
    1. Custom speed > 30 km/h  → ``"car"``
       (avoids pedestrian-only / footpath routing for fast movement)
    2. Mode is walking or running → ``"foot"``
    3. Everything else (driving, or custom speed ≤ 30 km/h) → ``"car"``

    Parameters
    ----------
    mode:
        Movement mode string: ``"walking"``, ``"running"``, or ``"driving"``.
    speed_kmh:
        Fixed custom speed in km/h (optional).
    speed_min_kmh, speed_max_kmh:
        Speed range in km/h (optional). Midpoint is used for the decision.
    """
    # Compute the representative speed to decide the profile
    effective_kmh: float | None = speed_kmh
    if effective_kmh is None and speed_min_kmh is not None and speed_max_kmh is not None:
        effective_kmh = (float(speed_min_kmh) + float(speed_max_kmh)) / 2.0

    if effective_kmh is not None and effective_kmh > 30:
        return "car"
    if mode in ("walking", "running"):
        return "foot"
    return "car"


# Cooldown table: (max_distance_km, cooldown_seconds)
# Calibrated for Pikmin Bloom based on community research (2025–2026):
#   Pikmin Bloom is less strict than Pokémon GO, but still bans on obvious teleports.
#   Source: pokeep.com/lbs-games/pikmin-bloom-spoofing, locachange.com community reports
#   Key data points: ~100 km → 35 min recommended; ~1 000 km → 2 hr recommended.
COOLDOWN_TABLE = [
    (10,          0),      #  ≤ 10 km  — safe, no cooldown required
    (30,        300),      #  ≤ 30 km  —  5 min
    (80,       1200),      #  ≤ 80 km  — 20 min
    (150,      2100),      # ≤ 150 km  — 35 min  (community-confirmed 100 km threshold)
    (300,      2700),      # ≤ 300 km  — 45 min
    (600,      4500),      # ≤ 600 km  — 75 min
    (1000,     7200),      # ≤  1 000 km — 2 hr
    (float("inf"), 7200),  # > 1 000 km — 2 hr  (Niantic max observed)
]

# Reconnect
RECONNECT_BASE_DELAY = 2.0
RECONNECT_MAX_DELAY = 60.0
RECONNECT_MAX_RETRIES = 30

# Default location (Taipei City Hall)
DEFAULT_LOCATION = {"lat": 25.0375, "lng": 121.5637}

# Server
API_HOST = "0.0.0.0"
API_PORT = 8777
