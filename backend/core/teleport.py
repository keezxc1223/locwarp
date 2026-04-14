"""Teleport handler -- instantly move to a coordinate."""

from __future__ import annotations

import logging

from models.schemas import Coordinate, SimulationState

logger = logging.getLogger(__name__)


class TeleportHandler:
    """Sets the simulated device location to a coordinate immediately."""

    def __init__(self, engine):
        self.engine = engine

    async def teleport(self, lat: float, lng: float) -> Coordinate:
        """Teleport to the given coordinate.

        - Stops any running movement task first.
        - Sets state to TELEPORTING briefly, then IDLE.
        - Returns the new position.
        """
        engine = self.engine

        # Stop any active simulation first (including PAUSED — must unblock the
        # pause event and cancel the active task before overwriting the position)
        if engine.state not in (SimulationState.IDLE, SimulationState.DISCONNECTED):
            await engine.stop()

        engine.state = SimulationState.TELEPORTING
        await engine._emit("state_change", {"state": engine.state.value})

        try:
            await engine._set_position(lat, lng)
            logger.info("Teleported to (%.6f, %.6f)", lat, lng)
            await engine._emit("teleport", {"lat": lat, "lng": lng})
        finally:
            engine.state = SimulationState.IDLE
            await engine._emit("state_change", {"state": engine.state.value})

        return Coordinate(lat=lat, lng=lng)
