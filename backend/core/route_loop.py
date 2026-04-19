"""Route looper -- infinitely loop through a closed route."""

from __future__ import annotations

import asyncio
import logging
import random

from config import get_osrm_profile, resolve_speed_profile
from models.schemas import Coordinate, MovementMode, SimulationState

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

        profile_name = mode.value
        osrm_profile = get_osrm_profile(
            profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
        )

        # Close the loop: append the first waypoint at the end
        closed_waypoints = list(waypoints) + [waypoints[0]]

        # Build OSRM route through all waypoints
        wp_tuples = [(wp.lat, wp.lng) for wp in closed_waypoints]
        route_data = await engine.route_service.get_multi_route(
            wp_tuples, profile=osrm_profile,
        )

        coords = [Coordinate(lat=pt[0], lng=pt[1]) for pt in route_data["coords"]]

        if len(coords) < 2:
            raise ValueError("OSRM returned an empty route for the loop")

        engine.state = SimulationState.LOOPING
        engine.lap_count = 0
        engine.total_segments = len(coords) - 1
        engine.segment_index = 0

        await engine._emit("route_path", {
            "coords": [{"lat": c.lat, "lng": c.lng} for c in coords],
        })
        await engine._emit("state_change", {
            "state": engine.state.value,
            "waypoints": [{"lat": wp.lat, "lng": wp.lng} for wp in waypoints],
        })

        logger.info("Starting route loop with %d waypoints [%s]", len(waypoints), profile_name)

        # Loop until stopped
        while not engine._stop_event.is_set():
            engine.distance_traveled = 0.0
            engine.distance_remaining = route_data["distance"]
            engine.segment_index = 0

            # Re-pick speed each lap when a range is set, for realism.
            speed_profile = resolve_speed_profile(
                profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
            )
            await engine._move_along_route(coords, speed_profile)

            # Check if we were stopped during the route
            if engine._stop_event.is_set():
                break

            engine.lap_count += 1
            await engine._emit("lap_complete", {"lap": engine.lap_count})
            logger.info("Loop lap %d complete", engine.lap_count)

            # Optional random pause between laps
            if pause_enabled:
                lo, hi = sorted((float(pause_min), float(pause_max)))
                if lo < 0:
                    lo = 0.0
                if hi > 0:
                    lap_pause = random.uniform(lo, hi)
                    logger.info("Loop: pausing %.1fs before next lap", lap_pause)
                    await engine._emit("pause_countdown", {
                        "duration_seconds": lap_pause,
                        "source": "loop",
                    })
                    try:
                        await asyncio.wait_for(engine._stop_event.wait(), timeout=lap_pause)
                        # stop fired during the inter-lap pause — emit end before exiting
                        await engine._emit("pause_countdown_end", {"source": "loop"})
                        break
                    except TimeoutError:
                        pass
                    await engine._emit("pause_countdown_end", {"source": "loop"})

        if engine.state in (SimulationState.LOOPING, SimulationState.PAUSED):
            engine.state = SimulationState.IDLE
            await engine._emit("state_change", {"state": engine.state.value})

        logger.info("Route loop stopped after %d laps", engine.lap_count)
