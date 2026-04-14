"""
GeofenceService — 地理圍欄
設定一個圓形區域，GPS 移出邊界時廣播事件並可選自動回到中心點。
"""
from __future__ import annotations
import math
import logging

logger = logging.getLogger(__name__)


def _haversine(lat1, lng1, lat2, lng2) -> float:
    R = 6_371_000
    p = math.pi / 180
    a = (math.sin((lat2-lat1)*p/2)**2 +
         math.cos(lat1*p)*math.cos(lat2*p)*math.sin((lng2-lng1)*p/2)**2)
    return 2*R*math.asin(math.sqrt(a))


class GeofenceService:
    def __init__(self):
        self.enabled = False
        self.center_lat: float | None = None
        self.center_lng: float | None = None
        self.radius_m: float = 500.0
        self.auto_return: bool = True   # 超出邊界自動回到中心
        self._violated = False

    def set(self, lat: float, lng: float, radius_m: float, auto_return: bool = True):
        self.center_lat = lat
        self.center_lng = lng
        self.radius_m = radius_m
        self.auto_return = auto_return
        self.enabled = True
        self._violated = False
        logger.info("Geofence set: (%.6f,%.6f) r=%.0fm", lat, lng, radius_m)

    def clear(self):
        self.enabled = False
        self._violated = False
        logger.info("Geofence cleared")

    def get_status(self) -> dict:
        return {
            "enabled": self.enabled,
            "center": {"lat": self.center_lat, "lng": self.center_lng} if self.enabled else None,
            "radius_m": self.radius_m,
            "auto_return": self.auto_return,
            "violated": self._violated,
        }

    async def check(self, lat: float, lng: float) -> bool:
        """Check position. Returns True if boundary was just violated (new violation)."""
        if not self.enabled or self.center_lat is None:
            return False
        dist = _haversine(self.center_lat, self.center_lng, lat, lng)
        if dist > self.radius_m:
            if not self._violated:
                self._violated = True
                logger.warning("Geofence violated at (%.6f,%.6f) dist=%.0fm", lat, lng, dist)
                return True
        else:
            self._violated = False
        return False
