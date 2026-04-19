"""SpeedProfile resolution — pure-function tests for config.py logic.

These functions back the navigate/loop/multistop endpoints' speed handling.
They have no I/O and are heavily branch-y, so unit tests pay off.
"""
from __future__ import annotations

from config import (
    GPS_UPDATE_INTERVAL,
    SPEED_PROFILES,
    get_osrm_profile,
    make_speed_profile,
    resolve_speed_profile,
)


class TestMakeSpeedProfile:
    def test_walking_speed_kmh_to_mps(self):
        # 5 km/h ≈ 1.39 m/s
        p = make_speed_profile(5.0)
        assert abs(p["speed_mps"] - 1.388) < 0.01
        assert p["update_interval"] == GPS_UPDATE_INTERVAL

    def test_zero_speed_clamped_to_minimum(self):
        # Engine assumes speed_mps > 0 to avoid div-by-zero
        p = make_speed_profile(0)
        assert p["speed_mps"] >= 0.1

    def test_jitter_grows_with_speed_but_capped(self):
        slow = make_speed_profile(5)
        fast = make_speed_profile(200)
        assert slow["jitter"] < fast["jitter"]
        assert fast["jitter"] <= 2.5  # documented cap


class TestResolveSpeedProfile:
    def test_default_falls_back_to_named_profile(self):
        p = resolve_speed_profile("walking")
        assert p == SPEED_PROFILES["walking"]

    def test_fixed_speed_overrides_mode(self):
        p = resolve_speed_profile("walking", speed_kmh=50)
        # 50 km/h should be much faster than walking default (1.39 m/s)
        assert p["speed_mps"] > 5

    def test_speed_range_used_when_both_bounds_set(self):
        p = resolve_speed_profile("walking", speed_min_kmh=10, speed_max_kmh=20)
        # Should be in [10/3.6, 20/3.6] m/s ≈ [2.78, 5.56]
        assert 2.7 < p["speed_mps"] < 5.6

    def test_unsorted_range_handled(self):
        # User might pass max < min — function should sort
        p = resolve_speed_profile("walking", speed_min_kmh=30, speed_max_kmh=10)
        assert 2.7 < p["speed_mps"] < 8.4


class TestOsrmProfileDecision:
    def test_walking_default_profile(self):
        assert get_osrm_profile("walking") == "foot"

    def test_running_default_profile(self):
        assert get_osrm_profile("running") == "foot"

    def test_driving_default_profile(self):
        assert get_osrm_profile("driving") == "car"

    def test_high_custom_speed_forces_car(self):
        # Even if mode is walking, a 60 km/h custom speed = vehicle profile
        assert get_osrm_profile("walking", speed_kmh=60) == "car"

    def test_low_custom_speed_keeps_foot(self):
        assert get_osrm_profile("walking", speed_kmh=10) == "foot"

    def test_speed_range_midpoint_drives_decision(self):
        # midpoint = 35 km/h > 30 → car
        assert get_osrm_profile("walking", speed_min_kmh=30, speed_max_kmh=40) == "car"
        # midpoint = 15 km/h ≤ 30 → foot
        assert get_osrm_profile("walking", speed_min_kmh=10, speed_max_kmh=20) == "foot"
