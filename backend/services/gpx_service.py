"""GPX import / export service using *gpxpy*."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

import gpxpy
import gpxpy.gpx

from models.schemas import Coordinate

logger = logging.getLogger(__name__)


class GpxService:
    """Parse and generate GPX files."""

    # ------------------------------------------------------------------
    # Import
    # ------------------------------------------------------------------

    @staticmethod
    def parse_gpx(gpx_content: str) -> list[Coordinate]:
        """Parse raw GPX XML into a flat list of :class:`Coordinate`.

        The method looks at tracks first, then routes, then waypoints --
        whichever source has points wins.
        """
        gpx = gpxpy.parse(gpx_content)
        coords: list[Coordinate] = []

        # 1. Track points
        for track in gpx.tracks:
            for segment in track.segments:
                for pt in segment.points:
                    coords.append(Coordinate(lat=pt.latitude, lng=pt.longitude))

        if coords:
            logger.info("Parsed %d track points from GPX", len(coords))
            return coords

        # 2. Route points
        for route in gpx.routes:
            for pt in route.points:
                coords.append(Coordinate(lat=pt.latitude, lng=pt.longitude))

        if coords:
            logger.info("Parsed %d route points from GPX", len(coords))
            return coords

        # 3. Waypoints
        for pt in gpx.waypoints:
            coords.append(Coordinate(lat=pt.latitude, lng=pt.longitude))

        logger.info("Parsed %d waypoints from GPX", len(coords))
        return coords

    # ------------------------------------------------------------------
    # Export
    # ------------------------------------------------------------------

    @staticmethod
    def generate_gpx(
        coords: list[dict],
        name: str = "LocWarp Route",
    ) -> str:
        """Generate a GPX XML string from a list of point dicts.

        Each dict should contain at least ``lat`` and ``lng``.  An optional
        ``timestamp`` field (ISO-8601 string or :class:`datetime`) is written
        as the point's time element.

        Parameters
        ----------
        coords:
            Ordered points, e.g. ``[{"lat": 25.0, "lng": 121.5, "timestamp": ...}, ...]``
        name:
            Human-readable name embedded in the GPX ``<trk><name>`` element.

        Returns
        -------
        str
            Well-formed GPX 1.1 XML document.
        """
        gpx = gpxpy.gpx.GPX()

        track = gpxpy.gpx.GPXTrack(name=name)
        gpx.tracks.append(track)

        segment = gpxpy.gpx.GPXTrackSegment()
        track.segments.append(segment)

        for pt in coords:
            lat = pt["lat"]
            lng = pt["lng"]
            time = pt.get("timestamp")

            if isinstance(time, str):
                try:
                    time = datetime.fromisoformat(time)
                except (ValueError, TypeError):
                    time = None

            if time is not None and time.tzinfo is None:
                time = time.replace(tzinfo=UTC)

            elevation = pt.get("elevation") or pt.get("ele")
            track_point = gpxpy.gpx.GPXTrackPoint(
                latitude=lat,
                longitude=lng,
                elevation=float(elevation) if elevation is not None else None,
                time=time,
            )
            segment.points.append(track_point)

        return gpx.to_xml()
