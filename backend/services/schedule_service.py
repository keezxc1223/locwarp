"""
ScheduleService — 排程跳點
設定時間表，到了指定時間自動跳到指定座標。
"""
from __future__ import annotations
import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field, asdict

logger = logging.getLogger(__name__)


@dataclass
class ScheduleEntry:
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    hour: int = 0          # 0-23
    minute: int = 0        # 0-59
    lat: float = 0.0
    lng: float = 0.0
    label: str = ""
    enabled: bool = True
    repeat_daily: bool = True   # 每天重複
    last_run_day: int = -1      # 避免同一天重複執行 (date.toordinal)


class ScheduleService:
    def __init__(self):
        self._entries: list[ScheduleEntry] = []
        self._task: asyncio.Task | None = None

    # ── CRUD ─────────────────────────────────────────────

    def add(self, hour: int, minute: int, lat: float, lng: float,
            label: str = "", repeat: bool = True) -> ScheduleEntry:
        e = ScheduleEntry(hour=hour, minute=minute, lat=lat, lng=lng,
                          label=label, repeat_daily=repeat)
        self._entries.append(e)
        logger.info("Schedule added: %s @ %02d:%02d", e.id, hour, minute)
        return e

    def remove(self, entry_id: str) -> bool:
        before = len(self._entries)
        self._entries = [e for e in self._entries if e.id != entry_id]
        return len(self._entries) < before

    def toggle(self, entry_id: str, enabled: bool):
        for e in self._entries:
            if e.id == entry_id:
                e.enabled = enabled
                return True
        return False

    def list_entries(self) -> list[dict]:
        return [asdict(e) for e in self._entries]

    def clear(self):
        self._entries.clear()

    # ── Background runner ─────────────────────────────────

    def start_background(self):
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._run())

    def stop_background(self):
        if self._task:
            self._task.cancel()

    async def _run(self):
        logger.info("ScheduleService background runner started")
        while True:
            try:
                await asyncio.sleep(15)   # 每 15 秒檢查一次
                await self._tick()
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("ScheduleService tick error")

    async def _tick(self):
        from datetime import datetime, date
        from main import app_state
        from api.websocket import broadcast

        now = datetime.now()
        today = date.today().toordinal()

        for e in self._entries:
            if not e.enabled:
                continue
            if now.hour != e.hour or now.minute != e.minute:
                continue
            if e.last_run_day == today:
                continue   # 今天已執行過

            e.last_run_day = today
            logger.info("Schedule trigger: %s → (%.6f, %.6f)", e.label or e.id, e.lat, e.lng)

            engine = app_state.simulation_engine
            if engine is None:
                continue
            try:
                await engine.restore()
                await engine.teleport(e.lat, e.lng)
                await broadcast("schedule_triggered", {
                    "id": e.id, "label": e.label,
                    "lat": e.lat, "lng": e.lng,
                    "time": f"{e.hour:02d}:{e.minute:02d}",
                })
            except Exception as exc:
                logger.error("Schedule execute failed for %s: %s", e.id, exc)

            if not e.repeat_daily:
                e.enabled = False
