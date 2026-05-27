"""Multi-stop navigator -- sequential navigation through multiple waypoints."""

from __future__ import annotations

import asyncio
import logging
import random

from models.schemas import Coordinate, MovementMode, SimulationState
from config import resolve_speed_profile

logger = logging.getLogger(__name__)


class MultiStopNavigator:
    """Navigate through a series of waypoints with optional pauses at each stop."""

    def __init__(self, engine):
        self.engine = engine

    async def start(
        self,
        waypoints: list[Coordinate],
        mode: MovementMode,
        stop_duration: float = 0,
        loop: bool = False,
        *,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
        pause_enabled: bool = True,
        pause_min: float = 5.0,
        pause_max: float = 20.0,
        straight_line: bool = False,
        route_engine: str | None = None,
        jump_mode: bool = False,
        jump_pre_delay: float = 2.0,
        jump_post_delay: float = 4.0,
    ) -> None:
        """Navigate through *waypoints* one leg at a time.

        Parameters
        ----------
        waypoints
            Ordered list of stops to visit.
        mode
            Movement speed profile.
        stop_duration
            Seconds to pause at each intermediate stop (0 = no pause).
        loop
            If True, loop back to the start after reaching the last
            waypoint and repeat indefinitely.
        """
        engine = self.engine

        if len(waypoints) < 2:
            raise ValueError("At least 2 waypoints are required for multi-stop")

        # Jump mode: teleport point-to-point with configurable pre / post
        # delays. Skips OSRM routing and the normal "near first waypoint?"
        # preamble because the user wants to land exactly on each stop, in
        # order, without walking. Honors loop=True to repeat. stop_duration
        # / pause_* are ignored. Both delays honour pause + stop.
        if jump_mode:
            await _run_jump_multistop(
                engine,
                waypoints,
                pre_delay=max(0.0, float(jump_pre_delay)),
                post_delay=max(0.0, float(jump_post_delay)),
                loop=loop,
            )
            return

        if engine.current_position is None:
            raise RuntimeError(
                "Cannot start multi-stop: no current position. Teleport first."
            )

        profile_name = mode.value
        osrm_profile = "foot" if mode in (MovementMode.WALKING, MovementMode.RUNNING) else "car"

        def _pick_profile() -> dict:
            # Honor mid-flight apply_speed across legs / laps; otherwise
            # re-pick from the original args (so range mode varies).
            if engine._speed_was_applied and engine._active_speed_profile is not None:
                return dict(engine._active_speed_profile)
            return resolve_speed_profile(
                profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
            )

        # Resume support: when this engine is taking over from a peer
        # that just disconnected, jump straight to the leg they were on
        # so the iPhone doesn't visibly walk back to waypoints[0] first.
        resume_snap = engine._resume_snapshot if engine._resume_snapshot and engine._resume_snapshot.get("kind") == "multi_stop" else None
        engine._resume_snapshot = None

        engine.state = SimulationState.MULTI_STOP
        engine.total_segments = len(waypoints) - 1
        if resume_snap:
            engine.lap_count = int(resume_snap.get("lap_count", 0))
            resume_seg = max(0, min(int(resume_snap.get("segment_index", 0)), len(waypoints) - 2))
            resume_uwn = int(resume_snap.get("user_waypoint_next", 1))
        else:
            engine.lap_count = 0
            resume_seg = 0
            resume_uwn = 1
        engine.segment_index = resume_seg
        engine.distance_traveled = 0.0

        # Pre-calculate full route path for display + grand total distance so
        # the UI can show total-trip ETA (like route_loop does) instead of
        # the per-leg ETA, which resets at each stop.
        all_wp_tuples = [(wp.lat, wp.lng) for wp in waypoints]
        full_total_distance = 0.0
        try:
            full_route = await engine.route_service.get_multi_route(
                all_wp_tuples, profile=osrm_profile,
                force_straight=straight_line,
                engine=route_engine,
            )
            full_total_distance = float(full_route.get("distance") or 0.0)
            await engine._emit("route_path", {
                "coords": [{"lat": pt[0], "lng": pt[1]} for pt in full_route["coords"]],
            })
        except Exception:
            logger.warning("Failed to pre-calculate full multi-stop route for display")

        await engine._emit("state_change", {
            "state": engine.state.value,
            "waypoints": [{"lat": wp.lat, "lng": wp.lng} for wp in waypoints],
            "stop_duration": stop_duration,
            "loop": loop,
        })

        logger.info(
            "Multi-stop started: %d waypoints, stop=%ds, loop=%s [%s]",
            len(waypoints), stop_duration, loop, profile_name,
        )

        # Ensure we start from the first waypoint's location
        # If we're not near the first waypoint, navigate there first.
        # Skip this preamble entirely on resume — the previous engine
        # was already past wp[0] and we want the iPhone to continue from
        # whichever leg it was on, not walk back to the start.
        if not resume_snap:
            first = waypoints[0]
            start_pos = engine.current_position
            start_dist = self._quick_distance(start_pos, first)
            if start_dist > 50:  # more than 50m away, route to the first waypoint
                route_data = await engine.route_service.get_route(
                    start_pos.lat, start_pos.lng,
                    first.lat, first.lng,
                    profile=osrm_profile,
                    force_straight=straight_line,
                    engine=route_engine,
                )
                coords = [Coordinate(lat=pt[0], lng=pt[1]) for pt in route_data["coords"]]
                if len(coords) >= 2:
                    await engine._move_along_route(coords, _pick_profile())
                    if engine._stop_event.is_set():
                        return

        # Track the named user waypoints so highlight events refer to them
        # (otherwise OSRM densification would emit indices over road points).
        engine._user_waypoints = list(waypoints)
        engine._user_waypoint_next = resume_uwn if resume_snap else 1

        # Track how much of the grand total we have already finished so the
        # offset we hand to _move_along_route reflects the remaining legs
        # after the current one.
        completed_distance = 0.0

        running = True
        first_lap = True
        while running and not engine._stop_event.is_set():
            # On each loop pass (only > 1 if loop=True) restart the highlight
            # at waypoint[1] so the UI re-highlights from the top.
            if loop and engine._user_waypoint_next >= len(waypoints):
                engine._user_waypoint_next = 1
            # New lap: reset completed distance so the total-ETA countdown
            # restarts from full trip length.
            completed_distance = 0.0
            # On a resume, the first lap starts at the leg the previous
            # engine was on instead of leg 0. Subsequent laps always
            # start from leg 0.
            leg_start = resume_seg if (first_lap and resume_snap) else 0
            for i in range(leg_start, len(waypoints) - 1):
                if engine._stop_event.is_set():
                    break

                engine.segment_index = i
                wp_a = waypoints[i]
                wp_b = waypoints[i + 1]

                logger.debug(
                    "Multi-stop leg %d/%d: (%.6f,%.6f) -> (%.6f,%.6f)",
                    i + 1, len(waypoints) - 1,
                    wp_a.lat, wp_a.lng, wp_b.lat, wp_b.lng,
                )

                # On the first leg of a resume, start from the iPhone's
                # actual current GPS instead of routing from wp_a (which
                # would teleport the iPhone back to that earlier waypoint
                # before walking forward).
                leg_origin = (
                    engine.current_position
                    if (first_lap and resume_snap and i == leg_start and engine.current_position)
                    else wp_a
                )

                # Get route for this leg
                route_data = await engine.route_service.get_route(
                    leg_origin.lat, leg_origin.lng,
                    wp_b.lat, wp_b.lng,
                    profile=osrm_profile,
                    force_straight=straight_line,
                    engine=route_engine,
                )

                coords = [Coordinate(lat=pt[0], lng=pt[1]) for pt in route_data["coords"]]
                leg_distance = float(route_data.get("distance") or 0.0)
                engine.distance_remaining = leg_distance
                # Offset for emitted ETA = meters left in future legs after
                # this one. When the grand total from get_multi_route exists,
                # derive future-leg distance from it; otherwise fall back to
                # 0 so ETA at least reflects the current leg (same as pre-fix).
                if full_total_distance > 0:
                    future_legs = max(full_total_distance - completed_distance - leg_distance, 0.0)
                else:
                    future_legs = 0.0
                engine._route_offset_remaining = future_legs

                if len(coords) >= 2:
                    await engine._move_along_route(coords, _pick_profile())

                completed_distance += leg_distance
                engine._route_offset_remaining = 0.0

                if engine._stop_event.is_set():
                    break

                # Arrived at a stop
                await engine._emit("stop_reached", {
                    "index": i + 1,
                    "total": len(waypoints),
                    "lat": wp_b.lat,
                    "lng": wp_b.lng,
                })

                # Pause at the stop. Precedence: explicit stop_duration > per-mode
                # random range (when pause_enabled). Last stop only pauses when looping.
                is_last = i == len(waypoints) - 2
                if stop_duration and stop_duration > 0:
                    this_pause = float(stop_duration)
                elif pause_enabled:
                    lo, hi = sorted((float(pause_min), float(pause_max)))
                    if lo < 0:
                        lo = 0.0
                    this_pause = random.uniform(lo, hi) if hi > 0 else 0.0
                else:
                    this_pause = 0.0
                should_pause = this_pause > 0 and (not is_last or loop)

                if should_pause:
                    logger.info("Multi-stop: pausing %.1fs at stop %d", this_pause, i + 1)
                    await engine._emit("pause_countdown", {
                        "duration_seconds": this_pause,
                        "source": "multi_stop",
                    })
                    try:
                        await asyncio.wait_for(
                            engine._stop_event.wait(),
                            timeout=this_pause,
                        )
                        break
                    except asyncio.TimeoutError:
                        pass
                    await engine._emit("pause_countdown_end", {"source": "multi_stop"})

            first_lap = False
            if not loop or engine._stop_event.is_set():
                running = False
            else:
                engine.lap_count += 1
                await engine._emit("lap_complete", {"lap": engine.lap_count})
                logger.info("Multi-stop lap %d complete", engine.lap_count)

        engine._route_offset_remaining = 0.0
        if engine.state == SimulationState.MULTI_STOP:
            engine.state = SimulationState.IDLE
            await engine._emit("multi_stop_complete", {
                "laps": engine.lap_count,
            })
            await engine._emit("state_change", {"state": engine.state.value})

        logger.info("Multi-stop finished after %d laps", engine.lap_count)

    @staticmethod
    def _quick_distance(a: Coordinate, b: Coordinate) -> float:
        """Rough distance in meters (good enough for threshold checks)."""
        import math
        dlat = math.radians(b.lat - a.lat)
        dlng = math.radians(b.lng - a.lng) * math.cos(math.radians(a.lat))
        return 6_371_000 * math.sqrt(dlat ** 2 + dlng ** 2)


async def jump_wait(engine, seconds: float, *, source: str) -> bool:
    """Sleep for *seconds*, honouring both stop and pause.

    - Stop wakes the wait immediately and returns True.
    - Pause freezes the remaining countdown: when resumed, the leftover
      time runs to completion. Without this, pause was a no-op in jump
      mode (issue #32) — the next teleport fired regardless.

    Polls in 100 ms slices so a pause that lands mid-delay takes effect
    promptly without spinning a dedicated watcher task.
    """
    remaining = max(0.0, float(seconds))
    emitted = False
    try:
        while True:
            if engine._stop_event.is_set():
                return True
            if not engine._pause_event.is_set():
                pause_task = asyncio.ensure_future(engine._pause_event.wait())
                stop_task = asyncio.ensure_future(engine._stop_event.wait())
                try:
                    await asyncio.wait(
                        {pause_task, stop_task},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                finally:
                    for t in (pause_task, stop_task):
                        if not t.done():
                            t.cancel()
                if engine._stop_event.is_set():
                    return True
            if remaining <= 0:
                return False
            if not emitted and seconds > 0:
                await engine._emit("pause_countdown", {
                    "duration_seconds": seconds,
                    "source": source,
                })
                emitted = True
            slice_s = min(remaining, 0.1)
            try:
                await asyncio.wait_for(engine._stop_event.wait(), timeout=slice_s)
                return True
            except asyncio.TimeoutError:
                remaining -= slice_s
    finally:
        if emitted:
            await engine._emit("pause_countdown_end", {"source": source})


async def _run_jump_multistop(
    engine,
    waypoints: list[Coordinate],
    *,
    pre_delay: float,
    post_delay: float,
    loop: bool,
) -> None:
    """Teleport sequentially through *waypoints*. Each stop is preceded
    by *pre_delay* seconds and followed by *post_delay* seconds. When
    *loop* is True, repeats from the first stop after reaching the last.
    Stops cleanly when ``engine._stop_event`` is set; pause freezes both
    delays."""
    engine.state = SimulationState.MULTI_STOP
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
        "stop_duration": 0,
        "loop": loop,
    })

    logger.info(
        "Jump multi-stop started: %d waypoints, pre=%.1fs post=%.1fs, loop=%s",
        len(waypoints), pre_delay, post_delay, loop,
    )

    running = True
    while running and not engine._stop_event.is_set():
        for i, wp in enumerate(waypoints):
            if engine._stop_event.is_set():
                break
            if await jump_wait(engine, pre_delay, source="multi_stop"):
                break
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
            await engine._emit("stop_reached", {
                "index": i + 1,
                "total": len(waypoints),
                "lat": wp.lat, "lng": wp.lng,
            })
            # Skip the post-delay after the very last stop on a non-looping
            # run — the simulation is finished, so the wait would just
            # delay the IDLE transition without serving any purpose.
            is_last = (i == len(waypoints) - 1)
            if is_last and not loop:
                continue
            if await jump_wait(engine, post_delay, source="multi_stop"):
                break

        if not loop or engine._stop_event.is_set():
            running = False
        else:
            engine.lap_count += 1
            await engine._emit("lap_complete", {"lap": engine.lap_count})
            logger.info("Jump multi-stop lap %d complete", engine.lap_count)

    if engine.state == SimulationState.MULTI_STOP:
        engine.state = SimulationState.IDLE
        await engine._emit("multi_stop_complete", {"laps": engine.lap_count})
        await engine._emit("state_change", {"state": engine.state.value})
    logger.info("Jump multi-stop finished after %d laps", engine.lap_count)
