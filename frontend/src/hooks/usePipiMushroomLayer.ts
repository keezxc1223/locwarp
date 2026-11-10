import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import {
  PipiApiError,
  pipiClearCookie,
  pipiItems,
  pipiSetCookie,
  pipiStatus,
} from '../services/api';
import type { PipiCookieResult, PipiItem, PipiItemsResponse, PipiKind, PipiStatusResponse } from '../services/api';
import type { PipiFlowerFilter, PipiMarkerSize, PipiMushroomFilter } from '../defaults';
import { fmtRibbonCountdown, passesFlowerFilter, ribbonEndMs } from '../pipiFlowers';
import { formatCoord } from '../utils/coords';
import { PIPI_FRESH_MS, createPipiFetchPlanner, PIPI_QUERY_ZOOM } from '../pipiFetchPlanner';
import type { PipiBox } from '../pipiFetchPlanner';
import { PIPI_MAX_MARKERS, selectPipiMarkers } from '../pipiMarkerSelection';

// Pipi Mushroom 蘑菇地圖 overlay: fetches player-reported mushrooms / flowers
// for the viewport from the backend proxy and paints them as Leaflet markers.
//
// Request budget (the data comes from someone else's site):
//   * nothing below zoom 15 (at 14 the site only returns mushrooms and smoke
//     ending within 5 minutes; 15 is the first zoom it answers in full)
//   * one request per settled pan (debounced), skipped while the view is still
//     inside the last fetched, padded bbox and that data is < 60 s old
//   * below zoom 15 the markers are only hidden, the data and that bbox kept,
//     so zooming back in follows the same reuse rule as a pan
//   * one forced refresh per minute while the window is visible
//   * stop entirely on missing / expired cookie; back off on 429
// The hide / reuse / fetch call is pipiFetchPlanner.ts'; this hook acts on it.
// The backend adds its own 1 req/s spacing and a 30 s cache on top.

const MOVE_DEBOUNCE_MS = 700;
const PRUNE_MS = 30_000;
// Local-only poll of /api/pipi/status so a cookie pushed by the Chrome
// extension (extensions/pipi-cookie-sync) is picked up without a click.
const STATUS_POLL_MS = 15_000;
const BBOX_PAD = 0.25;
const STOP_CODES = new Set(['pipi_no_cookie', 'pipi_login_required', 'pipi_cookie_invalid']);
const ASSET_PREFIX = 'https://pipimushroom.com/';

// 標記大小 → px, the source of truth: these reach styles.css as inline
// --pipi-* custom properties (its fallbacks only cover a missing property),
// so the Leaflet icon box and the CSS circle can't drift apart. The image
// fills the circle inside the ring.
const MARKER_PX: Record<PipiMarkerSize, { box: number; ring: number; dot: number }> = {
  small: { box: 30, ring: 2, dot: 10 },
  medium: { box: 40, ring: 3, dot: 13 },
  large: { box: 50, ring: 4, dot: 17 },
};

export type PipiPhase = 'off' | 'no_cookie' | 'zoom' | 'region' | 'loading' | 'ok' | 'error';
export interface PipiLayerStatus {
  phase: PipiPhase;
  shown: number;
  truncated: boolean;
  // 畫面內缺點 (GLOSSARY.md). Set by every rebuild and reselect; off, no
  // cookie, below the min zoom and hidden reset it to false. Prune leaves it
  // as is, even if it empties the layer.
  viewCapped: boolean;
  updatedAt: number | null;
  error: string | null;
  zoom: number;
}
export type PipiKinds = Record<PipiKind, boolean>;

type TFn = (key: any, vars?: Record<string, string | number>) => string;

interface Options {
  mapRef: React.MutableRefObject<L.Map | null>;
  enabled: boolean;
  kinds: PipiKinds;
  flowerFilter: PipiFlowerFilter;
  mushroomFilter: PipiMushroomFilter;
  markerSize: PipiMarkerSize;
  onTeleport: (lat: number, lng: number) => void;
  onNavigate: (lat: number, lng: number) => void;
  t: TFn;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function toBox(b: L.LatLngBounds): PipiBox {
  return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
}

function kindOf(it: PipiItem): PipiKind {
  return it.itemKind === 'flower' || it.itemKind === 'smoke' ? it.itemKind : 'mushroom';
}

// When the marker should disappear (server clock).
function endMs(it: PipiItem, kind: PipiKind): number | undefined {
  if (kind === 'flower') return it.wiltingMs;
  if (kind === 'smoke') return it.smokeEndMs ?? it.finishMs;
  return it.finishMs;
}

function safeImage(it: PipiItem): string | null {
  return it.image && it.image.startsWith(ASSET_PREFIX) ? it.image : null;
}

function itemName(it: PipiItem): string {
  const name = it.displayName || it.key || '?';
  return it.sizeName && it.itemKind !== 'flower' ? `${name} · ${it.sizeName}` : name;
}

function popupHtml(it: PipiItem, kind: PipiKind, offset: number, t: TFn): string {
  const img = safeImage(it);
  const end = endMs(it, kind);
  const now = Date.now() + offset;
  // Re-checked at open time, not taken from the layer build: the 彩帶期 may
  // have ended since, and then the line is left out instead of going negative.
  const ribbonEnd = ribbonEndMs(it, now);
  const ribbonLine = ribbonEnd === null ? '' : t('map.pipi_ribbon_ends_in', { time: fmtRibbonCountdown(ribbonEnd - now) });
  let timeLine = '';
  if (end && end > now) {
    timeLine = t('map.pipi_remaining', { time: fmtDuration(end - now) });
    // Local clock time of server-side `end`.
    if (kind === 'flower') timeLine += ` · ${t('map.pipi_wilts_at', { time: fmtClock(end - offset) })}`;
  }
  return `<div class="map-popup pipi-popup-body">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      ${img ? `<img src="${escapeHtml(img)}" alt="" style="width:36px;height:36px;object-fit:contain;flex-shrink:0;" />` : ''}
      <div style="min-width:0;">
        <div class="map-popup-title" style="margin-bottom:2px;">${escapeHtml(itemName(it))}</div>
        ${it.title ? `<div style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px;">${escapeHtml(it.title)}</div>` : ''}
      </div>
    </div>
    ${ribbonLine ? `<div style="font-size:11px;color:var(--accent-pink);margin-bottom:2px;">${escapeHtml(ribbonLine)}</div>` : ''}
    ${timeLine ? `<div style="font-size:11px;color:var(--accent-yellow);margin-bottom:4px;">${escapeHtml(timeLine)}</div>` : ''}
    <div class="map-popup-coords">${escapeHtml(formatCoord(it.lat, it.lng, 6))}</div>
    <div class="map-popup-actions">
      <button type="button" class="btn btn-primary" style="padding:5px 10px;" data-pipi-act="teleport">${escapeHtml(t('map.teleport_here'))}</button>
      <button type="button" class="btn btn-secondary" style="padding:5px 10px;" data-pipi-act="navigate">${escapeHtml(t('map.navigate_here'))}</button>
    </div>
    <div class="pipi-popup-note">${escapeHtml(t('map.pipi_popup_note'))}</div>
  </div>`;
}

export function usePipiMushroomLayer({
  mapRef, enabled, kinds, flowerFilter, mushroomFilter, markerSize, onTeleport, onNavigate, t,
}: Options) {
  // null = unknown (backend not reachable yet); we still try to load.
  const [configured, setConfigured] = useState<boolean | null>(null);
  // offset: server clock - local clock. lngShift: multiple of 360 that moves
  // the (wrapped, -180..180) results onto the world copy currently on screen.
  const [data, setData] = useState<{ res: PipiItemsResponse; offset: number; lngShift: number } | null>(null);
  const [status, setStatus] = useState<PipiLayerStatus>({
    phase: 'off', shown: 0, truncated: false, viewCapped: false, updatedAt: null, error: null, zoom: 0,
  });
  const [reloadToken, setReloadToken] = useState(0);
  // Markers taken off the map below the threshold while `data` stays. Kept
  // outside the fetch effect: a rerun of it can't know an earlier run hid
  // them, so every non-hide decision shows them again. The ref is for `load`.
  const [markersHidden, setMarkersHiddenState] = useState(false);
  const markersHiddenRef = useRef(false);
  const setMarkersHidden = useCallback((v: boolean) => {
    markersHiddenRef.current = v;
    setMarkersHiddenState(v);
  }, []);

  const tRef = useRef(t);
  tRef.current = t;
  // Popup buttons by data-pipi-act. Every act needs its own entry: an
  // unmapped one does nothing (and logs) instead of falling back to a teleport.
  const popupActionsRef = useRef<Record<string, (lat: number, lng: number) => void>>({});
  popupActionsRef.current = { teleport: onTeleport, navigate: onNavigate };
  // Id of the item whose popup is open, so a data refresh can reopen it.
  const openIdRef = useRef<string | null>(null);
  const reopenIdRef = useRef<string | null>(null);
  // Re-picks the drawn markers for the current view, set by the marker
  // effect and null whenever no layer is up; the fetch loop calls it.
  const reselectRef = useRef<(() => void) | null>(null);

  const [cookieInfo, setCookieInfo] = useState<Pick<PipiStatusResponse, 'source' | 'updated_at'>>({
    source: null, updated_at: null,
  });
  // updated_at of the cookie the fetch loop is currently using; undefined
  // until the first status answer.
  const cookieStampRef = useRef<number | null | undefined>(undefined);

  const applyStatus = useCallback((r: PipiStatusResponse) => {
    setConfigured(r.configured);
    setCookieInfo({ source: r.source, updated_at: r.updated_at });
    const prev = cookieStampRef.current;
    cookieStampRef.current = r.updated_at;
    // A different cookie arrived (extension push / another window): restart
    // the fetch loop, which also clears a "login required" stop.
    if (prev !== undefined && r.configured && r.updated_at !== prev) setReloadToken((x) => x + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    const check = () => {
      if (document.hidden) return;
      pipiStatus().then((r) => { if (alive) applyStatus(r); }).catch(() => { /* backend down */ });
    };
    check();
    const id = enabled ? window.setInterval(check, STATUS_POLL_MS) : undefined;
    return () => { alive = false; window.clearInterval(id); };
  }, [enabled, applyStatus]);

  // ── Fetch loop ────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !enabled) {
      setData(null);
      setMarkersHidden(false);
      setStatus((s) => ({ ...s, phase: 'off', shown: 0, truncated: false, viewCapped: false, error: null }));
      return;
    }
    if (configured === false) {
      setData(null);
      setMarkersHidden(false);
      setStatus((s) => ({ ...s, phase: 'no_cookie', shown: 0, truncated: false, viewCapped: false, error: null }));
      return;
    }
    let disposed = false;
    let stopped = false;
    let blockedUntil = 0;
    // The 429's message: the zoom hint overwrites it, and a fetch held back by
    // the back-off shows it again.
    let blockedError = '';
    const planner = createPipiFetchPlanner();
    // How the kept data was fetched, restored by a reuse right after a hide.
    // A reuse only follows a fetch this run's planner recorded, so this always
    // describes the data that reuse draws.
    let fetchedStatus: Pick<PipiLayerStatus, 'phase' | 'truncated' | 'updatedAt'> | null = null;
    let ctrl: AbortController | null = null;
    let debounce: number | undefined;

    // Hiding and redrawing go by zoom alone; only sending a request also
    // waits for a stop (bad cookie) or a 429 back-off to clear. The status,
    // in order: stopped → its error stays; hide → zoom hint; reuse right after
    // a hide → the kept fetch's result; fetch sent → loading; fetch held back
    // by the back-off → the 429's error.
    const load = async (force: boolean) => {
      if (disposed || document.hidden) return;
      const zoom = Math.round(map.getZoom());
      const view = map.getBounds();
      const decision = planner.plan({ zoom, view: toBox(view), now: Date.now(), force });
      if (decision === 'hide') {
        // Never clear the data or rebuild the planner here: either one makes
        // every zoom back in refetch, and no automated test would catch it.
        ctrl?.abort();
        setMarkersHidden(true);
        if (!stopped) setStatus((s) => ({ ...s, phase: 'zoom', shown: 0, truncated: false, viewCapped: false, error: null, zoom }));
        return;
      }
      // Reselected here rather than on a moveend of its own: two debounces
      // fire in no fixed order, so that one could redraw after a zoom below
      // the threshold before this hides. Every other decision reselects, even
      // a stop, a back-off or a refetch (then the new data rebuilds again).
      reselectRef.current?.();
      const wasHidden = markersHiddenRef.current;
      setMarkersHidden(false);
      if (stopped) return;
      if (decision === 'reuse') {
        // With the markers already up the status is left alone, so the error
        // of a failed forced refresh or a 429 isn't replaced by the count.
        const kept = fetchedStatus;
        if (wasHidden && kept) setStatus((s) => ({ ...s, ...kept, error: null, zoom }));
        return;
      }
      if (Date.now() < blockedUntil) {
        setStatus((s) => ({ ...s, phase: 'error', error: blockedError, zoom }));
        return;
      }
      const padded = view.pad(BBOX_PAD);
      // Leaflet doesn't wrap longitude when the user pans across the
      // antimeridian; query the -180..180 equivalent and shift results back.
      const wrapped = map.wrapLatLngBounds(padded);
      const lngShift = padded.getCenter().lng - wrapped.getCenter().lng;
      ctrl?.abort();
      const c = new AbortController();
      ctrl = c;
      setStatus((s) => ({ ...s, phase: 'loading', zoom }));
      try {
        const res = await pipiItems({
          north: Math.min(85, wrapped.getNorth()), south: Math.max(-85, wrapped.getSouth()),
          east: Math.min(180, wrapped.getEast()), west: Math.max(-180, wrapped.getWest()),
          zoom: Math.max(zoom, PIPI_QUERY_ZOOM),
        }, c.signal);
        if (disposed || c.signal.aborted) return;
        planner.record({ bounds: toBox(padded), at: Date.now(), zoom, truncated: res.truncated });
        const result = { phase: res.region ? 'ok' : 'region', truncated: res.truncated, updatedAt: Date.now() } as const;
        fetchedStatus = result;
        setData({ res, offset: res.now_ms - Date.now(), lngShift });
        setStatus((s) => ({ ...s, ...result, error: null, zoom }));
      } catch (e) {
        if (disposed || c.signal.aborted || (e as Error)?.name === 'AbortError') return;
        const err = e instanceof PipiApiError ? e : null;
        const message = (e as Error).message || String(e);
        if (err?.code === 'pipi_rate_limited') {
          blockedUntil = Date.now() + (err.retryAfter ?? 60) * 1000;
          blockedError = message;
        }
        if (err && STOP_CODES.has(err.code)) {
          stopped = true;
          if (err.code === 'pipi_no_cookie') setConfigured(false);
        }
        setStatus((s) => ({ ...s, phase: 'error', error: message, zoom }));
      }
    };

    const onMove = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => { void load(false); }, MOVE_DEBOUNCE_MS);
    };
    const onVisibility = () => { if (!document.hidden) void load(false); };
    map.on('moveend', onMove);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(() => { void load(true); }, PIPI_FRESH_MS);
    void load(false);
    return () => {
      disposed = true;
      ctrl?.abort();
      window.clearTimeout(debounce);
      window.clearInterval(timer);
      map.off('moveend', onMove);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, configured, reloadToken, mapRef, setMarkersHidden]);

  // Sizes and types of mushroom seen so far, which is what the panel
  // offers to filter by. Taken from the data instead of a fixed list, so
  // they are always the site's own wording. They only grow: an option
  // should not vanish just because the map moved somewhere without it.
  const [facets, setFacets] = useState<{ sizes: string[]; names: string[] }>({ sizes: [], names: [] });
  useEffect(() => {
    if (!data) return;
    setFacets((prev) => {
      const sizes = new Set(prev.sizes);
      const names = new Set(prev.names);
      for (const it of data.res.items) {
        if (kindOf(it) !== 'mushroom') continue;
        if (it.sizeName) sizes.add(it.sizeName);
        const name = it.displayName || it.key;
        if (name) names.add(name);
      }
      if (sizes.size === prev.sizes.length && names.size === prev.names.length) return prev;
      const sort = (x: Set<string>) => [...x].sort((p, q) => p.localeCompare(q, 'zh-Hant'));
      return { sizes: sort(sizes), names: sort(names) };
    });
  }, [data]);
  const mushroomFilterKey = JSON.stringify(mushroomFilter);

  // ── Markers ───────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    const reopenId = reopenIdRef.current;
    reopenIdRef.current = null;
    // `markersHidden` has to come after the reopen id is cleared: a popup
    // closed by hiding must not reopen when the markers come back.
    if (!map || !enabled || !data || markersHidden) {
      setStatus((s) => (s.shown || s.viewCapped ? { ...s, shown: 0, viewCapped: false } : s));
      return;
    }
    const { res, offset, lngShift } = data;
    const px = MARKER_PX[markerSize];
    const pxStyle = `--pipi-box:${px.box}px;--pipi-ring:${px.ring}px;--pipi-dot:${px.dot}px`;
    const half = px.box / 2;
    const layer = L.layerGroup();
    const icons = new Map<string, L.DivIcon>();
    // The markers on the layer, by item id: prune and reselect both remove
    // from it, so neither touches a marker the other already took off.
    const drawn = new Map<string, { marker: L.Marker; end?: number }>();
    // Whether the last selection hit the 點位上限; reselect does nothing otherwise.
    let capped = false;

    // Picks against the view and the server time of this moment, not of the
    // rebuild: an older `now` would bring back markers prune already dropped.
    const select = (keepId: string | null) => {
      const now = Date.now() + offset;
      const zoom = map.getZoom();
      const size = map.getSize();
      const picked = selectPipiMarkers({
        items: res.items,
        shouldShow: (it) => {
          const kind = kindOf(it);
          if (!kinds[kind]) return false;
          const end = endMs(it, kind);
          if (end && end <= now) return false;
          if (kind === 'mushroom') {
            if (it.sizeName && mushroomFilter.hiddenSizes.includes(it.sizeName)) return false;
            const name = it.displayName || it.key || '';
            if (name && mushroomFilter.hiddenNames.includes(name)) return false;
            // A mushroom with no known end time is kept: hiding it would
            // be a guess.
            if (mushroomFilter.minMinutes > 0 && end && end - now < mushroomFilter.minMinutes * 60000) return false;
          }
          // No `kind === 'flower'` guard here: letting mushrooms / smoke
          // through is the module's job, so its tests are what lock it in.
          return passesFlowerFilter(it, flowerFilter, now);
        },
        // Same lngShift as the marker itself, so the distance matches what is drawn.
        point: (it) => map.project([it.lat, it.lng + lngShift], zoom),
        center: map.project(map.getCenter(), zoom),
        width: size.x,
        height: size.y,
        cap: PIPI_MAX_MARKERS,
        keepId,
      });
      capped = picked.capped;
      return { picked, now };
    };

    const addMarker = (it: PipiItem, now: number) => {
      // Already drawn: kept by a reselect, or an id the site repeated. A
      // second set() would orphan the first marker out of prune's and
      // reselect's reach.
      if (drawn.has(it.id)) return;
      const kind = kindOf(it);
      // Decided when the marker is built (rebuild or reselect); prune never re-checks it.
      const ribbon = ribbonEndMs(it, now) !== null;
      const img = safeImage(it);
      const iconKey = `${kind}|${ribbon ? 'ribbon' : ''}|${img ?? ''}`;
      let icon = icons.get(iconKey);
      if (!icon) {
        icon = L.divIcon({
          className: 'pipi-pin',
          html: `<div class="pipi-pin-inner pipi-${kind}${ribbon ? ' pipi-ribbon' : ''}" style="${pxStyle}">${img
            ? `<img src="${escapeHtml(img)}" alt="" draggable="false" />`
            : '<span class="pipi-pin-dot"></span>'}</div>`,
          iconSize: [px.box, px.box],
          iconAnchor: [half, half],
          popupAnchor: [0, 1 - half],
          tooltipAnchor: [0, 1 - half],
        });
        icons.set(iconKey, icon);
      }
      // zIndexOffset 0 keeps these under the user's position marker (1000)
      // and bookmark pins (2000).
      // Drawn on the visible world copy; teleport / navigate keep it.lng.
      const marker = L.marker([it.lat, it.lng + lngShift], { icon, keyboard: false, riseOnHover: true });
      marker.bindTooltip(escapeHtml(itemName(it)), { direction: 'top' });
      marker.bindPopup(() => popupHtml(it, kind, offset, tRef.current), { maxWidth: 280, minWidth: 200 });
      marker.on('popupopen', (e: L.PopupEvent) => {
        openIdRef.current = it.id;
        e.popup.getElement()?.querySelectorAll<HTMLButtonElement>('[data-pipi-act]').forEach((btn) => {
          btn.onclick = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const act = btn.dataset.pipiAct ?? '';
            const actions = popupActionsRef.current;
            if (!Object.prototype.hasOwnProperty.call(actions, act)) {
              console.error(`[pipi] popup button with no handler: data-pipi-act="${act}"`);
              return;
            }
            map.closePopup();
            actions[act](it.lat, it.lng);
          };
        });
      });
      marker.on('popupclose', () => { if (openIdRef.current === it.id) openIdRef.current = null; });
      layer.addLayer(marker);
      drawn.set(it.id, { marker, end: endMs(it, kind) });
    };

    // Rebuild: the popup id comes from reopenIdRef, because the previous
    // cleanup's layer.remove() fired popupclose and nulled openIdRef.
    const rebuild = select(reopenId);
    for (const it of rebuild.picked.items) addMarker(it, rebuild.now);
    layer.addTo(map);
    const shown = drawn.size;
    setStatus((s) => ({ ...s, shown, viewCapped: rebuild.picked.viewCapped }));
    if (reopenId) drawn.get(reopenId)?.marker.openPopup();

    // Same data, view moved: change only the markers that left or joined the
    // pick. The open popup's marker always stays, so its popup isn't closed
    // and reopened (Leaflet's autoPan would pull the map back).
    reselectRef.current = () => {
      if (!capped) return;
      const { picked, now } = select(openIdRef.current);
      const keep = new Set(picked.items.map((it) => it.id));
      for (const [id, e] of drawn) {
        if (keep.has(id)) continue;
        layer.removeLayer(e.marker);
        drawn.delete(id);
      }
      for (const it of picked.items) addMarker(it, now);
      const shown = drawn.size;
      setStatus((s) => ({ ...s, shown, viewCapped: picked.viewCapped }));
    };

    // Drop markers as their timers run out, without rebuilding the layer
    // (a rebuild would close whatever popup the user has open). Nothing is
    // re-picked here, so the count may sit under the cap until the next
    // reselect or rebuild.
    const prune = window.setInterval(() => {
      const n = Date.now() + offset;
      let removed = false;
      for (const [id, e] of drawn) {
        if (!e.end || e.end > n) continue;
        layer.removeLayer(e.marker);
        drawn.delete(id);
        removed = true;
      }
      const shown = drawn.size;
      if (removed) setStatus((s) => ({ ...s, shown }));
    }, PRUNE_MS);

    return () => {
      window.clearInterval(prune);
      reselectRef.current = null;
      reopenIdRef.current = openIdRef.current;
      layer.remove();
    };
  }, [
    data, markersHidden, enabled, kinds.mushroom, kinds.flower, kinds.smoke,
    flowerFilter.ribbonOnly, flowerFilter.showCommon, mushroomFilterKey, markerSize, mapRef,
  ]);

  const refresh = useCallback(() => setReloadToken((x) => x + 1), []);

  const saveCookie = useCallback(async (cookie: string): Promise<PipiCookieResult> => {
    const r = await pipiSetCookie(cookie);
    // Adopt the new stamp without triggering applyStatus' own reload.
    cookieStampRef.current = undefined;
    await pipiStatus().then(applyStatus).catch(() => setConfigured(true));
    setReloadToken((x) => x + 1);
    return r;
  }, [applyStatus]);

  const clearCookie = useCallback(async () => {
    await pipiClearCookie();
    cookieStampRef.current = null;
    setConfigured(false);
    setCookieInfo({ source: null, updated_at: null });
  }, []);

  return { status, configured, cookieInfo, facets, refresh, saveCookie, clearCookie };
}
