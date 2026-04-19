"""Multi-stop navigator -- sequential navigation through multiple waypoints."""

from __future__ import annotations

import asyncio
import logging
import random

from config import get_osrm_profile, resolve_speed_profile
from models.schemas import Coordinate, MovementMode, SimulationState
from services.interpolator import RouteInterpolator

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

        if engine.current_position is None:
            raise RuntimeError(
                "Cannot start multi-stop: no current position. Teleport first."
            )

        profile_name = mode.value
        osrm_profile = get_osrm_profile(
            profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
        )

        def _pick_profile() -> dict:
            return resolve_speed_profile(
                profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
            )

        engine.state = SimulationState.MULTI_STOP
        engine.total_segments = len(waypoints) - 1
        engine.segment_index = 0
        engine.lap_count = 0
        engine.distance_traveled = 0.0

        # Pre-calculate full route path for display
        all_wp_tuples = [(wp.lat, wp.lng) for wp in waypoints]
        try:
            full_route = await engine.route_service.get_multi_route(
                all_wp_tuples, profile=osrm_profile,
            )
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
        # If we're not near the first waypoint, navigate there first
        first = waypoints[0]
        start_pos = engine.current_position
        start_dist = RouteInterpolator.haversine(
            start_pos.lat, start_pos.lng, first.lat, first.lng,
        )
        if start_dist > 50:  # more than 50m away, route to the first waypoint
            route_data = await engine.route_service.get_route(
                start_pos.lat, start_pos.lng,
                first.lat, first.lng,
                profile=osrm_profile,
            )
            coords = [Coordinate(lat=pt[0], lng=pt[1]) for pt in route_data["coords"]]
            if len(coords) >= 2:
                await engine._move_along_route(coords, _pick_profile())
                if engine._stop_event.is_set():
                    return

        running = True
        while running and not engine._stop_event.is_set():
            for i in range(len(waypoints) - 1):
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

                # Get route for this leg
                route_data = await engine.route_service.get_route(
                    wp_a.lat, wp_a.lng,
                    wp_b.lat, wp_b.lng,
                    profile=osrm_profile,
                )

                coords = [Coordinate(lat=pt[0], lng=pt[1]) for pt in route_data["coords"]]
                engine.distance_remaining = route_data["distance"]

                if len(coords) >= 2:
                    await engine._move_along_route(coords, _pick_profile())

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
                    except TimeoutError:
                        pass
                    await engine._emit("pause_countdown_end", {"source": "multi_stop"})

            if not loop or engine._stop_event.is_set():
                running = False
            else:
                engine.lap_count += 1
                await engine._emit("lap_complete", {"lap": engine.lap_count})
                logger.info("Multi-stop lap %d complete", engine.lap_count)

        if engine.state == SimulationState.MULTI_STOP:
            engine.state = SimulationState.IDLE
            await engine._emit("multi_stop_complete", {
                "laps": engine.lap_count,
            })
            await engine._emit("state_change", {"state": engine.state.value})

        logger.info("Multi-stop finished after %d laps", engine.lap_count)
