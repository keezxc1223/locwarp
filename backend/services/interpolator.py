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

        Walks the polyline by cumulative distance, emitting one point every
        ``step_dist = speed_mps * interval_sec`` metres. This handles three
        edge cases the old per-segment ``carry`` logic got wrong:

        1. ``step_dist > min_seg_dist``: previously a single step that
           crossed a segment boundary skipped the entire next segment, and
           ``carry`` rolled an inflated distance forward, producing emits
           that effectively traveled at ``min_seg_dist`` per tick instead
           of ``step_dist``. At ~180+ km/h with the 25 m straight-line
           densification, this collapsed to zero intermediate emits and
           the route looked frozen at start.
        2. Variable segment lengths from OSRM: same boundary-crossing bug
           skewed effective speed on routes with mixed-length segments.
        3. step_dist < min_seg_dist remains unchanged in behavior.

        Returns
        -------
        list[dict]
            Each dict contains *lat*, *lng*, *timestamp_offset* (seconds
            from start), *bearing* (degrees), and *seg_idx*.
        """
        if not coords:
            return []

        results: list[dict] = []

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

        step_dist = speed_mps * interval_sec  # meters per tick
        if step_dist <= 0 or speed_mps <= 0:
            return results

        # Walk the polyline by cumulative distance from the start. For each
        # segment we know its [start_cum, end_cum] range; any emit target
        # `next_emit_at` that falls inside that range gets interpolated at
        # the corresponding fractional offset within the segment.
        cum_at_seg_start = 0.0
        next_emit_at = step_dist
        last_seg_idx = 0
        last_bearing = results[0]["bearing"]

        for seg_idx in range(len(coords) - 1):
            a = coords[seg_idx]
            b = coords[seg_idx + 1]
            seg_dist = RouteInterpolator.haversine(a.lat, a.lng, b.lat, b.lng)
            if seg_dist <= 0:
                continue
            seg_bearing = RouteInterpolator.bearing(a.lat, a.lng, b.lat, b.lng)
            seg_end_cum = cum_at_seg_start + seg_dist

            while next_emit_at <= seg_end_cum:
                offset_in_seg = next_emit_at - cum_at_seg_start
                frac = offset_in_seg / seg_dist
                lat = a.lat + frac * (b.lat - a.lat)
                lng = a.lng + frac * (b.lng - a.lng)
                results.append(
                    {
                        "lat": lat,
                        "lng": lng,
                        "timestamp_offset": next_emit_at / speed_mps,
                        "bearing": seg_bearing,
                        "seg_idx": seg_idx,
                    }
                )
                next_emit_at += step_dist

            cum_at_seg_start = seg_end_cum
            last_seg_idx = seg_idx
            last_bearing = seg_bearing

        # Always include the final waypoint (its timestamp is the total
        # polyline length divided by speed, regardless of where the last
        # tick happened to land).
        total_distance = cum_at_seg_start
        last = coords[-1]
        prev = results[-1]
        if prev["lat"] != last.lat or prev["lng"] != last.lng:
            results.append(
                {
                    "lat": last.lat,
                    "lng": last.lng,
                    "timestamp_offset": total_distance / speed_mps,
                    "bearing": last_bearing,
                    "seg_idx": last_seg_idx,
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

    @staticmethod
    def random_point_forward(
        bound_center_lat: float,
        bound_center_lng: float,
        radius_m: float,
        cur_lat: float,
        cur_lng: float,
        heading_deg: float,
        turn_std_deg: float = 35.0,
        rng: random.Random | None = None,
    ) -> tuple[float, float, float]:
        """Pick the next destination with directional persistence.

        A correlated random walk: the next bearing is the current
        *heading_deg* plus a Gaussian turn (std-dev *turn_std_deg*, clamped
        to +-120 deg so the walk never reverses straight back). The step
        length is a random fraction of *radius_m*. If the candidate would
        leave the bounding circle (centre = bound_center, radius = radius_m)
        the bearing is steered back toward that centre so the walk stays
        inside the requested area.

        Returns (lat, lng, new_heading_deg) so the caller carries the heading
        into the next leg. This keeps consecutive legs flowing forward, which
        avoids re-walking the road just travelled.
        """
        r = rng if rng is not None else random
        turn = max(-120.0, min(120.0, r.gauss(0.0, turn_std_deg)))
        new_heading = (heading_deg + turn) % 360.0
        step = radius_m * (0.3 + 0.3 * r.random())  # 0.3R ~ 0.6R

        lat, lng = RouteInterpolator.move_point(cur_lat, cur_lng, new_heading, step)

        # Overshot the bounding circle → steer the heading toward the centre
        # (shortest-angle blend) and recompute, keeping the walk in-bounds.
        if RouteInterpolator.haversine(lat, lng, bound_center_lat, bound_center_lng) > radius_m:
            to_center = RouteInterpolator.bearing(cur_lat, cur_lng, bound_center_lat, bound_center_lng)
            diff = ((to_center - new_heading + 540.0) % 360.0) - 180.0
            new_heading = (new_heading + diff * 0.6) % 360.0
            lat, lng = RouteInterpolator.move_point(cur_lat, cur_lng, new_heading, step)

        return lat, lng, new_heading
