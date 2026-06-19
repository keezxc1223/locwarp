"""種花模式 navigator -- circle around each waypoint (flower)."""

from __future__ import annotations

import logging
import math

from models.schemas import Coordinate, MovementMode, SimulationState
from config import resolve_speed_profile
from core.multi_stop import jump_wait

logger = logging.getLogger(__name__)


def _circle_points(center: Coordinate, radius_m: float, segments: int) -> list[Coordinate]:
    """Return ``segments`` evenly-spaced points on a circle of ``radius_m``
    metres around ``center``. A simple equirectangular offset is accurate
    enough at the small (tens of metres) radii this mode uses."""
    segments = max(3, int(segments))
    radius_m = max(1.0, float(radius_m))
    coslat = max(math.cos(math.radians(center.lat)), 1e-6)
    pts: list[Coordinate] = []
    for k in range(segments):
        ang = 2.0 * math.pi * k / segments
        dlat = (radius_m * math.cos(ang)) / 111_320.0
        dlng = (radius_m * math.sin(ang)) / (111_320.0 * coslat)
        pts.append(Coordinate(lat=center.lat + dlat, lng=center.lng + dlng))
    return pts


def _circle_path(center: Coordinate, pts: list[Coordinate], circles: int) -> list[Coordinate]:
    """Build the walked path: out to the first vertex, then ``circles`` full
    laps around the polygon, each closing back on the first vertex."""
    circles = max(1, int(circles))
    seq: list[Coordinate] = [center, pts[0]]
    for _ in range(circles):
        for k in range(1, len(pts)):
            seq.append(pts[k])
        seq.append(pts[0])  # close this lap
    return seq


class FlowerHandler:
    """Visit each waypoint and walk a circle around it."""

    def __init__(self, engine):
        self.engine = engine

    async def start(
        self,
        waypoints: list[Coordinate],
        mode: MovementMode,
        *,
        radius_m: float = 30.0,
        segments: int = 8,
        circles: int = 1,
        rounds: int = 1,
        pre_wait: float = 3.0,
        post_wait: float = 3.0,
        teleport: bool = False,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
        straight_line: bool = False,
        route_engine: str | None = None,
    ) -> None:
        engine = self.engine

        if not waypoints:
            raise ValueError("At least 1 waypoint is required for flower mode")

        if engine.current_position is None and not teleport:
            raise RuntimeError(
                "Cannot start flower mode: no current position. Teleport first."
            )

        radius_m = max(1.0, float(radius_m))
        segments = max(3, int(segments))
        circles = max(1, int(circles))
        rounds = max(1, int(rounds))
        pre_wait = max(0.0, float(pre_wait))
        post_wait = max(0.0, float(post_wait))

        profile_name = mode.value
        osrm_profile = "foot" if mode in (MovementMode.WALKING, MovementMode.RUNNING) else "car"

        def _pick_profile() -> dict:
            if engine._speed_was_applied and engine._active_speed_profile is not None:
                return dict(engine._active_speed_profile)
            return resolve_speed_profile(
                profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
            )

        engine.state = SimulationState.FLOWER
        engine.lap_count = 0
        engine.segment_index = 0
        engine.total_segments = len(waypoints)
        engine.distance_traveled = 0.0
        # No named-waypoint highlighting in this mode; the circle steps would
        # otherwise spam waypoint_progress events.
        engine._user_waypoints = []
        engine._user_waypoint_next = 0

        await engine._emit("state_change", {
            "state": engine.state.value,
            "waypoints": [{"lat": wp.lat, "lng": wp.lng} for wp in waypoints],
        })

        # Display polyline: draw every flower's circle so the map shows the
        # planned loops before/while the device walks them.
        display: list[dict] = []
        for wp in waypoints:
            pts = _circle_points(wp, radius_m, segments)
            for p in pts:
                display.append({"lat": p.lat, "lng": p.lng})
            display.append({"lat": pts[0].lat, "lng": pts[0].lng})
        await engine._emit("route_path", {"coords": display})

        logger.info(
            "Flower mode started: %d flowers, radius=%.0fm, seg=%d, circles=%d, rounds=%d, "
            "pre=%.1fs post=%.1fs, %s [%s]",
            len(waypoints), radius_m, segments, circles, rounds,
            pre_wait, post_wait, "teleport" if teleport else "walk", profile_name,
        )

        total_flowers = len(waypoints)
        for r in range(rounds):
            if engine._stop_event.is_set():
                break
            for idx, wp in enumerate(waypoints):
                if engine._stop_event.is_set():
                    break

                # ── Pre-move wait ──
                if pre_wait > 0:
                    if await jump_wait(engine, pre_wait, source="flower"):
                        break
                if engine._stop_event.is_set():
                    break

                # ── Travel to the flower ──
                if teleport or engine.current_position is None:
                    await engine._set_position(wp.lat, wp.lng)
                    await engine._emit("position_update", {
                        "lat": wp.lat, "lng": wp.lng,
                        "speed_mps": 0.0,
                        "progress": 0.0,
                        "distance_remaining": 0.0,
                        "distance_traveled": engine.distance_traveled,
                        "eta_seconds": 0.0,
                    })
                else:
                    try:
                        route_data = await engine.route_service.get_route(
                            engine.current_position.lat, engine.current_position.lng,
                            wp.lat, wp.lng,
                            profile=osrm_profile,
                            force_straight=straight_line,
                            engine=route_engine,
                        )
                        coords = [Coordinate(lat=pt[0], lng=pt[1]) for pt in route_data["coords"]]
                    except Exception:
                        logger.warning("Flower: route to flower %d failed; teleporting", idx + 1)
                        coords = [wp]
                    if len(coords) >= 2:
                        engine._user_waypoints = []
                        engine._user_waypoint_next = 0
                        await engine._move_along_route(coords, _pick_profile())
                    else:
                        await engine._set_position(wp.lat, wp.lng)
                if engine._stop_event.is_set():
                    break

                # ── Post-arrival wait ──
                if post_wait > 0:
                    if await jump_wait(engine, post_wait, source="flower"):
                        break
                if engine._stop_event.is_set():
                    break

                # ── Walk the circle(s) ──
                # The circle is ALWAYS walked (interpolated), even when
                # teleport is on. The teleport toggle only governs how the
                # device reaches the flower; circling it is on-foot so the
                # game registers the loop. `segments` sets the polygon
                # smoothness (more = rounder, fewer = 省座標).
                pts = _circle_points(wp, radius_m, segments)
                seq = _circle_path(wp, pts, circles)
                engine._user_waypoints = []
                engine._user_waypoint_next = 0
                await engine._move_along_route(seq, _pick_profile())

                await engine._emit("flower_progress", {
                    "current_index": idx,
                    "total": total_flowers,
                    "round": r + 1,
                    "rounds": rounds,
                })

                if engine._stop_event.is_set():
                    break

            if engine._stop_event.is_set():
                break
            engine.lap_count += 1
            if rounds > 1:
                await engine._emit("lap_complete", {
                    "lap": engine.lap_count, "total": rounds,
                })

        if engine.state == SimulationState.FLOWER:
            engine.state = SimulationState.IDLE
            await engine._emit("flower_complete", {"rounds": engine.lap_count})
            await engine._emit("state_change", {"state": engine.state.value})

        logger.info("Flower mode finished after %d rounds", engine.lap_count)
