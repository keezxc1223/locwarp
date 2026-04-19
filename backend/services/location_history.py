"""
LocationHistory — 自動記錄最近走過的地點
儲存最近 100 筆，每筆含時間戳與可選名稱。
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path

logger = logging.getLogger(__name__)
_HISTORY_FILE = Path.home() / ".locwarp" / "location_history.json"
MAX_ENTRIES = 100
MIN_DISTANCE_M = 50  # 移動超過 50m 才新增一筆
# 每累積 5 筆才寫磁碟，減少 GPS 模擬期間的頻繁 I/O
_WRITE_BATCH_SIZE = 5


def _haversine(lat1, lng1, lat2, lng2) -> float:
    import math
    R = 6_371_000
    p = math.pi / 180
    a = (math.sin((lat2-lat1)*p/2)**2 +
         math.cos(lat1*p) * math.cos(lat2*p) * math.sin((lng2-lng1)*p/2)**2)
    return 2 * R * math.asin(math.sqrt(a))


class LocationHistory:
    def __init__(self):
        self._entries: list[dict] = []
        self._unsaved_count = 0  # 未寫入磁碟的新增筆數計數器
        self._load()

    def _load(self):
        try:
            if _HISTORY_FILE.exists():
                self._entries = json.loads(_HISTORY_FILE.read_text())
        except Exception:
            self._entries = []

    def _save(self):
        try:
            _HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
            _HISTORY_FILE.write_text(json.dumps(self._entries[-MAX_ENTRIES:], indent=2))
        except Exception as e:
            logger.warning("Failed to save history: %s", e)

    def record(self, lat: float, lng: float, name: str = "") -> None:
        """Record a position (skips if too close to last entry).

        磁碟寫入採用批量策略：每累積 _WRITE_BATCH_SIZE 筆才寫一次，
        降低 GPS 模擬期間頻繁 I/O 的系統開銷。
        呼叫 flush() 可立即強制寫入（例如程式正常關閉時）。
        """
        if self._entries:
            last = self._entries[-1]
            if _haversine(last["lat"], last["lng"], lat, lng) < MIN_DISTANCE_M:
                return
        entry = {"lat": lat, "lng": lng, "ts": time.time(), "name": name}
        self._entries.append(entry)
        if len(self._entries) > MAX_ENTRIES:
            self._entries = self._entries[-MAX_ENTRIES:]
        self._unsaved_count += 1
        # 每 _WRITE_BATCH_SIZE 筆寫一次磁碟，避免每次都 I/O
        if self._unsaved_count >= _WRITE_BATCH_SIZE:
            self._save()
            self._unsaved_count = 0

    def flush(self) -> None:
        """強制將尚未寫入的資料寫入磁碟（程式關閉時呼叫）。"""
        if self._unsaved_count > 0:
            self._save()
            self._unsaved_count = 0

    def get_all(self) -> list[dict]:
        return list(reversed(self._entries))  # newest first

    def clear(self):
        self._entries = []
        try:
            _HISTORY_FILE.unlink(missing_ok=True)
        except Exception:
            pass
