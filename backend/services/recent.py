"""Recently visited places: FIFO-capped 50-entry history of teleport /
navigate / search destinations. Persisted to RECENT_PLACES_FILE so the
list survives LocWarp restarts."""

from __future__ import annotations

import json
import logging
import math
import time
from pathlib import Path
from typing import Literal

from config import RECENT_PLACES_FILE
from services.json_safe import safe_load_json, safe_write_json

logger = logging.getLogger(__name__)

MAX_ENTRIES = 50
DEDUPE_DIST_M = 10.0  # same spot if within 10m of the most-recent entry

Kind = Literal[
    "teleport",        # map right-click "瞬移到這裡"
    "navigate",        # map right-click "導航到這裡"
    "search",          # address search (resolved to a teleport)
    "coord_teleport",  # coord-input "瞬移" button
    "coord_navigate",  # coord-input "導航" button
]
_VALID_KINDS = {"teleport", "navigate", "search", "coord_teleport", "coord_navigate"}


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


class RecentPlacesManager:
    """In-memory list mirrored to disk on every write."""

    def __init__(self) -> None:
        self.entries: list[dict] = []
        self._load()

    def _load(self) -> None:
        data = safe_load_json(Path(RECENT_PLACES_FILE))
        if data is None:
            return
        if isinstance(data, list):
            self.entries = [e for e in data if self._valid(e)][:MAX_ENTRIES]
            logger.info("Loaded %d recent places", len(self.entries))

    def _save(self) -> None:
        safe_write_json(Path(RECENT_PLACES_FILE), self.entries)

    @staticmethod
    def _valid(entry: dict) -> bool:
        try:
            lat = float(entry.get("lat"))
            lng = float(entry.get("lng"))
            if not (-90 <= lat <= 90 and -180 <= lng <= 180):
                return False
            if entry.get("kind") not in _VALID_KINDS:
                return False
            return True
        except (TypeError, ValueError):
            return False

    def list(self) -> list[dict]:
        return list(self.entries)

    def push(self, lat: float, lng: float, kind: Kind, name: str | None = None) -> dict:
        """Add a new entry to the front of the list.

        If the incoming coord is within DEDUPE_DIST_M of the current
        top entry, we refresh that entry's timestamp + optionally its
        name instead of adding a duplicate — this keeps the list useful
        when the user repeatedly clicks the same bookmark / coord.
        """
        now = int(time.time())
        new_entry = {
            "lat": float(lat), "lng": float(lng),
            "kind": kind,
            "name": (name or "").strip(),
            "ts": now,
        }
        if self.entries:
            top = self.entries[0]
            d = _haversine_m(top["lat"], top["lng"], lat, lng)
            if d < DEDUPE_DIST_M:
                top["ts"] = now
                if new_entry["name"] and not top.get("name"):
                    top["name"] = new_entry["name"]
                # Intentionally preserve the original kind. Re-flying a
                # search result via the map's Recent popover calls
                # handleTeleport under the hood, and if we overwrote
                # kind we'd silently demote "地址" rows to "瞬移" on
                # every re-fly.
                self._save()
                return top
        self.entries.insert(0, new_entry)
        if len(self.entries) > MAX_ENTRIES:
            self.entries = self.entries[:MAX_ENTRIES]
        self._save()
        return new_entry

    def clear(self) -> None:
        self.entries = []
        self._save()


_singleton: RecentPlacesManager | None = None


def get_manager() -> RecentPlacesManager:
    global _singleton
    if _singleton is None:
        _singleton = RecentPlacesManager()
    return _singleton
