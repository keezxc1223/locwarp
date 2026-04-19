"""Restore handler -- stop simulation and clear device location."""

from __future__ import annotations

import logging

from models.schemas import SimulationState

logger = logging.getLogger(__name__)


class RestoreHandler:
    """Stops all active simulation and clears the simulated location
    on the device, restoring the real GPS signal."""

    def __init__(self, engine):
        self.engine = engine

    async def restore(self) -> None:
        """Stop everything and clear the location service.

        1. Stop any active movement task.
        2. Clear the simulated location on the device — 重試一次並強制 reconnect，
           確保 LocWarp 重啟後殘留在 iOS 的假 GPS 也能被清除。
        3. Reset engine state to IDLE.
        """
        engine = self.engine

        # Stop any running movement
        if engine.state not in (SimulationState.IDLE, SimulationState.DISCONNECTED):
            await engine.stop()

        # Clear the simulated location on the device. 第一次失敗時強制 reconnect
        # DVT/legacy channel 再試一次，處理以下情境：
        #   - LocWarp 剛重啟，舊 process 留下的 fake GPS 還在 iOS 上
        #   - DVT channel 處於 stale 狀態（螢幕鎖過／Wi-Fi 瞬斷後）
        cleared = False
        try:
            await engine.location_service.clear()
            cleared = True
            logger.info("Device location simulation cleared (restored real GPS)")
        except Exception:
            logger.exception("Initial clear failed; will retry after reconnect")

        if not cleared:
            try:
                # DvtLocationService 有 _reconnect；LegacyLocationService 有 _reset_service
                if hasattr(engine.location_service, "_reconnect"):
                    await engine.location_service._reconnect()
                elif hasattr(engine.location_service, "_reset_service"):
                    engine.location_service._reset_service()
                await engine.location_service.clear()
                logger.info("Device location cleared after reconnect retry")
            except Exception:
                logger.exception("Clear still failed after reconnect — iPhone may need reboot")

        # Reset engine state. current_position 也一併清掉，避免 UI 繼續顯示假位置
        # 讓使用者誤以為「還原沒作用」。
        engine.current_position = None
        engine.distance_traveled = 0.0
        engine.distance_remaining = 0.0
        engine.lap_count = 0
        engine.segment_index = 0
        engine.total_segments = 0
        engine.state = SimulationState.IDLE

        await engine._emit("restored", {})
        await engine._emit("state_change", {"state": engine.state.value})

        logger.info("Simulation fully restored")
