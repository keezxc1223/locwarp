"""
ScheduledReturn — 定時回到預設點服務
使用者設定倒數時間，時間到後自動停止模擬並跳回 home position。
"""
from __future__ import annotations

import asyncio
import logging
import time

logger = logging.getLogger(__name__)


class ScheduledReturn:
    """定時回到預設點。"""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._end_time: float | None = None
        self._duration: int = 0

    # ── Public API ────────────────────────────────────────

    async def start(self, seconds: int) -> None:
        """啟動倒數。到期後自動執行 teleport → home position。"""
        self.cancel()
        self._duration = seconds
        self._end_time = time.time() + seconds
        self._task = asyncio.create_task(self._run(seconds))
        logger.info("ScheduledReturn started: %d seconds", seconds)

    def cancel(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None
        self._end_time = None

    def get_status(self) -> dict:
        if self._task is None or self._task.done():
            return {"active": False, "remaining_seconds": 0, "duration_seconds": 0}
        remaining = max(0.0, self._end_time - time.time())
        return {
            "active": True,
            "remaining_seconds": round(remaining),
            "duration_seconds": self._duration,
            "end_time": self._end_time,
        }

    # ── Internal ──────────────────────────────────────────

    async def _run(self, seconds: int) -> None:
        try:
            await asyncio.sleep(seconds)
        except asyncio.CancelledError:
            logger.info("ScheduledReturn cancelled")
            return

        logger.info("ScheduledReturn expired — returning to home position")
        await self._execute_return()

    async def _execute_return(self) -> None:
        from main import app_state
        from api.websocket import broadcast

        engine = app_state.simulation_engine
        if engine is None:
            logger.warning("ScheduledReturn: no engine — skip")
            return

        # 取得 home position
        home = app_state._home_position or app_state._last_position
        if not home:
            home = {"lat": 25.0478, "lng": 121.5170}  # 台北車站預設

        try:
            # 停止目前模擬
            await engine.restore()
            # 跳回 home
            await engine.teleport(home["lat"], home["lng"])
            logger.info("ScheduledReturn: teleported to (%.6f, %.6f)", home["lat"], home["lng"])
            await broadcast("timer_expired", {
                "message": "定時結束，已回到預設點",
                "lat": home["lat"],
                "lng": home["lng"],
            })
        except Exception as exc:
            logger.error("ScheduledReturn execute failed: %s", exc)
        finally:
            self._task = None
            self._end_time = None
