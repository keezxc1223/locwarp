// 蘑菇地圖圖層 marker selection (see GLOSSARY.md: 點位上限, 上限截斷, 畫面內缺點):
// which of the 該顯示的點位 get drawn when there are more than the cap. The
// hook supplies the filter and the projection; this module never touches
// Leaflet and does not decide whether the markers are hidden.
//
// No runtime imports and erasable-syntax-only so `node --test` can load it
// directly. Points are plain projected pixels, not Leaflet types.

// LocWarp's own rendering cap (one DivIcon DOM element per marker), not a
// throttle on the site. Shared by the layer and the panel's hint.
// 750: on the user's machine (2026-11-05) every full layer rebuild at this
// cap finished within 100 ms, main-thread style / layout / paint included.
// A 標記大小 change took about 0.04 ms per marker from the click to the new
// markers in the DOM; the slowest rebuild was a 60 s refresh at 92 ms (an
// upper bound: no frame went over 50 ms). 1500 took up to 112 ms.
// Measurements: .scratch/pipi-max-markers/issues/02-marker-cap-size-and-rendering.md
export const PIPI_MAX_MARKERS = 750;

export interface PipiPixel {
  x: number;
  y: number;
}

export interface PipiMarkerSelection<T> {
  /** What to draw: at most `cap`, or `cap + 1` with the kept popup. */
  items: T[];
  /** 上限截斷: more than `cap` items pass `shouldShow`. Exactly `cap` is not. */
  capped: boolean;
  /** 畫面內缺點: an item that passes `shouldShow` and sits inside the view is not in `items`. */
  viewCapped: boolean;
}

/**
 * Picks the points to draw. Items failing `shouldShow` are dropped before
 * anything is counted, so they never use up the cap. Past the cap, the ones
 * with the smallest 畫面框距離 `max(|dx| / (W/2), |dy| / (H/2))` are kept
 * (≤ 1 is inside the view, edges included); ties keep input order. That
 * picks a rectangle shaped like the view, so a point inside always beats one
 * outside.
 *
 * @param req.items every item of the fetch, in the site's order.
 * @param req.shouldShow whether an item is 該顯示 (kind on, not ended,
 *   passes the 花的子篩選).
 * @param req.point an item's projected pixel position.
 * @param req.center the view centre, in the same pixels as `point`.
 * @param req.width the map container's width in pixels.
 * @param req.height the map container's height in pixels.
 * @param req.cap the 點位上限.
 * @param req.keepId the item whose popup is open, or null. When it passes
 *   `shouldShow` but misses the cut it is drawn as one extra, pushing nothing
 *   out. It never changes `capped`; `viewCapped` looks at what is drawn, so
 *   the extra clears it when it was the only point inside the view left out.
 */
export function selectPipiMarkers<T extends { id: string }>(req: {
  items: readonly T[];
  shouldShow: (item: T) => boolean;
  point: (item: T) => PipiPixel;
  center: PipiPixel;
  width: number;
  height: number;
  cap: number;
  keepId: string | null;
}): PipiMarkerSelection<T> {
  const { point, center, width, height, cap } = req;
  const shown = req.items.filter(req.shouldShow);
  if (shown.length <= cap) return { items: shown, capped: false, viewCapped: false };
  const halfW = width / 2;
  const halfH = height / 2;
  const ranked = shown.map((item) => {
    const p = point(item);
    return { item, frameDist: Math.max(Math.abs(p.x - center.x) / halfW, Math.abs(p.y - center.y) / halfH) };
  });
  // Array.prototype.sort is stable, which is what keeps ties in input order.
  ranked.sort((a, b) => a.frameDist - b.frameDist);
  const chosen = ranked.slice(0, cap);
  let keep: (typeof ranked)[number] | undefined;
  if (req.keepId !== null && !chosen.some((r) => r.item.id === req.keepId)) {
    keep = ranked.find((r) => r.item.id === req.keepId);
    if (keep) chosen.push(keep);
  }
  // Sorted, so the nearest point not drawn decides it: ranked[cap], or the
  // one after it when ranked[cap] is the kept popup drawn as the extra.
  const missed = ranked[cap] === keep ? ranked[cap + 1] : ranked[cap];
  const viewCapped = missed !== undefined && missed.frameDist <= 1;
  return { items: chosen.map((r) => r.item), capped: true, viewCapped };
}
