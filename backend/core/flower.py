"""種花模式 navigator -- circle around each waypoint (flower)."""

from __future__ import annotations

import asyncio
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
    segments = min(20, max(3, int(segments)))
    radius_m = max(1.0, float(radius_m))
    coslat = max(math.cos(math.radians(center.lat)), 1e-6)
    pts: list[Coordinate] = []
    for k in range(segments):
        ang = 2.0 * math.pi * k / segments
        dlat = (radius_m * math.cos(ang)) / 111_320.0
        dlng = (radius_m * math.sin(ang)) / (111_320.0 * coslat)
        pts.append(Coordinate(lat=center.lat + dlat, lng=center.lng + dlng))
    return pts


def _circle_path(center: Coordinate, pts: list[Coordinate], circles: float) -> list[Coordinate]:
    """Build the walked path: out to the first vertex, then ``circles`` laps
    around the polygon. ``circles`` may be fractional (e.g. 0.5 = half a lap),
    in which case only that fraction of the polygon edges is walked."""
    circles = max(0.5, float(circles))
    n = len(pts)
    total_edges = max(1, round(circles * n))
    seq: list[Coordinate] = [center, pts[0]]
    for e in range(1, total_edges + 1):
        seq.append(pts[e % n])  # cycle around the polygon
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
        circles: float = 1.0,
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
        segments = min(20, max(3, int(segments)))
        circles = max(0.5, round(float(circles) * 2) / 2)  # snap to 0.5 steps
        rounds = max(1, int(rounds))
        pre_wait = max(0.0, float(pre_wait))
        post_wait = max(0.0, float(post_wait))

        # Shared by every device in a group so speed picks match.
        sync_rng = engine.take_sync_rng()

        profile_name = mode.value
        osrm_profile = "foot" if mode in (MovementMode.WALKING, MovementMode.RUNNING) else "car"

        def _pick_profile() -> dict:
            if engine._speed_was_applied and engine._active_speed_profile is not None:
                return dict(engine._active_speed_profile)
            return resolve_speed_profile(
                profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
                rng=sync_rng,
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
            "Flower mode started: %d flowers, radius=%.0fm, seg=%d, circles=%.1f, rounds=%d, "
            "pre=%.1fs post=%.1fs, %s [%s]",
            len(waypoints), radius_m, segments, circles, rounds,
            pre_wait, post_wait, "teleport" if teleport else "walk", profile_name,
        )

        class _PushFailed(Exception):
            """A route leg gave up on repeated push failures."""

        async def _walk(coords: list[Coordinate]) -> None:
            engine._user_waypoints = []
            engine._user_waypoint_next = 0
            await engine._move_along_route(coords, _pick_profile())
            if engine._route_push_failed and not engine._stop_event.is_set():
                raise _PushFailed()

        async def _visit(idx: int, wp: Coordinate) -> bool:
            """Run one flower. Returns True when the mode should stop."""
            # ── Pre-move wait ──
            if pre_wait > 0:
                if await jump_wait(engine, pre_wait, source="flower"):
                    return True
            if engine._stop_event.is_set():
                return True

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
                    await _walk(coords)
                else:
                    await engine._set_position(wp.lat, wp.lng)
            if engine._stop_event.is_set():
                return True

            # ── Post-arrival wait ──
            if post_wait > 0:
                if await jump_wait(engine, post_wait, source="flower"):
                    return True
            if engine._stop_event.is_set():
                return True

            # ── Walk the circle(s) ──
            # The circle is ALWAYS walked (interpolated), even when
            # teleport is on. The teleport toggle only governs how the
            # device reaches the flower; circling it is on-foot so the
            # game registers the loop. `segments` sets the polygon
            # smoothness (more = rounder, fewer = 省座標).
            pts = _circle_points(wp, radius_m, segments)
            await _walk(_circle_path(wp, pts, circles))
            return engine._stop_event.is_set()

        # Connection drops (screen lock, WiFi blip, DVT channel reset) must
        # not skip flowers or kill the run: retry the same flower with
        # backoff, mirroring random walk's retry budget.
        max_conn_errors = 60

        total_flowers = len(waypoints)
        aborted = False
        for r in range(rounds):
            if aborted or engine._stop_event.is_set():
                break
            for idx, wp in enumerate(waypoints):
                if engine._stop_event.is_set():
                    break

                conn_errors = 0
                stopped = False
                while True:
                    try:
                        stopped = await _visit(idx, wp)
                        break
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        conn_errors += 1
                        backoff = min(5.0 * (2 ** min(conn_errors - 1, 5)), 30.0)
                        logger.warning(
                            "Flower %d: push failed (%s), retry %d/%d in %.0fs",
                            idx + 1, exc.__class__.__name__,
                            conn_errors, max_conn_errors, backoff,
                        )
                        if conn_errors >= max_conn_errors:
                            logger.error(
                                "Flower: device unreachable after %d attempts, stopping",
                                conn_errors,
                            )
                            stopped = True
                            break
                        await engine._emit("connection_lost", {
                            "retry": conn_errors,
                            "max_retries": max_conn_errors,
                            "next_retry_seconds": backoff,
                        })
                        try:
                            await asyncio.wait_for(
                                engine._stop_event.wait(), timeout=backoff,
                            )
                            stopped = True
                            break
                        except asyncio.TimeoutError:
                            pass
                if stopped:
                    aborted = True
                    break

                await engine._emit("flower_progress", {
                    "current_index": idx,
                    "total": total_flowers,
                    "round": r + 1,
                    "rounds": rounds,
                })

                if engine._stop_event.is_set():
                    break

            if aborted or engine._stop_event.is_set():
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
