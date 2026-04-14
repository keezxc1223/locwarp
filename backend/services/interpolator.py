"""Coordinate interpolation and GPS jitter utilities."""

from __future__ import annotations

import math
import random

from models.schemas import Coordinate

# 嘗試匯入 scipy，用於 PCHIP 插值和 RDP 化簡
try:
    from scipy.interpolate import PchipInterpolator   # 比 CubicSpline 更適合 GPS（不 overshoot）
    import numpy as np
    _SCIPY_AVAILABLE = True
except ImportError:
    _SCIPY_AVAILABLE = False

# Earth radius in meters (WGS-84 mean)
_R = 6_371_000.0


class RouteInterpolator:
    """Stateless utilities for dense-point interpolation along a polyline."""

    # ------------------------------------------------------------------
    # Distance & bearing
    # ------------------------------------------------------------------

    @staticmethod
    def haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
        """Return the great-circle distance in **meters** between two points."""
        rlat1, rlng1 = math.radians(lat1), math.radians(lng1)
        rlat2, rlng2 = math.radians(lat2), math.radians(lng2)

        dlat = rlat2 - rlat1
        dlng = rlng2 - rlng1

        a = (
            math.sin(dlat / 2) ** 2
            + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
        )
        return _R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    @staticmethod
    def bearing(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
        """Return the initial bearing in **degrees** (0-360) from point 1 to point 2."""
        rlat1, rlng1 = math.radians(lat1), math.radians(lng1)
        rlat2, rlng2 = math.radians(lat2), math.radians(lng2)

        dlng = rlng2 - rlng1
        x = math.sin(dlng) * math.cos(rlat2)
        y = math.cos(rlat1) * math.sin(rlat2) - math.sin(rlat1) * math.cos(rlat2) * math.cos(dlng)

        brng = math.degrees(math.atan2(x, y))
        return brng % 360

    # ------------------------------------------------------------------
    # Interpolation
    # ------------------------------------------------------------------

    @staticmethod
    def rdp_simplify(coords: list[Coordinate], epsilon_m: float = 2.0) -> list[Coordinate]:
        """Ramer-Douglas-Peucker 演算法：去除距離折線小於 epsilon_m 公尺的多餘點。

        用於在 PCHIP 插值前先精簡 OSRM 回傳的過密路線點，
        保留形狀轉折點，去除共線的中間點。

        Parameters
        ----------
        epsilon_m : float
            點到折線的最大允許偏差（公尺），預設 2.0m。
            值越大保留點越少，路線越粗糙；值越小保留越多細節。
        """
        if len(coords) <= 2:
            return coords

        def point_to_line_dist(p, a, b):
            """點 p 到線段 ab 的垂直距離（公尺）。"""
            # 用 haversine 計算絕對距離（避免經緯度比例問題）
            ab = RouteInterpolator.haversine(a.lat, a.lng, b.lat, b.lng)
            if ab == 0:
                return RouteInterpolator.haversine(p.lat, p.lng, a.lat, a.lng)
            # 投影比率 t
            dx_ab = b.lng - a.lng
            dy_ab = b.lat - a.lat
            dx_ap = p.lng - a.lng
            dy_ap = p.lat - a.lat
            t = max(0.0, min(1.0, (dx_ap * dx_ab + dy_ap * dy_ab) / (dx_ab**2 + dy_ab**2 + 1e-18)))
            proj_lat = a.lat + t * dy_ab
            proj_lng = a.lng + t * dx_ab
            return RouteInterpolator.haversine(p.lat, p.lng, proj_lat, proj_lng)

        def rdp(pts, eps):
            if len(pts) <= 2:
                return pts
            # 找最遠點
            max_dist, max_idx = 0.0, 0
            for i in range(1, len(pts) - 1):
                d = point_to_line_dist(pts[i], pts[0], pts[-1])
                if d > max_dist:
                    max_dist, max_idx = d, i
            if max_dist > eps:
                left = rdp(pts[:max_idx + 1], eps)
                right = rdp(pts[max_idx:], eps)
                return left[:-1] + right
            return [pts[0], pts[-1]]

        return rdp(coords, epsilon_m)

    @staticmethod
    def smooth_coords(coords: list[Coordinate]) -> list[Coordinate]:
        """使用三次樣條曲線平滑路線座標，讓彎道更自然。

        當路線點數 ≥ 4 且 scipy 可用時啟用；否則原樣返回。
        如果樣條計算失敗（如重複點），安全回退至原始座標。
        """
        if not _SCIPY_AVAILABLE or len(coords) < 4:
            return coords

        try:
            lats = [c.lat for c in coords]
            lngs = [c.lng for c in coords]

            # 計算累積弦長作為樣條參數
            dists = [0.0]
            for i in range(1, len(coords)):
                dists.append(dists[-1] + RouteInterpolator.haversine(
                    coords[i - 1].lat, coords[i - 1].lng,
                    coords[i].lat, coords[i].lng,
                ))

            # 去除重複距離的點（CubicSpline 需要嚴格遞增的 x）
            unique_lats, unique_lngs, unique_dists = [lats[0]], [lngs[0]], [dists[0]]
            for i in range(1, len(dists)):
                if dists[i] > unique_dists[-1] + 1e-9:
                    unique_lats.append(lats[i])
                    unique_lngs.append(lngs[i])
                    unique_dists.append(dists[i])

            if len(unique_dists) < 4:
                return coords

            t = np.array(unique_dists)
            # PchipInterpolator：保單調性、不 overshoot，更適合 GPS 路線
            cs_lat = PchipInterpolator(t, np.array(unique_lats))
            cs_lng = PchipInterpolator(t, np.array(unique_lngs))

            # 在原始點之間插入中間點（最多 500 個，避免過多）
            n_out = min((len(unique_dists) - 1) * 5 + 1, 500)
            t_fine = np.linspace(0, t[-1], n_out)

            smoothed = []
            for ti in t_fine:
                lat = float(cs_lat(ti))
                lng = float(cs_lng(ti))
                # 確保座標在合法範圍內（樣條可能輕微 overshoot）
                lat = max(-90.0, min(90.0, lat))
                lng = max(-180.0, min(180.0, lng))
                smoothed.append(Coordinate(lat=lat, lng=lng))
            return smoothed

        except Exception:
            # 任何錯誤都安全回退至原始座標
            return coords

    @staticmethod
    def interpolate(
        coords: list[Coordinate],
        speed_mps: float,
        interval_sec: float = 1.0,
    ) -> list[dict]:
        """Interpolate a sparse polyline into dense, evenly-timed points.

        Parameters
        ----------
        coords:
            Ordered waypoints of the route.
        speed_mps:
            Desired travel speed in metres per second.
        interval_sec:
            Time gap between generated points (default 1 s).

        Returns
        -------
        list[dict]
            Each dict contains *lat*, *lng*, *timestamp_offset* (seconds from
            start), and *bearing* (degrees).
        """
        if not coords:
            return []

        step_dist = speed_mps * interval_sec  # meters per tick
        results: list[dict] = []
        time_offset = 0.0

        # Seed the first point
        results.append(
            {
                "lat": coords[0].lat,
                "lng": coords[0].lng,
                "timestamp_offset": 0.0,
                "bearing": (
                    RouteInterpolator.bearing(
                        coords[0].lat, coords[0].lng,
                        coords[1].lat, coords[1].lng,
                    )
                    if len(coords) > 1
                    else 0.0
                ),
            }
        )

        carry = 0.0  # leftover distance from previous segment
        seg_idx = 0

        while seg_idx < len(coords) - 1:
            a = coords[seg_idx]
            b = coords[seg_idx + 1]
            seg_dist = RouteInterpolator.haversine(a.lat, a.lng, b.lat, b.lng)
            seg_bearing = RouteInterpolator.bearing(a.lat, a.lng, b.lat, b.lng)

            if seg_dist == 0:
                seg_idx += 1
                continue

            # 若 carry 超過本段長度，代表本段已被 carry 完全消耗，直接跳過
            # 這防止 carry 變成負數，避免產生「回跳」座標
            if carry >= seg_dist:
                carry -= seg_dist
                seg_idx += 1
                continue

            # How far along this segment we already are (from carry)
            pos = carry  # meters from *a* along the segment

            while pos + step_dist <= seg_dist:
                pos += step_dist
                time_offset += interval_sec
                frac = pos / seg_dist
                lat = a.lat + frac * (b.lat - a.lat)
                lng = a.lng + frac * (b.lng - a.lng)
                results.append(
                    {
                        "lat": lat,
                        "lng": lng,
                        "timestamp_offset": time_offset,
                        "bearing": seg_bearing,
                    }
                )

            # Leftover distance rolls into the next segment
            carry = seg_dist - pos
            seg_idx += 1

        # Always include the final waypoint
        last = coords[-1]
        if results:
            prev = results[-1]
            if prev["lat"] != last.lat or prev["lng"] != last.lng:
                remaining = RouteInterpolator.haversine(
                    prev["lat"], prev["lng"], last.lat, last.lng
                )
                if speed_mps > 0:
                    time_offset += remaining / speed_mps
                results.append(
                    {
                        "lat": last.lat,
                        "lng": last.lng,
                        "timestamp_offset": time_offset,
                        "bearing": results[-1]["bearing"],
                    }
                )

        return results

    @staticmethod
    def get_position_at_time(timed_points: list[dict], elapsed_sec: float) -> tuple[float, float, float]:
        """依照已過時間查詢路線上的精確位置（二分搜尋 + 線性插值）。

        不論 tick 是否準時，都能取得對應時刻的正確座標，
        解決「burst 連射」和「carry 回跳」問題。

        Returns
        -------
        (lat, lng, bearing)
        """
        if not timed_points:
            raise ValueError("timed_points is empty")

        # 超出終點
        if elapsed_sec >= timed_points[-1]["timestamp_offset"]:
            p = timed_points[-1]
            return p["lat"], p["lng"], p.get("bearing", 0.0)

        # 尚未開始
        if elapsed_sec <= 0:
            p = timed_points[0]
            return p["lat"], p["lng"], p.get("bearing", 0.0)

        # 二分搜尋：找到 [lo, hi] 使 offset[lo] <= elapsed < offset[hi]
        lo, hi = 0, len(timed_points) - 1
        while lo + 1 < hi:
            mid = (lo + hi) // 2
            if timed_points[mid]["timestamp_offset"] <= elapsed_sec:
                lo = mid
            else:
                hi = mid

        p1, p2 = timed_points[lo], timed_points[hi]
        t1, t2 = p1["timestamp_offset"], p2["timestamp_offset"]

        if t2 <= t1:
            return p2["lat"], p2["lng"], p2.get("bearing", 0.0)

        # 線性插值
        frac = (elapsed_sec - t1) / (t2 - t1)
        lat = p1["lat"] + frac * (p2["lat"] - p1["lat"])
        lng = p1["lng"] + frac * (p2["lng"] - p1["lng"])
        bearing = p2.get("bearing", 0.0)
        return lat, lng, bearing

    # ------------------------------------------------------------------
    # Jitter & movement helpers
    # ------------------------------------------------------------------

    @staticmethod
    def add_jitter(lat: float, lng: float, jitter_meters: float) -> tuple[float, float]:
        """Add random GPS drift within *jitter_meters* of the given point."""
        if jitter_meters <= 0:
            return lat, lng

        angle = random.uniform(0, 2 * math.pi)
        dist = random.uniform(0, jitter_meters)

        dlat = (dist * math.cos(angle)) / _R
        dlng = (dist * math.sin(angle)) / (_R * math.cos(math.radians(lat)))

        return lat + math.degrees(dlat), lng + math.degrees(dlng)

    @staticmethod
    def move_point(
        lat: float,
        lng: float,
        bearing_deg: float,
        distance_m: float,
    ) -> tuple[float, float]:
        """Move a point by *distance_m* along *bearing_deg*.

        Used for joystick-style movement.
        """
        brng = math.radians(bearing_deg)
        rlat = math.radians(lat)
        rlng = math.radians(lng)
        d_over_r = distance_m / _R

        new_lat = math.asin(
            math.sin(rlat) * math.cos(d_over_r)
            + math.cos(rlat) * math.sin(d_over_r) * math.cos(brng)
        )
        new_lng = rlng + math.atan2(
            math.sin(brng) * math.sin(d_over_r) * math.cos(rlat),
            math.cos(d_over_r) - math.sin(rlat) * math.sin(new_lat),
        )

        return math.degrees(new_lat), math.degrees(new_lng)

    @staticmethod
    def random_point_in_radius(
        center_lat: float,
        center_lng: float,
        radius_m: float,
    ) -> tuple[float, float]:
        """Generate a uniformly random point within *radius_m* of the centre.

        Uses the square-root trick so points are evenly distributed across the
        circle's area rather than clustering near the centre.
        """
        angle = random.uniform(0, 2 * math.pi)
        dist = radius_m * math.sqrt(random.random())

        return RouteInterpolator.move_point(center_lat, center_lng, math.degrees(angle), dist)
