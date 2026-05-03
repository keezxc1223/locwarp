"""Route looper -- infinitely loop through a closed route."""

from __future__ import annotations

import asyncio
import logging
import random

from models.schemas import Coordinate, MovementMode, SimulationState
from config import resolve_speed_profile

logger = logging.getLogger(__name__)


class RouteLooper:
    """Creates a closed route through waypoints and loops it indefinitely."""

    def __init__(self, engine):
        self.engine = engine

    async def start_loop(
        self,
        waypoints: list[Coordinate],
        mode: MovementMode,
        *,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
        pause_enabled: bool = True,
        pause_min: float = 5.0,
        pause_max: float = 20.0,
        straight_line: bool = False,
        route_engine: str | None = None,
        lap_count: int | None = None,
        jump_mode: bool = False,
        jump_interval: float = 12.0,
    ) -> None:
        """Build a multi-waypoint route that forms a closed loop, then
        traverse it repeatedly until stopped.

        Parameters
        ----------
        waypoints
            Ordered waypoints forming the loop. The route will be closed
            by appending the first waypoint at the end.
        mode
            Movement mode determining speed profile.
        """
        engine = self.engine

        if len(waypoints) < 2:
            raise ValueError("At least 2 waypoints are required for a loop")

        # Jump mode: teleport point-to-point with a fixed dwell interval
        # instead of walking. Skips OSRM routing entirely. Resume / per-
        # station random pause / speed profile are not used in this mode
        # because there's no continuous movement to interpolate.
        if jump_mode:
            await _run_jump_loop(
                engine,
                waypoints,
                interval=max(0.0, float(jump_interval)),
                lap_count=lap_count,
                close_loop=True,
            )
            return

        profile_name = mode.value
        osrm_profile = "foot" if mode in (MovementMode.WALKING, MovementMode.RUNNING) else "car"

        # Close the loop: append the first waypoint at the end
        closed_waypoints = list(waypoints) + [waypoints[0]]

        # Build OSRM route through all waypoints
        wp_tuples = [(wp.lat, wp.lng) for wp in closed_waypoints]
        route_data = await engine.route_service.get_multi_route(
            wp_tuples, profile=osrm_profile,
            force_straight=straight_line,
            engine=route_engine,
        )

        coords = [Coordinate(lat=pt[0], lng=pt[1]) for pt in route_data["coords"]]

        if len(coords) < 2:
            raise ValueError("OSRM returned an empty route for the loop")

        # Resume support: when we're taking over a loop from a peer
        # engine that just disconnected, jump straight to the segment
        # they were on and inherit their lap count instead of starting
        # the closed-loop traversal at coords[0] (which would teleport
        # the iPhone back to waypoints[0]).
        resume_snap = engine._resume_snapshot if engine._resume_snapshot and engine._resume_snapshot.get("kind") == "start_loop" else None
        engine._resume_snapshot = None

        engine.state = SimulationState.LOOPING
        engine.total_segments = len(coords) - 1
        if resume_snap:
            engine.lap_count = int(resume_snap.get("lap_count", 0))
            resume_seg = max(0, min(int(resume_snap.get("segment_index", 0)), len(coords) - 1))
            resume_uwn = int(resume_snap.get("user_waypoint_next", 1))
        else:
            engine.lap_count = 0
            resume_seg = 0
            resume_uwn = 1 if len(waypoints) > 1 else 0
        engine.segment_index = resume_seg

        await engine._emit("route_path", {
            "coords": [{"lat": c.lat, "lng": c.lng} for c in coords],
        })
        await engine._emit("state_change", {
            "state": engine.state.value,
            "waypoints": [{"lat": wp.lat, "lng": wp.lng} for wp in waypoints],
        })

        logger.info("Starting route loop with %d waypoints [%s]%s",
                    len(waypoints), profile_name,
                    f" (resuming at segment {resume_seg}, lap {engine.lap_count})" if resume_snap else "")

        # Helper that re-picks the speed profile per lap. If the user applied
        # a speed mid-flight, that takes precedence; otherwise re-resolve from
        # the original args (so range mode produces per-lap variation).
        def _pick_profile() -> dict:
            if engine._speed_was_applied and engine._active_speed_profile is not None:
                return dict(engine._active_speed_profile)
            return resolve_speed_profile(
                profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
            )

        # Per-station pause sampler. Returns a non-negative duration; 0 means
        # "skip the pause entirely".
        def _next_pause_seconds() -> float:
            if not pause_enabled:
                return 0.0
            lo, hi = sorted((float(pause_min), float(pause_max)))
            if lo < 0:
                lo = 0.0
            if hi <= 0:
                return 0.0
            return random.uniform(lo, hi)

        async def _pause_at_stop(stop_index: int) -> bool:
            """Pause for a random duration. Returns True if the simulation was
            stopped during the pause (caller should break out of its loop)."""
            secs = _next_pause_seconds()
            if secs <= 0:
                return False
            logger.info("Loop: pausing %.1fs at stop %d", secs, stop_index)
            await engine._emit("pause_countdown", {
                "duration_seconds": secs,
                "source": "loop",
            })
            try:
                await asyncio.wait_for(engine._stop_event.wait(), timeout=secs)
                return True
            except asyncio.TimeoutError:
                pass
            await engine._emit("pause_countdown_end", {"source": "loop"})
            return False

        first_iteration = True
        # Loop until stopped. Each iteration walks one full lap by routing
        # leg-by-leg between user waypoints (mirrors multi_stop) so we can
        # pause at each station, not just between laps.
        while not engine._stop_event.is_set():
            engine.distance_traveled = 0.0
            engine.distance_remaining = route_data["distance"]
            engine.segment_index = 0

            engine._user_waypoints = list(waypoints)
            engine._user_waypoint_next = (
                resume_uwn if first_iteration else (1 if len(waypoints) > 1 else 0)
            )

            speed_profile = _pick_profile()

            # Walk station-by-station around the closed loop.
            # closed_waypoints already has waypoints[0] appended at the end so
            # the iteration covers all legs back to the start. On a resume,
            # start at the leg the previous engine was on (resume_seg now
            # represents a leg index rather than the old densified-coord
            # index since we walk leg-by-leg).
            num_legs = len(closed_waypoints) - 1
            leg_start = resume_seg if (first_iteration and resume_snap) else 0
            leg_start = max(0, min(leg_start, num_legs - 1))
            for leg_idx in range(leg_start, num_legs):
                if engine._stop_event.is_set():
                    break

                wp_a = closed_waypoints[leg_idx]
                wp_b = closed_waypoints[leg_idx + 1]
                engine.segment_index = leg_idx

                # Resume support: on the first leg of the first lap after
                # taking over (peer handoff or live waypoint splice), start
                # from the iPhone's actual GPS instead of routing back to
                # wp_a (which would teleport to the previous waypoint).
                # Compares against leg_start, not 0, so a splice that
                # resumes at leg_idx > 0 still uses current_position.
                if first_iteration and leg_idx == leg_start and resume_snap and engine.current_position is not None:
                    leg_origin = engine.current_position
                else:
                    leg_origin = wp_a

                # Per-leg OSRM route (cheap because legs are small).
                leg_route = await engine.route_service.get_route(
                    leg_origin.lat, leg_origin.lng,
                    wp_b.lat, wp_b.lng,
                    profile=osrm_profile,
                    force_straight=straight_line,
                    engine=route_engine,
                )
                leg_coords = [Coordinate(lat=pt[0], lng=pt[1]) for pt in leg_route["coords"]]
                if len(leg_coords) >= 2:
                    await engine._move_along_route(leg_coords, speed_profile)

                if engine._stop_event.is_set():
                    break

                # Pause at every stop except the last one of the lap (the
                # closing leg lands back on waypoints[0], which becomes the
                # start of the next lap — no double-pause needed).
                is_last_leg = leg_idx == num_legs - 1
                if not is_last_leg:
                    if await _pause_at_stop(leg_idx + 1):
                        break

            first_iteration = False

            if engine._stop_event.is_set():
                break

            engine.lap_count += 1
            limit = lap_count if (lap_count is not None and lap_count > 0) else None
            await engine._emit("lap_complete", {
                "lap": engine.lap_count,
                "total": limit,
            })
            logger.info(
                "Loop lap %d%s complete",
                engine.lap_count,
                f"/{limit}" if limit else "",
            )

            # Auto-stop after the requested number of laps.
            if limit is not None and engine.lap_count >= limit:
                logger.info("Loop reached configured lap count %d, stopping", limit)
                break

            # No between-laps pause — the per-station pause already covers
            # the rest stops; jumping straight into the next lap keeps the
            # behaviour symmetric with what the user expects.

        if engine.state == SimulationState.LOOPING:
            engine.state = SimulationState.IDLE
            await engine._emit("state_change", {"state": engine.state.value})

        logger.info("Route loop stopped after %d laps", engine.lap_count)


async def _run_jump_loop(
    engine,
    waypoints: list[Coordinate],
    *,
    interval: float,
    lap_count: int | None,
    close_loop: bool,
) -> None:
    """Teleport sequentially through *waypoints*, dwelling *interval* seconds
    at each. When *close_loop* is True, the final dwell is followed by a
    teleport back to waypoints[0] (start of next lap). Stops cleanly when
    ``engine._stop_event`` is set."""
    engine.state = SimulationState.LOOPING
    engine.total_segments = len(waypoints)
    engine.lap_count = 0
    engine.segment_index = 0
    engine.distance_traveled = 0.0
    engine.distance_remaining = 0.0
    engine._user_waypoints = list(waypoints)
    engine._user_waypoint_next = 1 if len(waypoints) > 1 else 0

    await engine._emit("route_path", {
        "coords": [{"lat": wp.lat, "lng": wp.lng} for wp in waypoints],
    })
    await engine._emit("state_change", {
        "state": engine.state.value,
        "waypoints": [{"lat": wp.lat, "lng": wp.lng} for wp in waypoints],
    })

    logger.info(
        "Jump loop started: %d waypoints, interval=%.1fs, laps=%s",
        len(waypoints), interval, lap_count or "∞",
    )

    limit = lap_count if (lap_count is not None and lap_count > 0) else None

    async def _dwell() -> bool:
        """Sleep for *interval* seconds; return True if stop was requested."""
        if interval <= 0:
            return engine._stop_event.is_set()
        try:
            await asyncio.wait_for(engine._stop_event.wait(), timeout=interval)
            return True
        except asyncio.TimeoutError:
            return False

    while not engine._stop_event.is_set():
        for i, wp in enumerate(waypoints):
            if engine._stop_event.is_set():
                break
            await engine._set_position(wp.lat, wp.lng)
            engine.segment_index = i
            engine._user_waypoint_next = min(i + 1, len(waypoints))
            await engine._emit("position_update", {
                "lat": wp.lat, "lng": wp.lng,
                "speed_mps": 0.0,
                "progress": (i + 1) / max(len(waypoints), 1),
                "segment_index": i,
                "total_segments": len(waypoints),
                "lap_count": engine.lap_count,
                "distance_traveled": 0.0,
                "distance_remaining": 0.0,
                "eta_seconds": 0.0,
                "eta_arrival": "",
                "is_paused": False,
            })
            await engine._emit("user_waypoint_advance", {
                "current_index": i,
                "next_index": min(i + 1, len(waypoints) - 1),
            })
            if await _dwell():
                break

        if engine._stop_event.is_set():
            break

        # Teleport back to start before counting the lap so the visible
        # path closes (only relevant for the closed-loop mode).
        if close_loop and not engine._stop_event.is_set():
            wp0 = waypoints[0]
            await engine._set_position(wp0.lat, wp0.lng)
            await engine._emit("position_update", {
                "lat": wp0.lat, "lng": wp0.lng,
                "speed_mps": 0.0, "progress": 1.0,
                "segment_index": 0, "total_segments": len(waypoints),
                "lap_count": engine.lap_count + 1,
                "distance_traveled": 0.0, "distance_remaining": 0.0,
                "eta_seconds": 0.0, "eta_arrival": "", "is_paused": False,
            })

        engine.lap_count += 1
        await engine._emit("lap_complete", {
            "lap": engine.lap_count, "total": limit,
        })
        logger.info("Jump loop lap %d%s complete",
                    engine.lap_count, f"/{limit}" if limit else "")
        if limit is not None and engine.lap_count >= limit:
            break

    if engine.state == SimulationState.LOOPING:
        engine.state = SimulationState.IDLE
        await engine._emit("state_change", {"state": engine.state.value})
    logger.info("Jump loop stopped after %d laps", engine.lap_count)
