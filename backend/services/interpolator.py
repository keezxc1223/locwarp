"""Coordinate interpolation and GPS jitter utilities."""

from __future__ import annotations

import math
import random

from models.schemas import Coordinate

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
                "seg_idx": 0,
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
                        "seg_idx": seg_idx,
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
                        "seg_idx": max(len(coords) - 2, 0),
                    }
                )

        return results

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
        rng: random.Random | None = None,
    ) -> tuple[float, float]:
        """Generate a uniformly random point within *radius_m* of the centre.

        Uses the square-root trick so points are evenly distributed across the
        circle's area rather than clustering near the centre. When *rng* is
        supplied (a seeded ``random.Random`` instance), two callers that share
        the seed generate the exact same sequence; this enables dual-device
        group mode to keep both phones on the same random walk path.
        """
        r = rng if rng is not None else random
        angle = r.uniform(0, 2 * math.pi)
        dist = radius_m * math.sqrt(r.random())

        return RouteInterpolator.move_point(center_lat, center_lng, math.degrees(angle), dist)
