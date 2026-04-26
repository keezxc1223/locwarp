import { S2 } from 's2-geometry';
import type L from 'leaflet';

export interface S2CellPolygon {
  key: string;
  corners: [number, number][];
  center: [number, number];
}

const SAFETY_CAPS: Record<number, number> = {
  10: 200,
  11: 250,
  12: 300,
  13: 400,
  14: 600,
  15: 1200,
  16: 2500,
  17: 4000,
  18: 6000,
  19: 8000,
  20: 10000,
};

function cellCap(level: number): number {
  if (level <= 9) return 150;
  if (level >= 21) return 12000;
  return SAFETY_CAPS[level] ?? 4000;
}

function intersectsBounds(
  corners: [number, number][],
  bounds: L.LatLngBounds,
): boolean {
  let minLat = corners[0][0], maxLat = corners[0][0];
  let minLng = corners[0][1], maxLng = corners[0][1];
  for (let i = 1; i < corners.length; i++) {
    const [la, ln] = corners[i];
    if (la < minLat) minLat = la; else if (la > maxLat) maxLat = la;
    if (ln < minLng) minLng = ln; else if (ln > maxLng) maxLng = ln;
  }
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  if (maxLat < sw.lat || minLat > ne.lat) return false;
  if (maxLng < sw.lng || minLng > ne.lng) return false;
  return true;
}

// BFS-flood S2 cells starting at the viewport center, keeping cells whose AABB
// intersects the viewport. Mirrors pik_tool's useS2Grid composable, which is in
// turn the same algorithm vesoyu/s2cell uses.
export function cellsInBounds(
  bounds: L.LatLngBounds,
  level: number,
): S2CellPolygon[] {
  const center = bounds.getCenter();
  const cap = cellCap(level);

  const seedKey = S2.latLngToKey(center.lat, center.lng, level);
  const seen = new Set<string>([seedKey]);
  const queue: string[] = [seedKey];
  const out: S2CellPolygon[] = [];

  while (queue.length && out.length < cap) {
    const key = queue.shift()!;
    let cell;
    try {
      cell = S2.S2Cell.FromHilbertQuadKey(key);
    } catch {
      continue;
    }
    const cornersRaw = cell.getCornerLatLngs();
    if (!cornersRaw || cornersRaw.length < 4) continue;
    // s2-geometry returns corners as [SW, SE, NE, NW]. Reorder to a closed
    // CCW ring suitable for L.polygon: [SW, NW, NE, SE].
    const corners: [number, number][] = [
      [cornersRaw[0].lat, cornersRaw[0].lng],
      [cornersRaw[3].lat, cornersRaw[3].lng],
      [cornersRaw[2].lat, cornersRaw[2].lng],
      [cornersRaw[1].lat, cornersRaw[1].lng],
    ];
    if (!intersectsBounds(corners, bounds)) continue;
    const c = cell.getLatLng();
    out.push({ key, corners, center: [c.lat, c.lng] });

    let neighbors;
    try {
      neighbors = cell.getNeighbors();
    } catch {
      continue;
    }
    for (const n of neighbors) {
      const nk = n.toHilbertQuadkey();
      if (seen.has(nk)) continue;
      seen.add(nk);
      queue.push(nk);
    }
  }

  return out;
}

// Approximate edge length of an S2 cell at the given level + latitude.
// Used to display "格子大小 ~80m" in the level picker. Exact value differs
// per cell/face; this is the canonical center-of-face value.
export function approxCellSizeMeters(level: number, lat: number): number {
  // Earth equatorial circumference / 4 (face) divided by cells-per-side.
  const cellsPerSide = Math.pow(2, level);
  const equatorMeters = 40075016 / 4;
  const latFactor = Math.cos((lat * Math.PI) / 180);
  return (equatorMeters / cellsPerSide) * latFactor;
}
