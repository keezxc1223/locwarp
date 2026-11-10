// 蘑菇地圖圖層 fetch decisions: whether a settled view hides the markers,
// reuses the last fetch, or asks the backend again. The hook only acts on
// what `plan` says; the last fetch lives here, not in the hook.
//
// No runtime imports and erasable-syntax-only so `node --test` can load it
// directly. Boxes are plain numbers, not Leaflet bounds.

/** A lat/lng box; longitudes are Leaflet's unwrapped ones, so they may pass ±180. */
export interface PipiBox {
  north: number;
  south: number;
  east: number;
  west: number;
}

export type PipiFetchDecision = 'hide' | 'reuse' | 'fetch';

// The site decides how much to return from the `zoom` in the request, not
// from the size of the box: asked with zoom 14 it only returns mushrooms and
// smoke ending within 5 minutes (no flowers), asked with 15 it answers in
// full, even for a zoom-14-sized box (measured 2026-11-05,
// docs/pipi-mushroom.md). So the zoom sent is never below PIPI_QUERY_ZOOM,
// whatever the map is at. The backend's MIN_ITEMS_ZOOM is the same number.
export const PIPI_QUERY_ZOOM = 15;

// Nothing is requested when the map is zoomed out further than this: the
// same threshold the site itself answers in full from. Below it the layer
// hides its markers and tells the user to zoom in.
export const PIPI_MIN_ZOOM = 15;

// How long a fetch may be reused; also the hook's forced-refresh period.
export const PIPI_FRESH_MS = 60_000;

interface PipiFetchRecord {
  bounds: PipiBox;
  at: number;
  zoom: number;
  truncated: boolean;
}

// Edges count as inside, as in Leaflet's LatLngBounds.contains.
function contains(outer: PipiBox, inner: PipiBox): boolean {
  return inner.north <= outer.north && inner.south >= outer.south
    && inner.east <= outer.east && inner.west >= outer.west;
}

/** Creates a planner that keeps the last successful fetch to itself. */
export function createPipiFetchPlanner() {
  let last: PipiFetchRecord | null = null;
  return {
    /**
     * Decides what a settled view needs.
     *
     * @param req.zoom the integer zoom the hook would send to the backend.
     * @param req.view the visible map box (not padded, not wrapped).
     * @param req.now caller's clock in ms; the planner never reads the clock.
     * @param req.force true for the forced refresh, which skips `reuse`.
     * @returns `hide` below {@link PIPI_MIN_ZOOM}, keeping the last fetch;
     *   `reuse` when the last fetch still covers the view, is under
     *   {@link PIPI_FRESH_MS} old and was not truncated at another zoom;
     *   otherwise `fetch`.
     */
    plan(req: { zoom: number; view: PipiBox; now: number; force: boolean }): PipiFetchDecision {
      // The record is left as it is: zooming back in may still reuse it.
      if (req.zoom < PIPI_MIN_ZOOM) return 'hide';
      if (
        !req.force && last && contains(last.bounds, req.view) && req.now - last.at < PIPI_FRESH_MS
        // The site cut a truncated answer short for that zoom; another zoom
        // may get a complete one, so it is reused only at its own zoom.
        && (!last.truncated || last.zoom === req.zoom)
      ) return 'reuse';
      return 'fetch';
    },

    /**
     * Remembers a successful fetch for later `plan` calls to reuse. Call it
     * only after a fetch succeeds.
     *
     * @param fetch.bounds the padded box before longitude wrapping and the
     *   ±85 / ±180 clamp, i.e. not the one sent to the backend.
     * @param fetch.at caller's clock in ms when the answer arrived.
     * @param fetch.zoom the zoom that was sent.
     * @param fetch.truncated the answer's `truncated` flag.
     */
    record(fetch: PipiFetchRecord): void {
      last = { ...fetch };
    },
  };
}
