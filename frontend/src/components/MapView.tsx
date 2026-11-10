import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { useT } from '../i18n';
import { reverseGeocode } from '../services/api';
import L from 'leaflet';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import '@maplibre/maplibre-gl-leaflet';
import { cellsInBounds, approxCellSizeMeters } from '../services/s2grid';
import type { S2CellPolygon } from '../services/s2grid';
import { parseCoord, formatCoord, useCoordSettings, isDefaultCoordSettings, coordBadge } from '../utils/coords';
import Supercluster from 'supercluster';
import { usePipiMushroomLayer } from '../hooks/usePipiMushroomLayer';
import type { PipiKinds } from '../hooks/usePipiMushroomLayer';
import { resolvePipiFlowerFilter, resolvePipiKinds, resolvePipiMarkerSize, resolvePipiMushroomFilter } from '../defaults';
import type { PipiFlowerFilter, PipiMarkerSize, PipiMushroomFilter } from '../defaults';
import PipiMushroomPanel from './PipiMushroomPanel';
import { PIPI_MIN_ZOOM } from '../pipiFetchPlanner';

// MapLibre's Leaflet binding looks up `window.maplibregl` rather than
// taking it as a constructor argument. Hoist it once at module load so
// `L.maplibreGL({ ... })` resolves correctly when the layer is created.
// maplibre-gl 6 dropped the default export (ESM-only, named exports
// throughout), so this must be a namespace import.
if (typeof window !== 'undefined' && !(window as any).maplibregl) {
  (window as any).maplibregl = maplibregl;
}

// maplibre-gl 6 derives its worker URL from `import.meta.url` and gives up
// when that isn't http(s) — which is exactly the packaged Electron case
// (the app is loaded over file://). Point it at the worker chunk Vite
// emits for us instead.
maplibregl.config.WORKER_URL = maplibreWorkerUrl;

interface Position {
  lat: number;
  lng: number;
}

interface Waypoint {
  lat: number;
  lng: number;
  index: number;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  lat: number;
  lng: number;
}

import type { DeviceRuntime, RuntimesMap } from '../hooks/useSimulation';
import type { DeviceInfo } from '../hooks/useDevice';

interface MapViewProps {
  currentPosition: Position | null;
  destination: Position | null;
  waypoints: Waypoint[];
  routePath: Position[];
  // 種花模式 preview: one segmented polygon (the circle the avatar will walk)
  // per waypoint, drawn so the user sees the configured radius + segment
  // count before / while running.
  flowerPreview?: Position[][];
  randomWalkRadius: number | null;
  // Fixed sampling centre of an active random walk (broadcast by the backend
  // on start). When set and mode is "fixed", the radius circle pins here.
  randomWalkCenter?: Position | null;
  randomWalkCenterMode?: 'fixed' | 'follow';
  onMapClick: (lat: number, lng: number) => void;
  onTeleport: (lat: number, lng: number, source?: 'menu' | 'coord') => void;
  onNavigate: (lat: number, lng: number, source?: 'menu' | 'coord') => void;
  onAddBookmark: (lat: number, lng: number) => void;
  onAddWaypoint?: (lat: number, lng: number) => void;
  // Left-click on a waypoint marker opens a small action menu. Both
  // handlers are optional — when undefined, the waypoint marker stays
  // tooltip-only (legacy behaviour).
  onSetWpAsStart?: (index: number) => void;
  onRemoveWaypoint?: (index: number) => void;
  // Arms a one-shot "insert after this waypoint" mode. Parent shows
  // the cancel banner and turns insertAfterActive on; the next map
  // click consumes the mode and inserts the new waypoint at index+1.
  onInsertAfterWp?: (index: number) => void;
  // When true the map cursor swaps to crosshair so the user knows the
  // next click will splice a new waypoint into the route.
  insertAfterActive?: boolean;
  showWaypointOption?: boolean;
  deviceConnected?: boolean;
  onShowToast?: (msg: string) => void;
  // HTML snippet to paint into the current-position divIcon. Lets the parent
  // swap the "blue person" for one of the preset characters or a user-
  // uploaded PNG. Empty / undefined = fall back to the built-in default.
  userAvatarHtml?: string;
  // Group mode: when runtimes + devices are present and 2+ devices connected,
  // render per-device markers/polylines/circles. Single-device rendering is
  // still driven by the legacy currentPosition/destination/routePath props.
  runtimes?: RuntimesMap;
  devices?: DeviceInfo[];
  // Optional bookmark list to render as small clickable markers. When
  // enabled, clicking a marker calls onTeleport at that coordinate.
  bookmarkPins?: Array<{ id?: string; name: string; lat: number; lng: number; country_code?: string }>;
  showBookmarkPins?: boolean;
  // Imperative escape hatch so non-map components (e.g. the StatusBar's
  // "Locate PC" pan-only flow) can move the map view without going
  // through React state.
  onMapReady?: (api: {
    panTo: (lat: number, lng: number, zoom?: number) => void;
    fitBounds: (points: { lat: number; lng: number }[]) => void;
  }) => void;
  // Preview-only pin: rendered when the user previews a coord (camera-only
  // fly) so they can see exactly where they're looking on the map. Distinct
  // shape + amber color so it doesn't get confused with the red destination
  // marker. Cleared by the parent when a real teleport / clear runs.
  previewPin?: Position | null;
  onPreviewPinClear?: () => void;
  // Triggered by the coord-input overlay's "Preview" button. The parent
  // owns both the map-pan and the preview-pin state so we route through
  // it instead of touching mapRef locally.
  onCoordPreview?: (lat: number, lng: number) => void;
  // Recent destinations (last 20 teleport / navigate / search actions).
  // Rendered in a topright popover so the user can re-fly in one click.
  recentPlaces?: Array<{ lat: number; lng: number; kind: 'teleport' | 'navigate' | 'search' | 'coord_teleport' | 'coord_navigate'; name: string; ts: number }>;
  onRecentReFly?: (entry: { lat: number; lng: number; kind: 'teleport' | 'navigate' | 'search' | 'coord_teleport' | 'coord_navigate'; name: string }) => void;
  onRecentClear?: () => void;
  // Click handler for the topleft library shortcut. Opens the
  // bookmarks / routes panel without the user having to scroll down
  // to the ControlPanel's library button.
  onOpenLibrary?: () => void;
  // Transport (start / stop / pause) — moved from the sidebar to the
  // bottom-left of the map so they sit just above the coord-input strip.
  isRunning?: boolean;
  isPaused?: boolean;
  onStart?: () => void;
  onStop?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  // Bulk-paste route shortcut on the map (next to the library star),
  // visible only in MultiStop / Loop modes.
  showBulkPasteOnMap?: boolean;
  onBulkPasteOpen?: () => void;
}

// Transport (Start / Stop / Pause / Resume) — bottom-left of the map,
// directly above the coord-input strip. Mockup S6 (玻璃膠囊) base with
// the active state filled D8 (sliding highlight). Width fits content
// only — we don't want the whole row to span the coord input below.
function TransportButtons({
  isRunning,
  isPaused,
  onStart,
  onStop,
  onPause,
  onResume,
  t,
}: {
  isRunning: boolean;
  isPaused: boolean;
  onStart?: () => void;
  onStop?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  t: React.MutableRefObject<(k: any, v?: any) => string>;
}) {
  // Don't render if no callbacks were wired (defensive).
  if (!onStart && !onStop && !onPause && !onResume) return null;
  const label = (k: string) => {
    try { return t.current(k as any); } catch { return ''; }
  };
  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        // Static (not absolute): sits inside the bottom-left stack
        // wrapper so its vertical position is dictated by the flex
        // column rather than a hand-tuned bottom value.
        display: 'inline-flex',
        alignSelf: 'flex-start',
        alignItems: 'center',
        gap: 0,
        padding: 4,
        background: 'var(--glass-float)',
        backdropFilter: 'var(--glass-blur)',
        WebkitBackdropFilter: 'var(--glass-blur)',
        border: '1px solid rgba(var(--accent-rgb), 0.22)',
        borderRadius: 10,
        boxShadow: '0 10px 26px rgba(8, 11, 22, 0.5)',
        pointerEvents: 'auto',
      }}
    >
      {!isRunning && (
        <button
          className="lw-transport-btn lw-transport-start"
          onClick={onStart}
          title={label('generic.start')}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21" /></svg>
          {label('generic.start')}
        </button>
      )}
      {isRunning && (
        <button
          className="lw-transport-btn lw-transport-stop"
          onClick={onStop}
          title={label('generic.stop')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
          {label('generic.stop')}
        </button>
      )}
      {isRunning && !isPaused && (
        <button
          className="lw-transport-btn lw-transport-pause"
          onClick={onPause}
          title={label('generic.pause')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1" /><rect x="14" y="4" width="5" height="16" rx="1" /></svg>
          {label('generic.pause')}
        </button>
      )}
      {isRunning && isPaused && (
        <button
          className="lw-transport-btn lw-transport-resume"
          onClick={onResume}
          title={label('generic.resume')}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21" /></svg>
          {label('generic.resume')}
        </button>
      )}
    </div>
  );
}

const DEVICE_COLORS = ['#4285f4', '#ff9800'];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const DEVICE_LETTERS = ['A', 'B'];

function haversineM(a: Position, b: Position): number {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const MapView: React.FC<MapViewProps> = ({
  currentPosition,
  destination,
  waypoints,
  routePath,
  flowerPreview,
  randomWalkRadius,
  randomWalkCenter,
  randomWalkCenterMode = 'fixed',
  onMapClick,
  onTeleport,
  onNavigate,
  onAddBookmark,
  onAddWaypoint,
  onSetWpAsStart,
  onRemoveWaypoint,
  onInsertAfterWp,
  insertAfterActive,
  showWaypointOption,
  deviceConnected = true,
  onShowToast,
  userAvatarHtml,
  runtimes,
  devices,
  bookmarkPins,
  showBookmarkPins,
  onMapReady,
  previewPin,
  onPreviewPinClear,
  onCoordPreview,
  recentPlaces,
  onRecentReFly,
  onRecentClear,
  onOpenLibrary,
  isRunning,
  isPaused,
  onStart,
  onStop,
  onPause,
  onResume,
  showBulkPasteOnMap,
  onBulkPasteOpen,
}) => {
  // Dual-mode rendering disabled by design: with pre-sync (both devices
  // teleport to the same start before any group action) and shared random
  // seed, the two phones always sit at the exact same coordinate, so two
  // markers and two polylines just overlap and add visual noise. We keep
  // the dual data plumbing (devices, runtimes) for the dual cleanup effect
  // below but always render the single-device view (driven by the primary
  // device's currentPosition / routePath / destination passed in as props).
  const dualMode = false;
  // Suppress unused-prop warnings — kept for API compatibility and the
  // dual-marker cleanup effect that wipes any residual dual markers if a
  // user upgrades from an earlier 0.2.0 build that had them rendered.
  void devices; void runtimes;
  const t = useT();
  const coordSettings = useCoordSettings();
  // The map-init useEffect only runs once, so its click handler captures the
  // first-render `t`. Language switches then don't reach the tooltip hint.
  // Route lookups through a ref that we keep in sync every render.
  const tRef = useRef(t);
  // onMapClick closure gets captured by the once-per-mount click handler;
  // route through a ref so toggling the prop mid-session takes effect.
  const onMapClickRef = useRef(onMapClick);
  useEffect(() => { onMapClickRef.current = onMapClick; }, [onMapClick]);
  tRef.current = t;
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const currentMarkerRef = useRef<L.CircleMarker | null>(null);
  const prevPositionRef = useRef<Position | null>(null);
  const destMarkerRef = useRef<L.Marker | null>(null);
  const previewMarkerRef = useRef<L.Marker | null>(null);
  const waypointMarkersRef = useRef<L.Marker[]>([]);
  const bookmarkMarkersRef = useRef<L.Marker[]>([]);
  const polylineRef = useRef<L.Polyline | null>(null);
  // Second polyline layered on top for the flowing-arrow animation (design 6).
  const polylineArrowRef = useRef<L.Polyline | null>(null);
  // Recenter-on-user-position button. We mount it as a real Leaflet control
  // (not absolutely-positioned React JSX) so Leaflet's own .leaflet-top
  // .leaflet-left layout pins it to the same x as the zoom buttons, with the
  // standard 10px gap. Any other approach leaves it a few px off.
  const recenterBtnRef = useRef<HTMLButtonElement | null>(null);
  const recenterHandlerRef = useRef<() => void>(() => {});
  // Follow-mode toggle button (sits below recenter as a third leaflet-bar).
  // When enabled, the map auto-pans to the current position on every update.
  // Manual map drag disables follow so the user can pan/look around freely.
  const followBtnRef = useRef<HTMLButtonElement | null>(null);
  const followHandlerRef = useRef<() => void>(() => {});
  // Library button handler (bottom of the topleft stack). Wired to the
  // App-level callback that bumps `openLibraryToken`, triggering the
  // ControlPanel library panel to open.
  const openLibraryHandlerRef = useRef<() => void>(() => {});
  // S2 cell grid overlay (Pokemon GO / Ingress style). Toggle button below
  // the library button. Default level 17 (~80m cells, the canonical Niantic
  // decor cell). Layer + level live in refs / state; visibility is mirrored
  // on the button via background colour.
  const s2GridBtnRef = useRef<HTMLButtonElement | null>(null);
  const s2GridHandlerRef = useRef<() => void>(() => {});
  const s2LayerRef = useRef<L.LayerGroup | null>(null);
  // Mushroom map toggle (below the S2 button). Click toggles the layer,
  // right-click opens its panel (what to show, and the login cookie).
  const pipiBtnRef = useRef<HTMLButtonElement | null>(null);
  const pipiHandlerRef = useRef<() => void>(() => {});
  // followStateRef mirrors followMode so the dragstart handler (wired once
  // at map init) sees the latest value without a stale closure.
  const followStateRef = useRef(false);
  // onShowToast captured by once-mount handlers. Routed through a ref so
  // prop changes mid-session take effect.
  const onShowToastRef = useRef(onShowToast);
  useEffect(() => { onShowToastRef.current = onShowToast; }, [onShowToast]);
  // Bookmark-pin teleport handler routed through a ref so the clustering
  // effect doesn't rebuild the (potentially 50k-point) supercluster index
  // just because the parent passed a new onTeleport closure.
  const onTeleportRef = useRef(onTeleport);
  useEffect(() => { onTeleportRef.current = onTeleport; }, [onTeleport]);
  // Waypoint marker click handlers — kept in refs so the per-marker click
  // handler captured inside the waypoints useEffect always calls the
  // freshest prop without re-creating every marker on each prop change.
  const onSetWpAsStartRef = useRef(onSetWpAsStart);
  useEffect(() => { onSetWpAsStartRef.current = onSetWpAsStart; }, [onSetWpAsStart]);
  const onRemoveWaypointRef = useRef(onRemoveWaypoint);
  useEffect(() => { onRemoveWaypointRef.current = onRemoveWaypoint; }, [onRemoveWaypoint]);
  const onInsertAfterWpRef = useRef(onInsertAfterWp);
  useEffect(() => { onInsertAfterWpRef.current = onInsertAfterWp; }, [onInsertAfterWp]);
  // Mini context menu shown on left-click of a waypoint marker.
  // Independent from the right-click `contextMenu` so opening one does
  // not close / reposition the other.
  const [wpMenu, setWpMenu] = useState<{
    visible: boolean; x: number; y: number; index: number; isStart: boolean;
  }>({ visible: false, x: 0, y: 0, index: 0, isStart: false });
  const closeWpMenu = useCallback(() => {
    setWpMenu((prev) => prev.visible ? { ...prev, visible: false } : prev);
  }, []);
  // clickMarkerRef removed — left-click no longer drops a pin.
  const radiusCircleRef = useRef<L.Circle | null>(null);

  const [followMode, setFollowMode] = useState(false);
  useEffect(() => { followStateRef.current = followMode; }, [followMode]);

  // S2 cell grid state. Persisted in localStorage so the user's preferred
  // level + on/off survives across launches (similar to tile-layer choice).
  const [s2Enabled, setS2Enabled] = useState<boolean>(() => {
    try { return localStorage.getItem('locwarp.s2_enabled') === '1'; }
    catch { return false; }
  });
  const [s2Level, setS2Level] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('locwarp.s2_level');
      const n = raw ? parseInt(raw, 10) : 17;
      if (Number.isFinite(n) && n >= 1 && n <= 30) return n;
    } catch { /* fall through */ }
    return 17;
  });
  const [s2PickerOpen, setS2PickerOpen] = useState(false);

  useEffect(() => {
    try { localStorage.setItem('locwarp.s2_enabled', s2Enabled ? '1' : '0'); }
    catch { /* ignore */ }
  }, [s2Enabled]);
  useEffect(() => {
    try { localStorage.setItem('locwarp.s2_level', String(s2Level)); }
    catch { /* ignore */ }
  }, [s2Level]);

  const [pipiEnabled, setPipiEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('locwarp.pipi_enabled') === '1'; }
    catch { return false; }
  });
  const readStored = (key: string): string | null => {
    try { return localStorage.getItem(key); } catch { return null; }
  };
  const [pipiKinds, setPipiKinds] = useState<PipiKinds>(() => resolvePipiKinds(readStored('locwarp.pipi_kinds')));
  const [pipiFlowerFilter, setPipiFlowerFilter] = useState<PipiFlowerFilter>(() => resolvePipiFlowerFilter(readStored('locwarp.pipi_flower_filter')));
  const [pipiMarkerSize, setPipiMarkerSize] = useState<PipiMarkerSize>(() => resolvePipiMarkerSize(readStored('locwarp.pipi_marker_size')));
  const [pipiMushroomFilter, setPipiMushroomFilter] = useState<PipiMushroomFilter>(() => resolvePipiMushroomFilter(readStored('locwarp.pipi_mushroom_filter')));
  const [pipiPanelOpen, setPipiPanelOpen] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem('locwarp.pipi_enabled', pipiEnabled ? '1' : '0');
      localStorage.setItem('locwarp.pipi_kinds', JSON.stringify(pipiKinds));
      localStorage.setItem('locwarp.pipi_flower_filter', JSON.stringify(pipiFlowerFilter));
      localStorage.setItem('locwarp.pipi_marker_size', pipiMarkerSize);
      localStorage.setItem('locwarp.pipi_mushroom_filter', JSON.stringify(pipiMushroomFilter));
    } catch { /* ignore */ }
  }, [pipiEnabled, pipiKinds, pipiFlowerFilter, pipiMarkerSize, pipiMushroomFilter]);

  const [recentOpen, setRecentOpen] = useState(false);
  // Clear-button confirmation state. First click flips the single
  // "清空" button into a pair of explicit "確定清空" / "取消" buttons.
  // User has to pick one — no auto-revert, no stale timers.
  const [clearConfirming, setClearConfirming] = useState(false);
  useEffect(() => {
    if (!recentOpen) setClearConfirming(false);
  }, [recentOpen]);
  // Recent popover drag offset. Clicking + dragging the header shifts
  // the panel; state persists until closed so the user can park it.
  const [recentDragOffset, setRecentDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  // Capture-phase mousemove/mouseup listeners on document so Leaflet's
  // map-container handlers can't eat the events before we update the
  // drag offset. Previous window-level + Pointer-Events attempts both
  // failed because Leaflet attached its own handlers higher up.
  const beginRecentDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    // Ignore mousedown that lands on a child button (e.g. 清空);
    // otherwise our drag handler swallows the click.
    const t = e.target as HTMLElement;
    if (t.closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    const baseX = recentDragOffset.x;
    const baseY = recentDragOffset.y;
    const startX = e.clientX;
    const startY = e.clientY;
    // Use document with capture:true so Leaflet / the map container
    // cannot swallow mousemove / mouseup before we see them.
    const onMove = (ev: MouseEvent) => {
      ev.preventDefault();
      setRecentDragOffset({
        x: baseX + (ev.clientX - startX),
        y: baseY + (ev.clientY - startY),
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  };

  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    lat: 0,
    lng: 0,
  });
  // DOM ref + clamped position state. Separate states for "click point" and
  // "where the menu is actually painted" — the paint position is set ONCE
  // per open via useLayoutEffect after measuring the real rendered size.
  // Critical: the layout effect's deps do NOT include contextMenuPos itself,
  // otherwise the setState triggers the effect again and we get an infinite
  // reposition loop (that was v0.2.38's bug).
  const contextMenuElRef = useRef<HTMLDivElement | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!contextMenu.visible) {
      if (contextMenuPos !== null) setContextMenuPos(null);
      return;
    }
    const el = contextMenuElRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Clamp: prefer opening rightward / downward, but if that overflows,
    // push the menu back in so it never clips the viewport edge.
    const left = Math.max(margin, Math.min(contextMenu.x, vw - width - margin));
    const top  = Math.max(margin, Math.min(contextMenu.y, vh - height - margin));
    setContextMenuPos({ left, top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextMenu.visible, contextMenu.x, contextMenu.y]);

  // Reverse-geocode state for the context menu header row. Reset whenever
  // the menu closes or the right-click target changes, so a stale address
  // from a previous click never leaks into a new lookup.
  const [reverseGeo, setReverseGeo] = useState<{
    loading: boolean; address: string | null; error: string | null;
    key: string; // lat|lng the result belongs to
  }>({ loading: false, address: null, error: null, key: '' });

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
    setReverseGeo({ loading: false, address: null, error: null, key: '' });
  }, []);

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [25.033, 121.5654],
      zoom: 13,
      // Keep Leaflet's default control off so we can position our own
      // zoom control below the EtaBar on the left (default top-left
      // would collide with the overlay).
      zoomControl: false,
      // Snap wheel zoom to integer levels + require a full notch per step,
      // so one wheel tick = one tile-load batch instead of cascading
      // intermediate zooms that all fire tile requests and bomb OSM's
      // rate limiter with black-tile fallout.
      zoomSnap: 1,
      wheelPxPerZoomLevel: 120,
      wheelDebounceTime: 60,
    });
    const zoomCtrl = L.control.zoom({ position: 'topleft' });
    zoomCtrl.addTo(map);
    // Nudge the top-left and top-right control clusters down so they sit
    // below the EtaBar (full-width, absolute-positioned at top:0) instead
    // of being partially covered by it.
    const topLeftEl = (map as any)._controlCorners?.topleft as HTMLElement | undefined;
    if (topLeftEl) {
      topLeftEl.style.marginTop = '56px';
    }
    const topRightEl = (map as any)._controlCorners?.topright as HTMLElement | undefined;
    if (topRightEl) {
      topRightEl.style.marginTop = '56px';
    }

    // Recenter button as a second leaflet-bar in the topleft corner. This
    // way Leaflet's layout (margin-left: 10px on each control + 10px gap
    // between stacked controls) handles positioning — guarantees same x as
    // the zoom +/- buttons with a natural gap below them.
    if (topLeftEl) {
      const wrapper = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      const btn = L.DomUtil.create('button', '', wrapper) as HTMLButtonElement;
      btn.type = 'button';
      btn.title = tRef.current('map.recenter');
      btn.setAttribute('role', 'button');
      btn.style.cssText = [
        'width: 30px', 'height: 30px', 'display: flex',
        'align-items: center', 'justify-content: center',
        'padding: 0', 'margin: 0', 'cursor: pointer',
        'background: var(--bg-surface, #2a2f3a)',
        'color: #fff', 'border: none', 'border-radius: 0',
      ].join(';');
      btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3" />
        <line x1="12" y1="2" x2="12" y2="5" />
        <line x1="12" y1="19" x2="12" y2="22" />
        <line x1="2" y1="12" x2="5" y2="12" />
        <line x1="19" y1="12" x2="22" y2="12" />
      </svg>`;
      L.DomEvent.disableClickPropagation(wrapper);
      L.DomEvent.on(btn, 'click', (e: Event) => {
        e.preventDefault();
        if (btn.disabled) return;
        recenterHandlerRef.current();
      });
      topLeftEl.appendChild(wrapper);
      recenterBtnRef.current = btn;
    }

    // Follow-mode toggle, mounted as a third leaflet-bar so it lines up
    // exactly under the recenter button with Leaflet's standard 10px gap.
    if (topLeftEl) {
      const wrapper = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      const btn = L.DomUtil.create('button', '', wrapper) as HTMLButtonElement;
      btn.type = 'button';
      btn.title = tRef.current('map.follow_off');
      btn.setAttribute('role', 'button');
      btn.setAttribute('aria-pressed', 'false');
      btn.style.cssText = [
        'width: 30px', 'height: 30px', 'display: flex',
        'align-items: center', 'justify-content: center',
        'padding: 0', 'margin: 0', 'cursor: pointer',
        'background: var(--bg-surface, #2a2f3a)',
        'color: #fff', 'border: none', 'border-radius: 0',
      ].join(';');
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
        <polygon points="3 11 22 2 13 21 11 13 3 11"/>
      </svg>`;
      L.DomEvent.disableClickPropagation(wrapper);
      L.DomEvent.on(btn, 'click', (e: Event) => {
        e.preventDefault();
        followHandlerRef.current();
      });
      topLeftEl.appendChild(wrapper);
      followBtnRef.current = btn;
    }

    // (Library shortcut star removed — the top navigation bar's 收藏 tab
    // is now the single entry point for the library panel; issue #34.)

    // S2 cell grid toggle — fifth leaflet-bar. Tap to overlay an Ingress /
    // Pokemon GO style cell grid at the user-chosen level (default 17).
    // Right-click (or long-press) opens the level picker popover.
    if (topLeftEl) {
      const wrapper = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      const btn = L.DomUtil.create('button', 'locwarp-s2-btn', wrapper) as HTMLButtonElement;
      btn.type = 'button';
      btn.title = tRef.current('map.s2_toggle');
      btn.setAttribute('role', 'button');
      btn.setAttribute('aria-pressed', 'false');
      btn.style.cssText = [
        'width: 30px', 'height: 30px', 'display: flex',
        'align-items: center', 'justify-content: center',
        'padding: 0', 'margin: 0', 'cursor: pointer',
        'background: var(--bg-surface, #2a2f3a)',
        'color: #fff', 'border: none', 'border-radius: 0',
      ].join(';');
      btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="1" />
        <line x1="9" y1="3" x2="9" y2="21" />
        <line x1="15" y1="3" x2="15" y2="21" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="3" y1="15" x2="21" y2="15" />
      </svg>`;
      L.DomEvent.disableClickPropagation(wrapper);
      L.DomEvent.on(btn, 'click', (e: Event) => {
        e.preventDefault();
        s2GridHandlerRef.current();
      });
      L.DomEvent.on(btn, 'contextmenu', (e: Event) => {
        e.preventDefault();
        setS2PickerOpen((o) => !o);
      });
      topLeftEl.appendChild(wrapper);
      s2GridBtnRef.current = btn;
    }

    // Mushroom map toggle. Click toggles the overlay; right-click opens
    // its panel.
    if (topLeftEl) {
      const wrapper = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      const btn = L.DomUtil.create('button', 'locwarp-pipi-btn', wrapper) as HTMLButtonElement;
      btn.type = 'button';
      btn.title = tRef.current('map.pipi_toggle');
      btn.setAttribute('role', 'button');
      btn.setAttribute('aria-pressed', 'false');
      btn.style.cssText = [
        'width: 30px', 'height: 30px', 'display: flex',
        'align-items: center', 'justify-content: center',
        'padding: 0', 'margin: 0', 'cursor: pointer',
        'background: var(--bg-surface, #2a2f3a)',
        'color: #fff', 'border: none', 'border-radius: 0',
      ].join(';');
      btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 12a9 8 0 0 1 18 0z" />
        <path d="M9 12v5a3 3 0 0 0 6 0v-5" />
        <circle cx="9" cy="8.5" r="0.9" fill="currentColor" />
        <circle cx="14.5" cy="7.2" r="0.9" fill="currentColor" />
      </svg>`;
      L.DomEvent.disableClickPropagation(wrapper);
      // Click opens the panel, which holds the on/off switch and the
      // login steps; nothing here depends on knowing about a right-click.
      // Right-click stays as a shortcut that flips the layer directly.
      L.DomEvent.on(btn, 'click', (e: Event) => {
        e.preventDefault();
        setPipiPanelOpen((o) => !o);
      });
      L.DomEvent.on(btn, 'contextmenu', (e: Event) => {
        e.preventDefault();
        pipiHandlerRef.current();
      });
      topLeftEl.appendChild(wrapper);
      pipiBtnRef.current = btn;
    }

    // User-initiated drag disables follow mode so they can pan freely. We
    // only react when follow is currently on (read via ref so the handler
    // wired once at mount sees the latest state). dragstart fires only on
    // pointer drag — programmatic panTo / setView do not trigger it, so
    // the auto-pan loop won't accidentally turn itself off.
    map.on('dragstart', () => {
      if (!followStateRef.current) return;
      setFollowMode(false);
      try {
        onShowToastRef.current?.(tRef.current('map.follow_disabled_toast'));
      } catch { /* ignore */ }
    });

    // Tile layer tuning (shared across all providers):
    //   updateWhenIdle=false    — load during pan, not only on idle
    //   updateWhenZooming=true  — fetch target-level tiles during zoom so
    //                             the user sees sharp tiles instead of
    //                             upscaled-and-blurry placeholders
    //   keepBuffer=4            — keep 4 rows/cols of off-screen tiles cached
    //   crossOrigin=true        — enable HTTP cache reuse across layers
    //
    // detectRetina intentionally NOT enabled: its "fetch zoom+1, display at
    // half size" approach makes every label on the map physically smaller,
    // which users reported as hard to read on HiDPI screens. Slightly
    // softer raster is the lesser evil versus unreadable labels.
    const baseOpts = {
      updateWhenIdle: false,
      updateWhenZooming: true,
      keepBuffer: 4,
      crossOrigin: true,
    } as const;
    // OSM Standard (Mapnik). Uses a/b/c subdomains to parallelise fetches.
    // electron/main.js rewrites the User-Agent for these hosts so tile.osm.org
    // does not reject the default Chromium UA with HTTP 418.
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      ...baseOpts,
      subdomains: 'abc', maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
    // ESRI World Imagery — free satellite/aerial imagery, global coverage.
    // URL template uses {y}/{x} order (ESRI convention), not the usual
    // {x}/{y}. No API key needed, generous usage limits.
    const esriSatLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        ...baseOpts,
        maxZoom: 19,
        attribution:
          'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      },
    );
    // ESRI World Street Map — same server and {y}/{x} convention as World
    // Imagery, no API key. Labels are mostly English outside the US.
    const esriStreetLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      {
        ...baseOpts,
        maxZoom: 19,
        attribution:
          'Tiles &copy; Esri &mdash; Source: Esri, HERE, Garmin, USGS, NGA, and the GIS User Community',
      },
    );
    // Google road map tiles. Undocumented endpoint with no API key and no
    // service guarantee, so it may stop working at any time. Labelled as
    // experimental in the layer picker for that reason.
    const googleLayer = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
      ...baseOpts,
      subdomains: '0123', maxZoom: 20,
      attribution: 'Map data &copy; Google',
    });
    // OpenFreeMap Liberty — free, no API key, vector tiles styled to look
    // close to Mapbox / Google. Rendered via MapLibre GL through the
    // maplibre-gl-leaflet binding so Leaflet treats it like any other
    // base layer. Bigger bundle than raster but globally free with no
    // monthly cap.
    const libertyLayer = (L as any).maplibreGL({
      style: 'https://tiles.openfreemap.org/styles/liberty',
      attribution:
        '&copy; <a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }) as L.Layer;
    // Two more OpenFreeMap styles on the same tile source: Bright is the
    // classic OSM-like palette, Positron a light minimal basemap.
    const openFreeMapAttribution =
      '&copy; <a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
    const brightLayer = (L as any).maplibreGL({
      style: 'https://tiles.openfreemap.org/styles/bright',
      attribution: openFreeMapAttribution,
    }) as L.Layer;
    const positronLayer = (L as any).maplibreGL({
      style: 'https://tiles.openfreemap.org/styles/positron',
      attribution: openFreeMapAttribution,
    }) as L.Layer;
    // VersaTiles Colorful — community-run free vector tiles, no API key.
    const versaLayer = (L as any).maplibreGL({
      style: 'https://tiles.versatiles.org/assets/styles/colorful/style.json',
      attribution:
        '&copy; <a href="https://versatiles.org/" target="_blank" rel="noopener">VersaTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }) as L.Layer;

    // NLSC 通用版電子地圖 — Taiwan government basemap (內政部國土測繪中心).
    // No API key, no quota, completely free. Coverage is Taiwan-only:
    // the rest of the world renders as a blank/grey backdrop. WMTS uses
    // the {y}/{x} (row/col) ordering convention same as ESRI.
    const nlscLayer = L.tileLayer(
      'https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}',
      {
        ...baseOpts,
        maxZoom: 20,
        attribution:
          '&copy; <a href="https://www.nlsc.gov.tw/" target="_blank" rel="noopener">內政部國土測繪中心</a>',
      },
    );

    // GSI 地理院タイル — Japan government basemap (国土地理院).
    // Same model as NLSC: no API key, no quota, free. Coverage is
    // Japan-only. Standard XYZ tile layout (no row/col swap), so the
    // URL template matches Leaflet's defaults directly.
    const gsiLayer = L.tileLayer(
      'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
      {
        ...baseOpts,
        maxZoom: 18,
        attribution:
          '&copy; <a href="https://www.gsi.go.jp/" target="_blank" rel="noopener">国土地理院</a>',
      },
    );

    // Restore the user's previous choice so switching persists between launches.
    const savedLayer = (() => {
      try { return localStorage.getItem('locwarp.tile_layer') || 'osm'; }
      catch { return 'osm'; }
    })();
    // [storage key, picker label, layer] in picker order.
    const layerDefs: Array<[string, string, L.Layer]> = [
      ['osm', 'OSM', osmLayer],
      ['google', 'Google 圖磚 (測試) / Google Tiles (Beta)', googleLayer],
      ['esri_street', 'ESRI 街道 / Street Map', esriStreetLayer],
      ['esri', 'ESRI 衛星 / Satellite', esriSatLayer],
      ['liberty', 'OpenFreeMap Liberty', libertyLayer],
      ['bright', 'OpenFreeMap Bright', brightLayer],
      ['positron', 'OpenFreeMap Positron', positronLayer],
      ['versa', 'VersaTiles Colorful', versaLayer],
      ['nlsc', 'NLSC 台灣電子地圖', nlscLayer],
      ['gsi', 'GSI 日本地理院地圖', gsiLayer],
    ];
    const layers: Record<string, L.Layer> = {};
    for (const [, label, layer] of layerDefs) layers[label] = layer;
    // Unknown / retired keys (e.g. the removed 'carto') fall back to OSM.
    (layerDefs.find(([key]) => key === savedLayer) ?? layerDefs[0])[2].addTo(map);
    const layersControl = L.control.layers(layers, undefined, { position: 'topright', collapsed: true }).addTo(map);
    // Switching to a layer for the first time pays DNS + TLS to a new host
    // before the first tile can arrive. The picker expands on hover, so
    // warm every layer's host at that moment: by the time the user clicks,
    // the connection is already open. Vector styles are fetched too so
    // MapLibre reads them from the HTTP cache. Done on hover rather than at
    // startup because unused preconnected sockets are closed within seconds.
    const warmLayerHosts = () => {
      const origins = new Set<string>();
      const styleUrls: string[] = [];
      for (const [, , layer] of layerDefs) {
        const opts = (layer as any).options ?? {};
        if (typeof opts.style === 'string') {
          styleUrls.push(opts.style);
          origins.add(new URL(opts.style).origin);
        }
        const tpl: string | undefined = (layer as any)._url;
        if (tpl) {
          const subs: string[] = typeof opts.subdomains === 'string'
            ? opts.subdomains.split('') : (opts.subdomains ?? ['']);
          for (const sub of subs) {
            try { origins.add(new URL(tpl.replace('{s}', sub)).origin); } catch { /* skip */ }
          }
        }
      }
      for (const origin of origins) {
        const link = document.createElement('link');
        link.rel = 'preconnect';
        link.href = origin;
        link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
      }
      for (const url of styleUrls) void fetch(url).catch(() => { /* offline */ });
    };
    layersControl.getContainer()?.addEventListener('mouseenter', warmLayerHosts, { once: true });
    map.on('baselayerchange', (e: any) => {
      try {
        const key = layerDefs.find(([, label]) => label === e?.name)?.[0] ?? 'osm';
        localStorage.setItem('locwarp.tile_layer', key);
      } catch { /* storage disabled */ }
    });

    // Left-click on the map dismisses any open context menu.
    // If the parent wires `onMapClick` (currently used by the "left-click
    // to add waypoint" toggle in Loop / MultiStop modes), forward the
    // coordinates there too.
    map.on('click', (e: L.LeafletMouseEvent) => {
      closeContextMenu();
      setWpMenu((prev) => prev.visible ? { ...prev, visible: false } : prev);
      try {
        onMapClickRef.current?.(e.latlng.lat, e.latlng.lng);
      } catch { /* ignore handler errors */ }
    });

    map.on('contextmenu', (e: L.LeafletMouseEvent) => {
      e.originalEvent.preventDefault();
      setContextMenu({
        visible: true,
        x: e.originalEvent.clientX,
        y: e.originalEvent.clientY,
        lat: e.latlng.lat,
        lng: e.latlng.lng,
      });
    });

    mapRef.current = map;

    // Hand the parent an imperative panTo so it can move the view without
    // touching React state (used by the StatusBar's Locate-PC pan-only flow).
    if (onMapReady) {
      try {
        onMapReady({
          panTo: (lat: number, lng: number, zoom?: number) => {
            const m = mapRef.current;
            if (!m) return;
            const targetZoom = zoom ?? Math.max(m.getZoom(), 16);
            m.setView([lat, lng], targetZoom, { animate: true });
          },
          // Move the view to encompass a set of points (e.g. a loaded
          // route's waypoints) so the user doesn't have to hunt for where
          // the route is on the map. A single point just centers on it.
          fitBounds: (points: { lat: number; lng: number }[]) => {
            const m = mapRef.current;
            if (!m || !points || points.length === 0) return;
            if (points.length === 1) {
              m.setView([points[0].lat, points[0].lng], Math.max(m.getZoom(), 16), { animate: true });
              return;
            }
            const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));
            m.fitBounds(bounds, { padding: [60, 60], maxZoom: 17, animate: true });
          },
        });
      } catch { /* non-fatal */ }
    }

    // Fetch the user-saved initial position from the backend (once, on mount).
    // If set, pan the map to it. Brief Taipei flash is acceptable.
    import('../services/api').then(({ getInitialPosition }) => {
      getInitialPosition().then(({ position }) => {
        if (!position || !mapRef.current) return;
        if (prevPositionRef.current) return; // a real device position already arrived
        mapRef.current.setView([position.lat, position.lng], mapRef.current.getZoom());
      }).catch(() => { /* default center stays */ });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update current position marker — move existing marker instead of recreating.
  // When currentPosition becomes null (e.g. after 一鍵還原) remove the marker.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (dualMode) {
      // Dual-mode renderer below owns current-position markers; clear any
      // legacy single-device marker so it doesn't duplicate.
      if (currentMarkerRef.current) {
        try { (currentMarkerRef.current as any).remove(); } catch { /* ignore */ }
        currentMarkerRef.current = null;
      }
      // Pan the map to the new currentPosition in dual mode as well (address
      // search / coord input / bookmark click sets currentPosition before the
      // backend position_update arrives). First jump always centers; after
      // that only re-center on large jumps (>500m).
      if (currentPosition) {
        const latlng: L.LatLngExpression = [currentPosition.lat, currentPosition.lng];
        const prev = prevPositionRef.current;
        if (!prev) {
          map.setView(latlng, map.getZoom());
        } else {
          const dlat = (currentPosition.lat - prev.lat) * 111320;
          const dlng = (currentPosition.lng - prev.lng) * 111320 * Math.cos(currentPosition.lat * Math.PI / 180);
          const distM = Math.sqrt(dlat * dlat + dlng * dlng);
          if (distM > 500) {
            map.setView(latlng, map.getZoom());
          }
        }
        prevPositionRef.current = currentPosition;
      } else {
        prevPositionRef.current = null;
      }
      return;
    }
    if (!currentPosition) {
      if (currentMarkerRef.current) {
        try { (currentMarkerRef.current as any).remove(); } catch { /* ignore */ }
        currentMarkerRef.current = null;
      }
      prevPositionRef.current = null;
      return;
    }

    const latlng: L.LatLngExpression = [currentPosition.lat, currentPosition.lng];

    // If the avatar HTML changed since the marker was created, drop the
    // old marker so the recreate branch below paints with the new icon at
    // the current position — without this the user has to teleport again
    // to see their newly-saved avatar.
    const currentAvatar = userAvatarHtml ?? '';
    if (currentMarkerRef.current && lastAvatarHtmlRef.current !== currentAvatar) {
      try { (currentMarkerRef.current as any).remove(); } catch { /* ignore */ }
      currentMarkerRef.current = null;
    }

    if (currentMarkerRef.current) {
      // Just move the existing marker — no flicker. No tooltip update: the
      // marker is non-interactive (see below) and the coordinate readout
      // lives in the bottom status bar.
      (currentMarkerRef.current as any).setLatLng(latlng);
    } else {
      // First time: create the marker. User-supplied avatar HTML (if any)
      // replaces the default blue-person SVG. The pulse rings stay so the
      // marker still reads as a "live" position indicator.
      const avatarInner = userAvatarHtml && userAvatarHtml.length > 0
        ? userAvatarHtml
        : `<svg width="44" height="44" viewBox="0 0 44 44" class="pos-icon">
            <defs>
              <radialGradient id="posGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="#4285f4" stop-opacity="0.3"/>
                <stop offset="100%" stop-color="#4285f4" stop-opacity="0"/>
              </radialGradient>
              <filter id="posShadow" x="-30%" y="-30%" width="160%" height="160%">
                <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#4285f4" flood-opacity="0.6"/>
              </filter>
            </defs>
            <circle cx="22" cy="22" r="20" fill="url(#posGlow)"/>
            <circle cx="22" cy="22" r="11" fill="#4285f4" filter="url(#posShadow)"/>
            <circle cx="22" cy="22" r="9" fill="#2b6ff2"/>
            <circle cx="22" cy="18" r="3.5" fill="#ffffff" opacity="0.95"/>
            <path d="M15.5 28.5c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5" fill="#ffffff" opacity="0.95" stroke="none"/>
            <circle cx="22" cy="22" r="11" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.8"/>
          </svg>`;
      const personIcon = L.divIcon({
        className: 'current-pos-marker',
        html: `<div class="pos-pulse-ring"></div>
          <div class="pos-pulse-ring pos-pulse-ring-2"></div>
          ${avatarInner}`,
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      });

      // Non-interactive: no click handlers wired and no coord tooltip. The
      // blue person marker is pure UI — clicks should pass through to the
      // map / markers beneath it (bookmark pins etc.), and the coordinate
      // readout already lives in the bottom status bar.
      const marker = L.marker(latlng, {
        icon: personIcon,
        zIndexOffset: 1000,
        interactive: false,
      }).addTo(map);

      currentMarkerRef.current = marker as any;
      lastAvatarHtmlRef.current = currentAvatar;
    }

    // Only auto-center on first position or teleport (large jump > 500m)
    const prev = prevPositionRef.current;
    if (!prev) {
      map.setView(latlng, map.getZoom());
    } else {
      const dlat = (currentPosition.lat - prev.lat) * 111320;
      const dlng = (currentPosition.lng - prev.lng) * 111320 * Math.cos(currentPosition.lat * Math.PI / 180);
      const distM = Math.sqrt(dlat * dlat + dlng * dlng);
      if (distM > 500) {
        map.setView(latlng, map.getZoom());
      }
    }
    prevPositionRef.current = currentPosition;
  }, [currentPosition, dualMode, userAvatarHtml]);

  // Update destination marker
  const destSigRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (dualMode) {
      if (destMarkerRef.current) {
        destMarkerRef.current.remove();
        destMarkerRef.current = null;
      }
      destSigRef.current = null;
      return;
    }

    const sig = destination ? `${destination.lat.toFixed(7)},${destination.lng.toFixed(7)}` : null;
    if (sig === destSigRef.current) return;
    destSigRef.current = sig;

    if (destMarkerRef.current) {
      destMarkerRef.current.remove();
      destMarkerRef.current = null;
    }

    if (destination) {
      const redIcon = L.divIcon({
        className: 'dest-marker',
        html: `<svg width="36" height="50" viewBox="0 0 36 50">
          <defs>
            <filter id="destShadow" x="-20%" y="-10%" width="140%" height="130%">
              <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000" flood-opacity="0.4"/>
            </filter>
            <linearGradient id="destGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#ff6b6b"/>
              <stop offset="100%" stop-color="#e53935"/>
            </linearGradient>
          </defs>
          <ellipse cx="18" cy="47" rx="6" ry="2" fill="#000" opacity="0.2"/>
          <path d="M18 2C9.7 2 3 8.7 3 17c0 12 15 30 15 30s15-18 15-30C33 8.7 26.3 2 18 2z"
                fill="url(#destGrad)" filter="url(#destShadow)"/>
          <circle cx="18" cy="17" r="7" fill="#ffffff" opacity="0.95"/>
          <svg x="11" y="10" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e53935" stroke-width="2.5">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
        </svg>`,
        iconSize: [36, 50],
        iconAnchor: [18, 47],
      });

      const marker = L.marker([destination.lat, destination.lng], {
        icon: redIcon,
      }).addTo(map);

      marker.bindTooltip(t('map.destination'), { direction: 'top', offset: [0, -48] });
      destMarkerRef.current = marker;
    }
  }, [destination, dualMode]);

  // Preview pin (camera-only fly target). Amber teardrop with an eye icon
  // to convey "you're peeking at this coordinate, GPS hasn't actually
  // moved here". Click the marker to dismiss the pin.
  const previewSigRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const sig = previewPin ? `${previewPin.lat.toFixed(7)},${previewPin.lng.toFixed(7)},${coordSettings.datum},${coordSettings.order}` : null;
    if (sig === previewSigRef.current) return;
    previewSigRef.current = sig;

    if (previewMarkerRef.current) {
      previewMarkerRef.current.remove();
      previewMarkerRef.current = null;
    }

    if (previewPin) {
      const amberIcon = L.divIcon({
        className: 'preview-marker',
        html: `<svg width="36" height="50" viewBox="0 0 36 50">
          <defs>
            <filter id="previewShadow" x="-20%" y="-10%" width="140%" height="130%">
              <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000" flood-opacity="0.4"/>
            </filter>
            <linearGradient id="previewGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#fbbf24"/>
              <stop offset="100%" stop-color="#d97706"/>
            </linearGradient>
          </defs>
          <ellipse cx="18" cy="47" rx="6" ry="2" fill="#000" opacity="0.2"/>
          <path d="M18 2C9.7 2 3 8.7 3 17c0 12 15 30 15 30s15-18 15-30C33 8.7 26.3 2 18 2z"
                fill="url(#previewGrad)" filter="url(#previewShadow)"
                stroke="rgba(255,255,255,0.7)" stroke-width="1.2"/>
          <circle cx="18" cy="17" r="7" fill="#ffffff" opacity="0.95"/>
          <svg x="11" y="10" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </svg>`,
        iconSize: [36, 50],
        iconAnchor: [18, 47],
      });

      const marker = L.marker([previewPin.lat, previewPin.lng], {
        icon: amberIcon,
        zIndexOffset: 500,
      }).addTo(map);

      const tip = `${tRef.current('map.preview_pin')} · ${formatCoord(previewPin.lat, previewPin.lng, 5)}`;
      marker.bindTooltip(tip, { direction: 'top', offset: [0, -48] });
      if (onPreviewPinClear) {
        marker.on('click', () => onPreviewPinClear());
      }
      previewMarkerRef.current = marker;
    }
  }, [previewPin, onPreviewPinClear, coordSettings]);

  // Update waypoint markers
  const waypointSigRef = useRef<string>('');
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const sig = waypoints.map((w) => `${w.lat.toFixed(7)},${w.lng.toFixed(7)}`).join('|');
    if (sig === waypointSigRef.current) return;
    waypointSigRef.current = sig;

    waypointMarkersRef.current.forEach((m) => m.remove());
    waypointMarkersRef.current = [];

    waypoints.forEach((wp) => {
      // index 0 is the implicit start point; S + green, numbered + orange.
      // Design: subway-station style — thick ring + short stem + ground
      // shadow. Chosen by user (from route-marker-designs.html, pick 07).
      const isStart = wp.index === 0;
      const label = isStart ? 'S' : String(wp.index);
      const ringColor = isStart ? '#43a047' : '#ff9800';
      const ringGlow  = isStart ? 'rgba(67,160,71,0.32)' : 'rgba(255,152,0,0.3)';
      const textColor = isStart ? '#1b5e20' : '#e65100';
      const stemStart = isStart ? '#43a047' : '#ff9800';
      const stemEnd   = isStart ? 'rgba(67,160,71,0)' : 'rgba(255,152,0,0)';
      const wpIcon = L.divIcon({
        className: 'waypoint-marker',
        // Outer wrapper is pointer-events:auto + cursor:pointer so the
        // ENTIRE 40x46 marker area (ring + stem + ground shadow + the
        // padding around them) catches the left-click — not just the
        // 28px ring. Old layout had pointer-events:none on the wrapper
        // which meant a click on the stem or shadow passed straight
        // through to the map and the waypoint menu never opened.
        html: `<div style="
          position:relative;width:100%;height:100%;
          display:flex;flex-direction:column;align-items:center;justify-content:flex-end;
          pointer-events:auto;cursor:pointer;">
          <div style="
            width:28px;height:28px;border-radius:50%;
            border:4px solid ${ringColor};background:#fff;
            display:flex;align-items:center;justify-content:center;
            color:${textColor};font-weight:800;font-size:13px;
            font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
            box-shadow:0 0 0 2px ${ringGlow}, 0 3px 8px rgba(0,0,0,0.4);
          ">${label}</div>
          <div style="
            width:2px;height:10px;margin-top:-1px;
            background:linear-gradient(180deg, ${stemStart}, ${stemEnd});
          "></div>
          <div style="
            width:12px;height:3px;margin-top:-1px;
            background:rgba(0,0,0,0.5);border-radius:50%;filter:blur(1px);
          "></div>
        </div>`,
        iconSize: [40, 46],
        // Anchor = bottom-center of the ground shadow = exact (lat, lng).
        iconAnchor: [20, 46],
      });

      const marker = L.marker([wp.lat, wp.lng], { icon: wpIcon }).addTo(map);
      marker.bindTooltip(
        isStart ? tRef.current('panel.waypoint_start') : tRef.current('panel.waypoint_num', { n: wp.index }),
        { direction: 'top', offset: [0, -28] },
      );
      // Left-click opens a mini menu (set as start / delete). Stop the
      // event from bubbling to BOTH the map (so the click-to-add-
      // waypoint toggle doesn't see it as a new map click) AND the
      // DOM document (so the document-level outside-click handler
      // doesn't immediately close the menu we just opened — without
      // DOM stopPropagation the menu opens and closes in the same
      // tick and the user sees nothing).
      marker.on('click', (ev) => {
        const oe = ev.originalEvent as MouseEvent | undefined;
        L.DomEvent.stopPropagation(ev);
        if (oe) {
          oe.preventDefault?.();
          oe.stopPropagation?.();
          (oe as any).stopImmediatePropagation?.();
        }
        const x = oe?.clientX ?? 0;
        const y = oe?.clientY ?? 0;
        setWpMenu({ visible: true, x, y, index: wp.index, isStart });
      });
      waypointMarkersRef.current.push(marker);
    });
    // The waypoint signature may have changed under our feet (insert /
    // remove / rotate). Any open menu now points at a stale index, so
    // dismiss it.
    setWpMenu((prev) => prev.visible ? { ...prev, visible: false } : prev);
  }, [waypoints]);

  // Render/clear small bookmark pins on the map when the user toggles
  // 'show all bookmarks on map'. Each pin is clickable and teleports to
  // that bookmark's position.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    bookmarkMarkersRef.current.forEach((m) => m.remove());
    bookmarkMarkersRef.current = [];
    if (!showBookmarkPins || !bookmarkPins || bookmarkPins.length === 0) return;

    // Scalable clustering via supercluster (O(n log n) index) + viewport
    // culling. The old hand-rolled clusterer was O(n²) and built a DOM marker
    // for every bookmark regardless of what was on screen — fine for a few
    // hundred, but it freezes the UI thread at tens of thousands of points.
    // Now we index once, then on every pan/zoom render ONLY the clusters /
    // leaves that fall inside the current viewport, so the map never holds
    // more than a few dozen markers at a time no matter how many are saved.
    const index = new Supercluster({ radius: 60, maxZoom: 18, minPoints: 2 });
    index.load(
      bookmarkPins!.map((bm, i) => ({
        type: 'Feature' as const,
        properties: { idx: i },
        geometry: { type: 'Point' as const, coordinates: [bm.lng, bm.lat] },
      })),
    );

    const render = () => {
      bookmarkMarkersRef.current.forEach((m) => m.remove());
      bookmarkMarkersRef.current = [];
      const b = map.getBounds();
      const bbox: [number, number, number, number] = [
        b.getWest(), b.getSouth(), b.getEast(), b.getNorth(),
      ];
      const zoom = Math.round(map.getZoom());
      const features = index.getClusters(bbox, zoom);

      features.forEach((f: any) => {
        const [lng, lat] = f.geometry.coordinates as [number, number];
        const isCluster = !!f.properties.cluster;

        if (!isCluster) {
          const bm = bookmarkPins![f.properties.idx as number];
          const flagHtml = bm.country_code
            ? `<img src="https://flagcdn.com/w20/${bm.country_code}.png" style="width:18px;height:12px;border-radius:2px;flex-shrink:0;display:inline-block;vertical-align:middle;" alt="" />`
            : '';
          // Design 5 — Neon glass bubble. Frosted capsule with purple glow,
          // flag + name inside, tiny pointing nub underneath pinning the
          // coordinate. Max width 180px, name truncates with ellipsis.
          const icon = L.divIcon({
            className: 'bookmark-pin',
            // Outer div fills the Leaflet divIcon container, flex column
            // bottom-center so the glowing dot at the bottom sits exactly
            // on the (lat, lng) coordinate (matches iconAnchor below).
            html: `<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;pointer-events:none;">
              <div style="
                padding:5px 12px 5px 6px;
                border-radius:100px;
                background:linear-gradient(135deg, rgba(255,255,255,0.88), rgba(255,255,255,0.68));
                color:#0e0f10;
                font-size:12px;font-weight:600;line-height:1.2;
                box-shadow:
                  0 0 0 1px rgba(99,102,241,0.45),
                  0 0 14px rgba(99,102,241,0.4),
                  0 3px 8px rgba(0,0,0,0.15);
                display:inline-flex;align-items:center;gap:6px;
                max-width:180px;white-space:nowrap;overflow:hidden;
                backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
                pointer-events:auto;cursor:pointer;
              ">${flagHtml}<span style="overflow:hidden;text-overflow:ellipsis;max-width:140px;">${escapeHtml(bm.name)}</span></div>
              <div style="
                width:10px;height:10px;margin-top:-5px;
                background:linear-gradient(135deg, rgba(255,255,255,0.88), rgba(255,255,255,0.68));
                transform:rotate(45deg);
                box-shadow:2px 2px 6px rgba(99,102,241,0.3);
                border-right:1px solid rgba(99,102,241,0.45);
                border-bottom:1px solid rgba(99,102,241,0.45);
              "></div>
              <div style="width:5px;height:5px;border-radius:50%;background:rgba(99,102,241,0.7);margin-top:-3px;box-shadow:0 0 8px rgba(99,102,241,0.9);"></div>
            </div>`,
            iconSize: [200, 56],
            // Anchor = bottom-center of the icon = the glowing dot = exact
            // (lat, lng) coordinate. Previously the flex-inline column was
            // sitting at top-left so the whole pin rendered above-left of
            // the real point.
            iconAnchor: [100, 56],
          });
          const marker = L.marker([bm.lat, bm.lng], {
            icon,
            pane: 'markerPane',
            // Sit above the blue person marker (zIndexOffset 1000) so the
            // pin stays clickable when the user is standing on it.
            zIndexOffset: 2000,
          });
          marker.on('click', () => onTeleportRef.current(bm.lat, bm.lng));
          marker.addTo(map);
          bookmarkMarkersRef.current.push(marker);
        } else {
          // Design 4 — Polaroid stack cluster. Three overlapping mini cards
          // with rotation, top one shows the count.
          const count = f.properties.point_count as number;
          const countLabel = f.properties.point_count_abbreviated as string;
          const clusterId = f.properties.cluster_id as number;
          const icon = L.divIcon({
            className: 'bookmark-cluster-pin',
            html: `<div style="position:relative;width:52px;height:46px;pointer-events:none;">
              <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-8deg) translate(-4px, 3px);width:38px;height:32px;background:#fff;border:1px solid #c8ccd4;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>
              <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(6deg) translate(4px, -2px);width:38px;height:32px;background:#fff;border:1px solid #c8ccd4;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>
              <div style="
                position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
                width:38px;height:32px;background:#fff;border:1px solid #c8ccd4;
                box-shadow:0 2px 8px rgba(0,0,0,0.35);
                display:flex;align-items:center;justify-content:center;
                font-weight:700;font-size:15px;color:#2d3748;
                pointer-events:auto;cursor:pointer;
              ">${countLabel}</div>
              <div style="
                position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) translate(0, -14px);
                width:14px;height:3px;background:rgba(253,216,53,0.85);border-radius:1px;
                box-shadow:0 1px 2px rgba(0,0,0,0.2);
                z-index:3;
              "></div>
            </div>`,
            iconSize: [52, 46],
            iconAnchor: [26, 23],
          });
          const marker = L.marker([lat, lng], {
            icon,
            pane: 'markerPane',
            // Above blue person so the cluster card is always clickable.
            zIndexOffset: 2000,
          });

          // Small clusters (<= 12) open a clickable list so the user can pick
          // the exact bookmark — same UX as before. Bigger clusters just zoom
          // in to expand (a 5000-row popup is useless and slow to build).
          if (count <= 12) {
            const leaves = index.getLeaves(clusterId, count) as any[];
            const listHtml = leaves.map((leaf) => {
              const bm = bookmarkPins![leaf.properties.idx as number];
              const flag = bm.country_code
                ? `<img src="https://flagcdn.com/w20/${bm.country_code}.png" style="width:14px;height:10px;border-radius:1px;vertical-align:middle;margin-right:6px;" />`
                : '';
              return `<div
                class="bm-cluster-row"
                data-lat="${bm.lat}" data-lng="${bm.lng}"
                style="display:flex;align-items:center;gap:4px;padding:6px 8px;cursor:pointer;border-radius:4px;color:#e8e8ea;font-size:12px;transition:background 0.1s;"
                onmouseenter="this.style.background='rgba(255,255,255,0.08)'"
                onmouseleave="this.style.background='transparent'"
              >${flag}<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(bm.name)}</span></div>`;
            }).join('');
            const popup = L.popup({
              className: 'bookmark-cluster-popup',
              maxWidth: 240,
              offset: [0, -12],
            }).setContent(`
              <div style="background:rgba(26,29,39,0.96);backdrop-filter:blur(12px);border:1px solid rgba(var(--accent-rgb),0.25);border-radius:8px;padding:6px;min-width:180px;max-height:280px;overflow-y:auto;">
                <div style="padding:4px 8px;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--accent-soft);">${count} ${escapeHtml(count === 1 ? 'bookmark' : 'bookmarks')}</div>
                ${listHtml}
              </div>
            `);
            marker.bindPopup(popup);
            marker.on('popupopen', () => {
              document.querySelectorAll('.bm-cluster-row').forEach((el) => {
                el.addEventListener('click', () => {
                  const lat2 = parseFloat((el as HTMLElement).dataset.lat || '');
                  const lng2 = parseFloat((el as HTMLElement).dataset.lng || '');
                  if (Number.isFinite(lat2) && Number.isFinite(lng2)) {
                    map.closePopup();
                    onTeleportRef.current(lat2, lng2);
                  }
                });
              });
            });
          } else {
            // Zoom to the level where this cluster breaks apart, centered on it.
            marker.on('click', () => {
              const target = Math.min(index.getClusterExpansionZoom(clusterId), 18);
              map.setView([lat, lng], target, { animate: true });
            });
          }
          marker.addTo(map);
          bookmarkMarkersRef.current.push(marker);
        }
      });
    };
    render();

    // Re-cull on every pan / zoom. moveend fires for both, so a single
    // listener covers what used to take a full O(n²) rebuild on zoomend only
    // (and never updated on pan at all).
    const onMove = () => render();
    map.on('moveend', onMove);
    return () => { map.off('moveend', onMove); };
  }, [bookmarkPins, showBookmarkPins]);

  // Update route polyline
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (polylineRef.current) {
      polylineRef.current.remove();
      polylineRef.current = null;
    }
    if (polylineArrowRef.current) {
      polylineArrowRef.current.remove();
      polylineArrowRef.current = null;
    }

    if (dualMode) return;

    if (routePath.length > 1) {
      const latlngs: L.LatLngExpression[] = routePath.map((p) => [p.lat, p.lng]);
      // Design 6 (chosen): flowing arrows. Base solid line + animated white
      // dash overlay that flows from start to end so the user can tell the
      // travel direction at a glance.
      const base = L.polyline(latlngs, {
        color: '#3a66c5',
        weight: 7,
        opacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(map);
      polylineRef.current = base;

      const arrows = L.polyline(latlngs, {
        color: '#ffffff',
        weight: 3,
        opacity: 0.95,
        dashArray: '2 38',
        lineCap: 'round',
        className: 'route-flow-dash',
      }).addTo(map);
      polylineArrowRef.current = arrows;
    }
  }, [routePath, dualMode]);

  // Update random walk radius circle
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Remove old circle
    if (radiusCircleRef.current) {
      radiusCircleRef.current.remove();
      radiusCircleRef.current = null;
    }

    if (dualMode) return;

    // Circle centre:
    //  - "follow" mode (or before a walk starts): track the avatar so it
    //    shows where the next hop can land.
    //  - "fixed" mode while walking: pin to the captured start centre so the
    //    circle stops drifting away from the real (fixed) sampling area.
    const center =
      randomWalkCenterMode === 'fixed' && randomWalkCenter
        ? randomWalkCenter
        : currentPosition;

    // Draw circle when radius is set and we have a centre
    if (randomWalkRadius && randomWalkRadius > 0 && center) {
      const circle = L.circle(
        [center.lat, center.lng],
        {
          radius: randomWalkRadius,
          color: '#4285f4',
          weight: 2,
          opacity: 0.6,
          fillColor: '#4285f4',
          fillOpacity: 0.08,
          dashArray: '6, 6',
        }
      ).addTo(map);
      radiusCircleRef.current = circle;
    }
  }, [randomWalkRadius, currentPosition, randomWalkCenter, randomWalkCenterMode, dualMode]);

  // 種花模式: place a numbered badge (1..N) at every circle-segment vertex
  // so the user can see exactly how many segments each flower's circle has
  // and the order they're walked. divIcon markers sit above the route line
  // (zIndexOffset) so they stay visible once the simulation starts.
  const flowerPreviewRef = useRef<L.Marker[]>([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    flowerPreviewRef.current.forEach((p) => { try { p.remove(); } catch { /* ignore */ } });
    flowerPreviewRef.current = [];
    if (dualMode) return;
    if (!flowerPreview || flowerPreview.length === 0) return;
    flowerPreview.forEach((poly) => {
      if (!poly || poly.length < 2) return;
      poly.forEach((p, k) => {
        const icon = L.divIcon({
          className: 'flower-seg-badge',
          html: `<div style="display:flex;align-items:center;justify-content:center;`
            + `width:20px;height:20px;border-radius:50%;`
            + `background:#ffcf3f;color:#2a1d00;font-size:11px;font-weight:800;`
            + `border:2px solid #8a5a12;box-shadow:0 1px 4px rgba(0,0,0,0.6);`
            + `font-family:system-ui,sans-serif;">${k + 1}</div>`,
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        });
        const m = L.marker([p.lat, p.lng], {
          icon,
          interactive: false,
          keyboard: false,
          zIndexOffset: 1000,
        }).addTo(map);
        flowerPreviewRef.current.push(m);
      });
    });
  }, [flowerPreview, dualMode]);

  // ── Dual-mode per-device overlays ────────────────────────────────────
  // Keeps refs for markers/polylines/circles keyed by udid so updates don't
  // recreate Leaflet layers on every position tick.
  const deviceMarkersRef = useRef<Record<string, L.Marker>>({});
  const deviceDestMarkersRef = useRef<Record<string, L.Marker>>({});
  const deviceDestSharedRef = useRef<L.Marker | null>(null);
  const devicePolylinesRef = useRef<Record<string, L.Polyline>>({});
  const deviceCirclesRef = useRef<Record<string, L.Circle>>({});

  const clearDeviceOverlays = () => {
    Object.values(deviceMarkersRef.current).forEach((m) => { try { m.remove(); } catch { /* ignore */ } });
    deviceMarkersRef.current = {};
    Object.values(deviceDestMarkersRef.current).forEach((m) => { try { m.remove(); } catch { /* ignore */ } });
    deviceDestMarkersRef.current = {};
    if (deviceDestSharedRef.current) {
      try { deviceDestSharedRef.current.remove(); } catch { /* ignore */ }
      deviceDestSharedRef.current = null;
    }
    Object.values(devicePolylinesRef.current).forEach((p) => { try { p.remove(); } catch { /* ignore */ } });
    devicePolylinesRef.current = {};
    Object.values(deviceCirclesRef.current).forEach((c) => { try { c.remove(); } catch { /* ignore */ } });
    deviceCirclesRef.current = {};
  };

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!dualMode || !devices || !runtimes) {
      clearDeviceOverlays();
      return;
    }

    const activeUdids = new Set<string>();
    devices.slice(0, 2).forEach((dev, i) => {
      const rt: DeviceRuntime | undefined = runtimes[dev.udid];
      if (!rt) return;
      activeUdids.add(dev.udid);
      const color = DEVICE_COLORS[i];
      const letter = DEVICE_LETTERS[i];

      // Current position marker
      if (rt.currentPos) {
        const latlng: L.LatLngExpression = [rt.currentPos.lat, rt.currentPos.lng];
        const existing = deviceMarkersRef.current[dev.udid];
        if (existing) {
          (existing as any).setLatLng(latlng);
        } else {
          const icon = L.divIcon({
            className: 'current-pos-marker',
            html: `<div class="pos-pulse-ring" style="border-color:${color};"></div>
              <div class="pos-pulse-ring pos-pulse-ring-2" style="border-color:${color};"></div>
              <svg width="44" height="44" viewBox="0 0 44 44" class="pos-icon">
                <circle cx="22" cy="22" r="13" fill="${color}" opacity="0.95"/>
                <circle cx="22" cy="22" r="11" fill="none" stroke="#ffffff" stroke-width="2"/>
                <text x="22" y="26" text-anchor="middle" fill="#ffffff" font-size="13" font-weight="700" font-family="system-ui">${letter}</text>
              </svg>`,
            iconSize: [44, 44],
            iconAnchor: [22, 22],
          });
          const marker = L.marker(latlng, { icon, zIndexOffset: 1000 + i }).addTo(map);
          marker.bindTooltip(`${letter} · ${dev.name}`, { direction: 'top', offset: [0, -20] });
          deviceMarkersRef.current[dev.udid] = marker;
        }
      } else if (deviceMarkersRef.current[dev.udid]) {
        try { deviceMarkersRef.current[dev.udid].remove(); } catch { /* ignore */ }
        delete deviceMarkersRef.current[dev.udid];
      }

      // Route polyline
      const existingLine = devicePolylinesRef.current[dev.udid];
      if (existingLine) {
        try { existingLine.remove(); } catch { /* ignore */ }
        delete devicePolylinesRef.current[dev.udid];
      }
      if (rt.routePath && rt.routePath.length > 1) {
        const latlngs: L.LatLngExpression[] = rt.routePath.map((p) => [p.lat, p.lng]);
        const line = L.polyline(latlngs, { color, weight: 4, opacity: 0.85 }).addTo(map);
        devicePolylinesRef.current[dev.udid] = line;
      }

      // Random-walk radius circle
      const existingCircle = deviceCirclesRef.current[dev.udid];
      if (existingCircle) {
        try { existingCircle.remove(); } catch { /* ignore */ }
        delete deviceCirclesRef.current[dev.udid];
      }
      if (randomWalkRadius && randomWalkRadius > 0 && rt.currentPos) {
        const c = L.circle([rt.currentPos.lat, rt.currentPos.lng], {
          radius: randomWalkRadius,
          color, weight: 2, opacity: 0.7,
          fillColor: color, fillOpacity: 0.06,
          dashArray: '6, 6',
        }).addTo(map);
        deviceCirclesRef.current[dev.udid] = c;
      }
    });

    // Remove layers for devices no longer in the slice
    Object.keys(deviceMarkersRef.current).forEach((u) => {
      if (!activeUdids.has(u)) {
        try { deviceMarkersRef.current[u].remove(); } catch { /* ignore */ }
        delete deviceMarkersRef.current[u];
      }
    });
    Object.keys(devicePolylinesRef.current).forEach((u) => {
      if (!activeUdids.has(u)) {
        try { devicePolylinesRef.current[u].remove(); } catch { /* ignore */ }
        delete devicePolylinesRef.current[u];
      }
    });
    Object.keys(deviceCirclesRef.current).forEach((u) => {
      if (!activeUdids.has(u)) {
        try { deviceCirclesRef.current[u].remove(); } catch { /* ignore */ }
        delete deviceCirclesRef.current[u];
      }
    });

    // Destination markers: dedup when both destinations are within ~5m.
    Object.values(deviceDestMarkersRef.current).forEach((m) => { try { m.remove(); } catch { /* ignore */ } });
    deviceDestMarkersRef.current = {};
    if (deviceDestSharedRef.current) {
      try { deviceDestSharedRef.current.remove(); } catch { /* ignore */ }
      deviceDestSharedRef.current = null;
    }

    const dests: { dev: DeviceInfo; color: string; letter: string; dest: Position }[] = [];
    devices.slice(0, 2).forEach((dev, i) => {
      const rt = runtimes[dev.udid];
      if (rt && rt.destination) {
        dests.push({ dev, color: DEVICE_COLORS[i], letter: DEVICE_LETTERS[i], dest: rt.destination });
      }
    });

    const allSame = dests.length >= 2 && dests.slice(1).every((d) => haversineM(d.dest, dests[0].dest) <= 5);
    if (dests.length === 0) {
      // nothing to draw
    } else if (allSame) {
      const d = dests[0].dest;
      const redIcon = L.divIcon({
        className: 'dest-marker',
        html: `<svg width="36" height="50" viewBox="0 0 36 50">
          <ellipse cx="18" cy="47" rx="6" ry="2" fill="#000" opacity="0.2"/>
          <path d="M18 2C9.7 2 3 8.7 3 17c0 12 15 30 15 30s15-18 15-30C33 8.7 26.3 2 18 2z" fill="#e53935"/>
          <circle cx="18" cy="17" r="7" fill="#ffffff" opacity="0.95"/>
        </svg>`,
        iconSize: [36, 50],
        iconAnchor: [18, 47],
      });
      const m = L.marker([d.lat, d.lng], { icon: redIcon }).addTo(map);
      m.bindTooltip(t('map.destination'), { direction: 'top', offset: [0, -48] });
      deviceDestSharedRef.current = m;
    } else {
      dests.forEach(({ dev, color, letter, dest }) => {
        const icon = L.divIcon({
          className: 'dest-marker',
          html: `<svg width="36" height="50" viewBox="0 0 36 50">
            <ellipse cx="18" cy="47" rx="6" ry="2" fill="#000" opacity="0.2"/>
            <path d="M18 2C9.7 2 3 8.7 3 17c0 12 15 30 15 30s15-18 15-30C33 8.7 26.3 2 18 2z" fill="${color}"/>
            <circle cx="18" cy="17" r="7" fill="#ffffff" opacity="0.95"/>
            <text x="18" y="21" text-anchor="middle" fill="${color}" font-size="11" font-weight="700" font-family="system-ui">${letter}</text>
          </svg>`,
          iconSize: [36, 50],
          iconAnchor: [18, 47],
        });
        const m = L.marker([dest.lat, dest.lng], { icon }).addTo(map);
        m.bindTooltip(`${letter} · ${t('map.destination')}`, { direction: 'top', offset: [0, -48] });
        deviceDestMarkersRef.current[dev.udid] = m;
      });
    }
  }, [dualMode, devices, runtimes, randomWalkRadius, t]);

  // Close context menu on outside click
  useEffect(() => {
    const handler = () => closeContextMenu();
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [closeContextMenu]);

  // Close the waypoint mini-menu on any outside click. Same pattern as
  // closeContextMenu — clicking inside the menu calls stopPropagation
  // there so this fires only for clicks that miss the menu surface.
  useEffect(() => {
    const handler = () => closeWpMenu();
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [closeWpMenu]);

  const recenter = useCallback(() => {
    const map = mapRef.current;
    if (!map || !currentPosition) return;
    map.setView([currentPosition.lat, currentPosition.lng], Math.max(map.getZoom(), 16), {
      animate: true,
    });
  }, [currentPosition]);

  // Keep the DOM recenter button's handler + disabled state in sync with
  // React state without re-creating the button on every render.
  useEffect(() => {
    recenterHandlerRef.current = recenter;
    const btn = recenterBtnRef.current;
    if (!btn) return;
    btn.disabled = !currentPosition;
    btn.style.background = currentPosition ? 'var(--accent-blue)' : 'var(--bg-surface, #2a2f3a)';
    btn.style.cursor = currentPosition ? 'pointer' : 'not-allowed';
    btn.style.opacity = currentPosition ? '1' : '0.55';
  }, [recenter, currentPosition]);

  const toggleFollow = useCallback(() => {
    setFollowMode((prev) => !prev);
  }, []);

  // Keep the library-shortcut button ref in sync with the parent
  // callback. The button itself was mounted once in the map init
  // effect; this useEffect just rewires the target on each render.
  useEffect(() => {
    openLibraryHandlerRef.current = onOpenLibrary ?? (() => {});
  }, [onOpenLibrary]);

  // Sync the follow button's visual state + handler with React state. Active
  // (blue) when on, neutral surface when off. Title flips between on/off
  // labels so hover tooltip mirrors current state.
  useEffect(() => {
    followHandlerRef.current = toggleFollow;
    const btn = followBtnRef.current;
    if (!btn) return;
    btn.style.background = followMode ? 'var(--accent-blue)' : 'var(--bg-surface, #2a2f3a)';
    btn.style.cursor = 'pointer';
    btn.style.opacity = '1';
    btn.title = t(followMode ? 'map.follow_on' : 'map.follow_off');
    btn.setAttribute('aria-pressed', followMode ? 'true' : 'false');
  }, [toggleFollow, followMode, t]);

  // Auto-pan the map to the current position whenever follow mode is on.
  // Uses panTo with a short animation so rapid backend ticks (random walk
  // can be ~10 Hz) blend into a smooth camera trail rather than jumpy
  // snaps. Programmatic panTo does NOT fire dragstart, so the auto-disable
  // wired at map init is safe.
  useEffect(() => {
    if (!followMode || !currentPosition) return;
    const map = mapRef.current;
    if (!map) return;
    map.panTo([currentPosition.lat, currentPosition.lng], {
      animate: true,
      duration: 0.4,
    });
  }, [currentPosition, followMode]);

  // ── S2 cell grid overlay ────────────────────────────────────────────
  // Toggle handler is wired into the leaflet-bar button via a ref so the
  // once-mounted button always sees the latest setter.
  const toggleS2Grid = useCallback(() => {
    setS2Enabled((prev) => !prev);
  }, []);
  useEffect(() => {
    s2GridHandlerRef.current = toggleS2Grid;
    const btn = s2GridBtnRef.current;
    if (!btn) return;
    btn.style.background = s2Enabled ? 'var(--accent-blue)' : 'var(--bg-surface, #2a2f3a)';
    btn.title = t('map.s2_toggle');
    btn.setAttribute('aria-pressed', s2Enabled ? 'true' : 'false');
  }, [toggleS2Grid, s2Enabled, t]);

  // Track whether the grid was suppressed because the user is too far zoomed
  // out. The level picker uses this to tell them to zoom in instead of
  // silently showing nothing.
  const [s2Suppressed, setS2Suppressed] = useState(false);

  // Recompute + paint S2 polygons whenever the layer is toggled, the level
  // changes, or the user pans / zooms. Capped per zoom inside cellsInBounds
  // so wide zooms with high levels don't lock the UI.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const draw = () => {
      if (s2LayerRef.current) {
        try { s2LayerRef.current.remove(); } catch { /* ignore */ }
        s2LayerRef.current = null;
      }
      if (!s2Enabled) {
        setS2Suppressed(false);
        return;
      }
      // Suppress when the chosen level would render cells smaller than ~2 px:
      // the BFS safety cap clips at a center cluster and the grid then looks
      // like it 'wanders' with the cursor as you pan. Tell the user to zoom
      // in (or pick a coarser level) instead of silently rendering garbage.
      const zoom = map.getZoom();
      const lat = map.getCenter().lat;
      const cellMeters = approxCellSizeMeters(s2Level, lat);
      // Web Mercator: world circumference at the equator is 40075016m, mapped
      // to 256*2^zoom pixels. cos(lat) factor already baked into approxCellSizeMeters.
      const cellPx = cellMeters * (256 * Math.pow(2, zoom)) / 40075016;
      if (cellPx < 2) {
        setS2Suppressed(true);
        return;
      }
      setS2Suppressed(false);
      const bounds = map.getBounds();
      let cells: S2CellPolygon[];
      try {
        cells = cellsInBounds(bounds, s2Level);
      } catch {
        return;
      }
      if (!cells.length) return;
      const layer = L.layerGroup();
      // Solid colour, transparent fill — keeps the underlying map readable.
      // Slightly thinner stroke at high levels (more cells, would otherwise
      // blanket the screen).
      const weight = s2Level >= 18 ? 0.6 : s2Level >= 16 ? 0.8 : 1.1;
      for (const c of cells) {
        L.polygon(c.corners, {
          color: '#6c8cff',
          weight,
          opacity: 0.85,
          fill: true,
          fillColor: '#6c8cff',
          fillOpacity: 0.04,
          interactive: false,
          // Sit below markers so cell lines never block clicks on bookmark
          // pins / waypoint markers / context menu.
          pane: 'overlayPane',
        }).addTo(layer);
      }
      layer.addTo(map);
      s2LayerRef.current = layer;
    };
    draw();
    map.on('moveend', draw);
    map.on('zoomend', draw);
    return () => {
      map.off('moveend', draw);
      map.off('zoomend', draw);
      if (s2LayerRef.current) {
        try { s2LayerRef.current.remove(); } catch { /* ignore */ }
        s2LayerRef.current = null;
      }
    };
  }, [s2Enabled, s2Level]);

  // ── Mushroom map overlay (pipimushroom.com) ─────────────────────────
  const pipi = usePipiMushroomLayer({
    mapRef,
    enabled: pipiEnabled,
    kinds: pipiKinds,
    flowerFilter: pipiFlowerFilter,
    mushroomFilter: pipiMushroomFilter,
    markerSize: pipiMarkerSize,
    onTeleport,
    onNavigate,
    t,
  });
  const pipiConfiguredRef = useRef(pipi.configured);
  pipiConfiguredRef.current = pipi.configured;
  const pipiEnabledRef = useRef(pipiEnabled);
  pipiEnabledRef.current = pipiEnabled;
  const togglePipi = useCallback(() => {
    const next = !pipiEnabledRef.current;
    // Switching on without a login: open the panel so the user sees what
    // is missing instead of an empty map.
    if (next && pipiConfiguredRef.current === false) setPipiPanelOpen(true);
    setPipiEnabled(next);
  }, []);
  useEffect(() => {
    pipiHandlerRef.current = togglePipi;
    const btn = pipiBtnRef.current;
    if (!btn) return;
    btn.style.background = pipiEnabled ? '#f0932b' : 'var(--bg-surface, #2a2f3a)';
    btn.title = t('map.pipi_toggle');
    btn.setAttribute('aria-pressed', pipiEnabled ? 'true' : 'false');
  }, [togglePipi, pipiEnabled, t]);

  // Track the last avatar HTML we painted so the position-update effect
  // below can detect "avatar changed, need to rebuild marker even though
  // the position didn't change". Without this the new avatar only shows
  // up after the next teleport.
  const lastAvatarHtmlRef = useRef<string>('');


  // Coordinate-input overlay (replaces the sidebar's two-field coord input).
  // parseCoord scrapes the first valid lat/lng out of arbitrary pasted
  // text — bracket decoration, trailing notes ("一般火"), and label
  // prefixes are all discarded so users don't have to hand-clean copies
  // from Google Maps / chat / spreadsheets.
  const [coordInput, setCoordInput] = useState('');
  // Lifts the coord-input strip to clear the bottom status bar. The
  // status bar wraps to extra rows when the window narrows (flexWrap),
  // so its rendered height varies. We observe it directly so the strip
  // sits exactly 12px above whatever height it ends up.
  const [statusBarHeight, setStatusBarHeight] = useState<number>(38);
  useEffect(() => {
    const el = document.querySelector('.status-bar') as HTMLElement | null;
    if (!el) return;
    const update = () => setStatusBarHeight(Math.ceil(el.getBoundingClientRect().height));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);
  const submitCoordGo = (kind: 'teleport' | 'navigate' = 'teleport') => {
    const parsed = parseCoord(coordInput);
    if (!parsed) {
      if (onShowToast) onShowToast(tRef.current('panel.coord_invalid'));
      return;
    }
    if (kind === 'navigate') onNavigate(parsed.lat, parsed.lng, 'coord');
    else onTeleport(parsed.lat, parsed.lng, 'coord');
    setCoordInput('');
  };
  // Preview-only: pan the map view to the parsed coordinate without
  // touching the iPhone GPS. Lets the user "peek" at a coordinate before
  // deciding to teleport. Keeps the input populated so the next click
  // can promote it to a real teleport / navigate.
  const submitCoordPreview = () => {
    const parsed = parseCoord(coordInput);
    if (!parsed) {
      if (onShowToast) onShowToast(tRef.current('panel.coord_invalid'));
      return;
    }
    if (onCoordPreview) {
      // Parent owns the pan + preview-pin drop. We let it decide so the
      // pin and the camera move together for both this overlay and the
      // bookmark-list "fly camera only" path.
      onCoordPreview(parsed.lat, parsed.lng);
      return;
    }
    const m = mapRef.current;
    if (!m) return;
    const targetZoom = Math.max(m.getZoom(), 16);
    m.setView([parsed.lat, parsed.lng], targetZoom, { animate: true });
  };

  // When insert-after-waypoint mode is armed, swap the leaflet drag/grab
  // cursor to a crosshair so the user has a visual cue that the next
  // map click drops a new waypoint (and isn't a no-op or a teleport).
  // Scoped via inline <style> so it only affects THIS map instance —
  // a global stylesheet rule would bleed into any other Leaflet map.
  return (
    <div
      className={`map-container${insertAfterActive ? ' wp-insert-mode' : ''}`}
      style={{ position: 'relative', flex: 1 }}
    >
      {insertAfterActive && (
        <style>{`
          .map-container.wp-insert-mode .leaflet-container,
          .map-container.wp-insert-mode .leaflet-grab,
          .map-container.wp-insert-mode .leaflet-interactive {
            cursor: crosshair !important;
          }
        `}</style>
      )}
      <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />

      {/* Bottom-left stack: Bulk-paste (route/multi only) > Transport >
          Coord-input. Single flex column at bottom-left, fixed gap so the
          rows don't drift apart based on container height. Sits exactly
          above the bottom status bar — height tracked dynamically so a
          wrapped (multi-row) status bar doesn't overlap this strip when
          the window is narrow. */}
      <div
        style={{
          position: 'absolute',
          left: 12,
          bottom: statusBarHeight + 22,
          zIndex: 851,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 8,
          // The wrapper sits as a sibling of the Leaflet container (not a
          // child) so mousedown landing on its invisible bounding box —
          // the gap between rows, or the area to the right of a narrow
          // child like the lone Start button — never reaches Leaflet's
          // drag handler and the map appears un-draggable there (issue
          // #29). Make the wrapper transparent to pointer events and
          // re-enable on each actual button/input.
          pointerEvents: 'none',
        }}
      >
        {showBulkPasteOnMap && onBulkPasteOpen && (
          <button
            onClick={onBulkPasteOpen}
            onMouseDown={(e) => e.stopPropagation()}
            title={tRef.current('panel.route_paste_tooltip')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '7px 12px', height: 32, fontSize: 12,
              color: '#e8eaff', fontWeight: 600,
              background: 'var(--glass-float)',
              backdropFilter: 'var(--glass-blur)',
              WebkitBackdropFilter: 'var(--glass-blur)',
              border: '1px solid rgba(var(--accent-rgb), 0.32)',
              borderRadius: 10,
              boxShadow: '0 10px 26px rgba(8, 11, 22, 0.5)',
              cursor: 'pointer',
              pointerEvents: 'auto',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="2" width="6" height="4" rx="1"/>
              <path d="M9 4H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-3"/>
            </svg>
            {tRef.current('panel.route_paste_button')}
          </button>
        )}
        <TransportButtons
          isRunning={!!isRunning}
          isPaused={!!isPaused}
          onStart={onStart}
          onStop={onStop}
          onPause={onPause}
          onResume={onResume}
          t={tRef}
        />
        {/* Coord input strip — relative positioning inside the flex
            column so the gap above is purely controlled by the parent. */}
        <div
          onContextMenu={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="anim-fade-slide-up"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'var(--glass-float)',
            backdropFilter: 'var(--glass-blur)',
            WebkitBackdropFilter: 'var(--glass-blur)',
            borderRadius: 10,
            padding: '7px 9px',
            boxShadow: '0 10px 32px rgba(12, 18, 40, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
            border: '1px solid rgba(var(--accent-rgb), 0.15)',
            pointerEvents: 'auto',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="2" style={{ flexShrink: 0 }}>
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          <input
            type="text"
            value={coordInput}
            onChange={(e) => setCoordInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitCoordGo('teleport'); }}
            placeholder={isDefaultCoordSettings()
              ? tRef.current('panel.coord_placeholder')
              : coordBadge(tRef.current)}
            style={{
              width: 210, background: 'transparent', border: 'none',
              color: '#e8e8e8', fontSize: 12, outline: 'none',
              fontFamily: 'monospace',
            }}
          />
          <button
            onClick={async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (text) setCoordInput(text.trim());
              } catch {
                if (onShowToast) onShowToast(tRef.current('panel.paste_denied'));
              }
            }}
            title={tRef.current('panel.paste_tooltip')}
            style={{
              background: 'rgba(255,255,255,0.08)',
              color: '#c7d0e4', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 4, padding: '4px 8px', fontSize: 11, fontWeight: 600,
              cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
            </svg>
            {tRef.current('panel.paste')}
          </button>
          <button
            onClick={() => submitCoordGo('teleport')}
            disabled={!coordInput.trim() || !deviceConnected}
            title={t('map.teleport_here')}
            style={{
              background: !coordInput.trim() || !deviceConnected ? 'rgba(var(--accent-rgb),0.3)' : 'var(--accent-blue)',
              color: '#fff', border: 'none', borderRadius: 4,
              padding: '4px 10px', fontSize: 11, fontWeight: 600,
              cursor: !coordInput.trim() || !deviceConnected ? 'not-allowed' : 'pointer',
            }}
          >{tRef.current('panel.coord_teleport')}</button>
          <button
            onClick={submitCoordPreview}
            disabled={!coordInput.trim()}
            title={tRef.current('panel.coord_preview_tooltip')}
            style={{
              background: 'transparent',
              color: !coordInput.trim() ? 'rgba(199, 208, 228, 0.4)' : '#c7d0e4',
              border: `1px solid ${!coordInput.trim() ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.28)'}`,
              borderRadius: 4,
              padding: '4px 10px', fontSize: 11, fontWeight: 600,
              cursor: !coordInput.trim() ? 'not-allowed' : 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            {tRef.current('panel.coord_preview')}
          </button>
          <button
            onClick={() => submitCoordGo('navigate')}
            disabled={!coordInput.trim() || !deviceConnected}
            title={tRef.current('panel.coord_navigate_tooltip')}
            style={{
              background: 'transparent',
              color: !coordInput.trim() || !deviceConnected ? 'rgba(76, 175, 80, 0.4)' : '#4caf50',
              border: `1px solid ${!coordInput.trim() || !deviceConnected ? 'rgba(76, 175, 80, 0.3)' : 'rgba(76, 175, 80, 0.55)'}`,
              borderRadius: 4,
              padding: '4px 10px', fontSize: 11, fontWeight: 600,
              cursor: !coordInput.trim() || !deviceConnected ? 'not-allowed' : 'pointer',
            }}
          >{tRef.current('panel.coord_navigate')}</button>
        </div>
      </div>

      {/* The layer is on but the map is too far out to load anything: say it
          on the map itself, where the user is looking. */}
      {pipiEnabled && pipi.status.phase === 'zoom' && (
        <div className="lw-banner info pipi-zoom-banner">
          <span className="lw-banner-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" /><line x1="20" y1="20" x2="16.5" y2="16.5" />
              <line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </span>
          <span className="lw-banner-text">{t('map.pipi_zoom_banner', { zoom: PIPI_MIN_ZOOM, current: pipi.status.zoom })}</span>
        </div>
      )}

      {pipiPanelOpen && (
        <PipiMushroomPanel
          enabled={pipiEnabled}
          onEnabledChange={setPipiEnabled}
          kinds={pipiKinds}
          onKindsChange={setPipiKinds}
          flowerFilter={pipiFlowerFilter}
          onFlowerFilterChange={setPipiFlowerFilter}
          mushroomFilter={pipiMushroomFilter}
          onMushroomFilterChange={setPipiMushroomFilter}
          facets={pipi.facets}
          markerSize={pipiMarkerSize}
          onMarkerSizeChange={setPipiMarkerSize}
          status={pipi.status}
          configured={pipi.configured}
          cookieInfo={pipi.cookieInfo}
          onRefresh={pipi.refresh}
          onSaveCookie={pipi.saveCookie}
          onClearCookie={pipi.clearCookie}
          onClose={() => setPipiPanelOpen(false)}
          t={t}
        />
      )}

      {/* S2 cell grid level picker — opens via right-click on the S2 toggle
          button OR via the small chip beside the legend below. Snaps to
          discrete levels 8..22, default 17 (Niantic decor cell). */}
      {s2PickerOpen && (
        <div
          onContextMenu={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="anim-fade-slide-up"
          style={{
            position: 'absolute',
            left: 56, top: 196, zIndex: 851,
            background: 'var(--glass-pop)',
            backdropFilter: 'var(--glass-blur)',
            WebkitBackdropFilter: 'var(--glass-blur)',
            border: '1px solid rgba(var(--accent-rgb), 0.28)',
            borderRadius: 10,
            padding: '10px 12px',
            minWidth: 220,
            boxShadow: '0 12px 32px rgba(12, 18, 40, 0.55)',
            color: '#e8eaf0',
            fontSize: 12,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontWeight: 600 }}>{tRef.current('map.s2_level_label')}</span>
            <button
              onClick={() => setS2PickerOpen(false)}
              style={{ background: 'transparent', border: 'none', color: '#9499ac', cursor: 'pointer', fontSize: 14, padding: '0 4px' }}
              aria-label="close"
            >×</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <input
              type="range"
              min={8}
              max={22}
              step={1}
              value={s2Level}
              onChange={(e) => setS2Level(parseInt(e.target.value, 10))}
              style={{ flex: 1 }}
            />
            <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--accent-soft)', minWidth: 22, textAlign: 'right' }}>
              L{s2Level}
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#9499ac' }}>
            {(() => {
              const map = mapRef.current;
              const lat = map ? map.getCenter().lat : 0;
              const m = approxCellSizeMeters(s2Level, lat);
              const label = m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
              return tRef.current('map.s2_size_hint', { size: label });
            })()}
          </div>
          {s2Enabled && s2Suppressed && (
            <div style={{
              marginTop: 6, padding: '6px 8px',
              background: 'rgba(255,193,7,0.12)',
              border: '1px solid rgba(255,193,7,0.45)',
              borderRadius: 4,
              fontSize: 11, color: '#ffd54f', lineHeight: 1.4,
            }}>
              {tRef.current('map.s2_zoom_in_hint')}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {[13, 14, 15, 16, 17, 18, 19].map((lv) => (
              <button
                key={lv}
                onClick={() => setS2Level(lv)}
                style={{
                  background: s2Level === lv ? 'rgba(var(--accent-rgb),0.35)' : 'rgba(255,255,255,0.06)',
                  border: `1px solid ${s2Level === lv ? 'rgba(var(--accent-rgb),0.6)' : 'rgba(255,255,255,0.12)'}`,
                  color: s2Level === lv ? '#fff' : '#c7d0e4',
                  fontSize: 11, fontWeight: 600,
                  padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
                }}
              >L{lv}</button>
            ))}
          </div>
          <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button
              onClick={() => setS2Enabled((v) => !v)}
              style={{
                background: s2Enabled ? 'var(--accent-blue)' : 'transparent',
                border: `1px solid ${s2Enabled ? 'var(--accent-blue)' : 'rgba(255,255,255,0.18)'}`,
                color: s2Enabled ? '#fff' : '#c7d0e4',
                fontSize: 11, fontWeight: 600,
                padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
              }}
            >{s2Enabled ? tRef.current('map.s2_on') : tRef.current('map.s2_off')}</button>
            <span style={{ fontSize: 10, color: '#666c80' }}>{tRef.current('map.s2_picker_hint')}</span>
          </div>
        </div>
      )}

      {/* Recent destinations button + popover (topright, below tile layer
          switcher). Click the clock to toggle a list of the last 20
          places the user flew to; click an entry to re-fly using that
          entry's original action (teleport / navigate / search). */}
      {(recentPlaces && recentPlaces.length > 0) && (
        <div
          onContextMenu={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            right: 12,
            top: 125,
            zIndex: 851,
          }}
        >
          <button
            onClick={() => setRecentOpen((o) => !o)}
            onMouseEnter={(e) => {
              if (recentOpen) return;
              (e.currentTarget as HTMLButtonElement).style.background =
                'linear-gradient(135deg, rgba(var(--accent-rgb), 0.35) 0%, rgba(46, 52, 82, 0.95) 100%)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(var(--accent-rgb), 0.55)';
              (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-1px)';
              (e.currentTarget as HTMLButtonElement).style.boxShadow =
                '0 10px 24px rgba(var(--accent-rgb), 0.35), 0 2px 6px rgba(12, 18, 40, 0.45)';
            }}
            onMouseLeave={(e) => {
              if (recentOpen) return;
              (e.currentTarget as HTMLButtonElement).style.background =
                'linear-gradient(135deg, rgba(38, 42, 58, 0.92) 0%, rgba(22, 25, 36, 0.92) 100%)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(var(--accent-rgb), 0.22)';
              (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)';
              (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 6px 18px rgba(12, 18, 40, 0.45)';
            }}
            title={tRef.current('map.recent_tooltip')}
            style={{
              position: 'relative',
              width: 42, height: 42,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: recentOpen
                ? 'linear-gradient(135deg, var(--accent-blue) 0%, var(--accent-deep) 100%)'
                : 'linear-gradient(135deg, rgba(38, 42, 58, 0.92) 0%, rgba(22, 25, 36, 0.92) 100%)',
              color: '#fff',
              border: `1px solid ${recentOpen ? 'rgba(var(--accent-rgb), 0.85)' : 'rgba(var(--accent-rgb), 0.22)'}`,
              borderRadius: 10,
              cursor: 'pointer',
              boxShadow: recentOpen
                ? '0 10px 28px rgba(var(--accent-rgb), 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.15)'
                : '0 6px 18px rgba(12, 18, 40, 0.45)',
              backdropFilter: 'var(--glass-blur)',
              WebkitBackdropFilter: 'var(--glass-blur)',
              transition: 'transform 120ms ease-out, background 120ms ease-out, border-color 120ms ease-out, box-shadow 120ms ease-out',
            }}
          >
            {/* Lucide "History": counterclockwise arrow around a clock
                face. Reads as "past / rewind / history" much more
                clearly than a plain clock icon. */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M12 7v5l4 2" />
            </svg>
            {/* Count badge: little pill in the corner showing how many
                entries are recorded, so the user can glance at the map
                and know there's something in history without opening. */}
            {recentPlaces.length > 0 && !recentOpen && (
              <span style={{
                position: 'absolute',
                top: -5, right: -5,
                minWidth: 16, height: 16,
                padding: '0 4px',
                borderRadius: 99,
                background: '#f48fb1',
                color: '#23283a',
                fontSize: 10, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 2px 6px rgba(244, 143, 177, 0.5)',
                border: '1.5px solid rgba(22, 25, 36, 0.92)',
                fontFamily: 'system-ui, sans-serif',
                lineHeight: 1,
              }}>{recentPlaces.length}</span>
            )}
          </button>

          {recentOpen && (
            <div
              // No animation class here: the CSS animation-fill-mode:both
              // on .anim-fade-slide-up pins transform at translateY(0)
              // and wins against any inline transform we apply via drag.
              style={{
                position: 'absolute',
                right: 0,
                top: 48,
                width: 320,
                maxHeight: '62vh',
                display: 'flex', flexDirection: 'column',
                background: 'var(--glass-pop)',
                backdropFilter: 'var(--glass-blur)',
                WebkitBackdropFilter: 'var(--glass-blur)',
                border: '1px solid rgba(var(--accent-rgb), 0.22)',
                borderRadius: 12,
                boxShadow: '0 18px 48px rgba(12, 18, 40, 0.65)',
                overflow: 'hidden',
                transform: `translate(${recentDragOffset.x}px, ${recentDragOffset.y}px)`,
              }}
            >
              <div
                onMouseDown={beginRecentDrag}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                  fontSize: 12, fontWeight: 600, color: '#e8eaf0',
                  cursor: 'move',
                  userSelect: 'none',
                }}
              >
                <span>{tRef.current('map.recent_title')}</span>
                {onRecentClear && recentPlaces.length > 0 && (
                  !clearConfirming ? (
                    <button
                      onClick={() => setClearConfirming(true)}
                      style={{
                        background: 'transparent', border: '1px solid transparent',
                        color: '#9499ac', fontSize: 11, cursor: 'pointer',
                        padding: '2px 8px', borderRadius: 4,
                        transition: 'background 120ms ease, color 120ms ease',
                      }}
                      title={tRef.current('map.recent_clear_tooltip')}
                    >{tRef.current('map.recent_clear')}</button>
                  ) : (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => {
                          onRecentClear();
                          setClearConfirming(false);
                          setRecentOpen(false);
                        }}
                        style={{
                          background: 'rgba(229, 57, 53, 0.18)',
                          border: '1px solid rgba(229, 57, 53, 0.55)',
                          color: '#ff7a6d', fontSize: 11, fontWeight: 700,
                          cursor: 'pointer',
                          padding: '2px 8px', borderRadius: 4,
                        }}
                      >{tRef.current('map.recent_clear_confirm')}</button>
                      <button
                        onClick={() => setClearConfirming(false)}
                        style={{
                          background: 'transparent',
                          border: '1px solid rgba(255, 255, 255, 0.15)',
                          color: '#9499ac', fontSize: 11,
                          cursor: 'pointer',
                          padding: '2px 8px', borderRadius: 4,
                        }}
                      >{tRef.current('generic.cancel')}</button>
                    </div>
                  )
                )}
              </div>
              <div style={{ overflowY: 'auto', flex: 1 }}>
                {recentPlaces.map((entry, idx) => {
                  // Text badge + colour per kind. Coord-input entries
                  // share a single "座標" label regardless of the
                  // teleport / navigate sub-action, since the entry
                  // point is what the user remembers.
                  type BadgeSpec = { label: string; color: string; bg: string };
                  const badgeByKind: Record<string, BadgeSpec> = {
                    teleport:        { label: tRef.current('recent.kind_teleport'),   color: 'var(--accent-blue)', bg: 'rgba(var(--accent-rgb), 0.16)' },
                    navigate:        { label: tRef.current('recent.kind_navigate'),   color: '#4caf50', bg: 'rgba(76, 175, 80, 0.16)' },
                    search:          { label: tRef.current('recent.kind_search'),     color: '#f48fb1', bg: 'rgba(244, 143, 177, 0.16)' },
                    coord_teleport:  { label: tRef.current('recent.kind_coord'),      color: '#ffb74d', bg: 'rgba(255, 183, 77, 0.16)' },
                    coord_navigate:  { label: tRef.current('recent.kind_coord'),      color: '#ffb74d', bg: 'rgba(255, 183, 77, 0.16)' },
                  };
                  const badge = badgeByKind[entry.kind] ?? { label: entry.kind, color: '#9499ac', bg: 'rgba(148, 153, 172, 0.16)' };
                  const now = Math.floor(Date.now() / 1000);
                  const ago = now - (entry.ts || 0);
                  let agoLabel = '';
                  if (ago < 60) agoLabel = tRef.current('time.just_now');
                  else if (ago < 3600) agoLabel = `${Math.floor(ago / 60)} ${tRef.current('time.minutes_ago')}`;
                  else if (ago < 86400) agoLabel = `${Math.floor(ago / 3600)} ${tRef.current('time.hours_ago')}`;
                  else if (ago < 86400 * 7) agoLabel = `${Math.floor(ago / 86400)} ${tRef.current('time.days_ago')}`;
                  else {
                    const d = new Date(entry.ts * 1000);
                    agoLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                  }
                  const display = entry.name && entry.name.length > 0
                    ? entry.name
                    : formatCoord(entry.lat, entry.lng, 5);
                  return (
                    <button
                      key={`${entry.ts}-${idx}`}
                      onClick={() => {
                        if (onRecentReFly) onRecentReFly(entry);
                        setRecentOpen(false);
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        width: '100%',
                        padding: '9px 12px',
                        background: 'transparent', border: 'none',
                        borderBottom: idx < recentPlaces.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                        color: '#e8eaf0', textAlign: 'left',
                        cursor: 'pointer', transition: 'background 0.12s',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                    >
                      <span style={{
                        flexShrink: 0,
                        fontSize: 10, fontWeight: 700,
                        letterSpacing: '0.05em',
                        color: badge.color,
                        background: badge.bg,
                        border: `1px solid ${badge.color}33`,
                        borderRadius: 4,
                        padding: '3px 6px',
                        minWidth: 34,
                        textAlign: 'center',
                      }}>{badge.label}</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{
                          fontSize: 13, fontWeight: 500,
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>{display}</div>
                        <div style={{
                          fontSize: 10, opacity: 0.55, fontFamily: 'monospace', marginTop: 2,
                        }}>
                          {formatCoord(entry.lat, entry.lng, 5)} · {agoLabel}
                        </div>
                      </div>
                    </button>
                  );
                })}
                {recentPlaces.length === 0 && (
                  <div style={{ padding: 16, fontSize: 12, opacity: 0.6, textAlign: 'center' }}>
                    {tRef.current('map.recent_empty')}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {contextMenu.visible && (
        <div
          ref={contextMenuElRef}
          className="context-menu anim-scale-in-tl"
          style={{
            position: 'fixed',
            // First paint renders at the click point but invisible; the
            // layout-effect below measures the actual rendered size and
            // clamps left/top into the viewport, then flips visibility on.
            // Because the layout effect runs synchronously before the
            // browser paints, the user never sees the unclamped position.
            left: contextMenuPos ? contextMenuPos.left : contextMenu.x,
            top: contextMenuPos ? contextMenuPos.top : contextMenu.y,
            visibility: contextMenuPos ? 'visible' : 'hidden',
            zIndex: 1000,
            background: 'var(--glass-pop)',
            backdropFilter: 'var(--glass-blur)',
            WebkitBackdropFilter: 'var(--glass-blur)',
            border: '1px solid rgba(var(--accent-rgb), 0.18)',
            borderRadius: 10,
            padding: '4px 0',
            boxShadow: '0 10px 32px rgba(12, 18, 40, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.04) inset',
            minWidth: 180,
            maxWidth: 'calc(100vw - 16px)',
            maxHeight: 'calc(100vh - 16px)',
            overflow: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 1. Coordinates label — always visible at the top of the menu.
                Not clickable; shows the exact lat/lng of the right-click
                target directly instead of making the user click through. */}
          <div
            className="context-menu-item"
            style={{
              padding: '8px 16px 6px',
              color: 'var(--accent-soft)',
              fontSize: 12,
              fontFamily: 'monospace',
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
              gap: 4,
            }}
            title={t('map.whats_here_tooltip')}
            onMouseEnter={highlightItem}
            onMouseLeave={unhighlightItem}
            onClick={async (e) => {
              e.stopPropagation();
              const key = `${contextMenu.lat.toFixed(6)}|${contextMenu.lng.toFixed(6)}`;
              if (reverseGeo.loading && reverseGeo.key === key) return;
              if (reverseGeo.address && reverseGeo.key === key) return;
              setReverseGeo({ loading: true, address: null, error: null, key });
              try {
                const res = await reverseGeocode(contextMenu.lat, contextMenu.lng, true);
                const name = res?.display_name || res?.address || null;
                if (name) {
                  setReverseGeo({ loading: false, address: name, error: null, key });
                } else {
                  setReverseGeo({ loading: false, address: null, error: t('map.whats_here_empty'), key });
                }
              } catch (err: any) {
                setReverseGeo({ loading: false, address: null, error: err?.message || 'error', key });
              }
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 4, opacity: 0.8 }}>
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
            <span style={{ flex: 1 }}>{formatCoord(contextMenu.lat, contextMenu.lng, 6)}</span>
            <span style={{ fontSize: 10, opacity: 0.7, fontFamily: 'inherit' }}>
              {reverseGeo.loading && reverseGeo.key === `${contextMenu.lat.toFixed(6)}|${contextMenu.lng.toFixed(6)}`
                ? t('map.whats_here_loading')
                : t('map.whats_here')}
            </span>
          </div>
          {/* Reverse-geocode result or error, shown only after the user taps
              the header row. Wraps + selectable so the user can copy the
              address. Max width is clipped by .context-menu parent. */}
          {reverseGeo.key === `${contextMenu.lat.toFixed(6)}|${contextMenu.lng.toFixed(6)}` &&
           (reverseGeo.address || reverseGeo.error) && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                padding: '2px 16px 8px',
                color: reverseGeo.error ? '#ff8a80' : '#d0d0d0',
                fontSize: 11.5,
                lineHeight: 1.5,
                userSelect: 'text',
                cursor: 'text',
                wordBreak: 'break-word',
              }}
            >
              {reverseGeo.address ?? reverseGeo.error}
            </div>
          )}
          <div style={{ height: 1, background: '#444', margin: '2px 0 4px' }} />

          {/* 2 + 3. Teleport / Navigate (device-gated). */}
          {deviceConnected ? (
            <>
              <div
                className="context-menu-item"
                style={contextMenuItemStyle}
                onMouseEnter={highlightItem}
                onMouseLeave={unhighlightItem}
                onClick={() => {
                  onTeleport(contextMenu.lat, contextMenu.lng);
                  closeContextMenu();
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="2" x2="12" y2="6" />
                  <line x1="12" y1="18" x2="12" y2="22" />
                  <line x1="2" y1="12" x2="6" y2="12" />
                  <line x1="18" y1="12" x2="22" y2="12" />
                </svg>
                {t('map.teleport_here')}
              </div>
              <div
                className="context-menu-item"
                style={contextMenuItemStyle}
                onMouseEnter={highlightItem}
                onMouseLeave={unhighlightItem}
                onClick={() => {
                  onNavigate(contextMenu.lat, contextMenu.lng);
                  closeContextMenu();
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
                  <polygon points="3,11 22,2 13,21 11,13" />
                </svg>
                {t('map.navigate_here')}
              </div>
            </>
          ) : (
            <div
              style={{ ...contextMenuItemStyle, color: '#ff6b6b', cursor: 'not-allowed', opacity: 0.75 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
                <circle cx="12" cy="12" r="10" />
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
              {t('map.device_disconnected')}
            </div>
          )}

          {/* 4. Copy coordinates to clipboard. */}
          <div
            className="context-menu-item"
            style={contextMenuItemStyle}
            onMouseEnter={highlightItem}
            onMouseLeave={unhighlightItem}
            onClick={async () => {
              const txt = formatCoord(contextMenu.lat, contextMenu.lng, 6);
              try {
                await navigator.clipboard.writeText(txt);
              } catch {
                const ta = document.createElement('textarea');
                ta.value = txt;
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); } catch { /* ignore */ }
                document.body.removeChild(ta);
              }
              if (onShowToast) onShowToast(tRef.current('map.coords_copied'));
              closeContextMenu();
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
            {t('map.copy_coords')}
          </div>

          {/* 5. Add to bookmarks. */}
          <div
            className="context-menu-item"
            style={contextMenuItemStyle}
            onMouseEnter={highlightItem}
            onMouseLeave={unhighlightItem}
            onClick={() => {
              onAddBookmark(contextMenu.lat, contextMenu.lng);
              closeContextMenu();
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
              <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
            </svg>
            {t('map.add_bookmark')}
          </div>

          {/* 6. Add waypoint (only when in a route mode). */}
          {showWaypointOption && onAddWaypoint && (
            <>
              <div style={{ height: 1, background: '#444', margin: '4px 0' }} />
              <div
                className="context-menu-item"
                style={contextMenuItemStyle}
                onMouseEnter={highlightItem}
                onMouseLeave={unhighlightItem}
                onClick={() => {
                  onAddWaypoint(contextMenu.lat, contextMenu.lng);
                  closeContextMenu();
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
                  <circle cx="12" cy="12" r="3" />
                  <line x1="12" y1="5" x2="12" y2="1" />
                  <line x1="12" y1="23" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="1" y2="12" />
                  <line x1="23" y1="12" x2="19" y2="12" />
                </svg>
                {t('map.add_waypoint')}
              </div>
            </>
          )}

        </div>
      )}

      {wpMenu.visible && (
        <div
          className="context-menu anim-scale-in-tl"
          style={{
            position: 'fixed',
            // Offset slightly so the cursor lands inside the menu rather
            // than on its edge (otherwise the document-level click handler
            // might immediately close it).
            left: Math.max(8, Math.min(wpMenu.x + 6, window.innerWidth - 188)),
            top: Math.max(8, Math.min(wpMenu.y + 6, window.innerHeight - 100)),
            zIndex: 1000,
            background: 'var(--glass-pop)',
            backdropFilter: 'var(--glass-blur)',
            WebkitBackdropFilter: 'var(--glass-blur)',
            border: '1px solid rgba(var(--accent-rgb), 0.18)',
            borderRadius: 10,
            padding: '4px 0',
            boxShadow: '0 10px 32px rgba(12, 18, 40, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.04) inset',
            minWidth: 180,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              padding: '6px 14px 4px',
              fontSize: 11,
              opacity: 0.55,
              fontFamily: 'monospace',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
              marginBottom: 2,
            }}
          >
            {wpMenu.isStart ? tRef.current('panel.waypoint_start') : `#${wpMenu.index}`}
          </div>
          {!wpMenu.isStart && onSetWpAsStartRef.current && (
            <div
              style={contextMenuItemStyle}
              onMouseEnter={highlightItem}
              onMouseLeave={unhighlightItem}
              onClick={() => {
                const fn = onSetWpAsStartRef.current;
                const idx = wpMenu.index;
                closeWpMenu();
                fn?.(idx);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#43a047" strokeWidth="2" style={{ marginRight: 8 }}>
                <line x1="4" y1="22" x2="4" y2="3" />
                <path d="M4 4h12l-2 4 2 4H4" fill="#43a04733" />
              </svg>
              {t('map.wp_set_as_start')}
            </div>
          )}
          {onInsertAfterWpRef.current && (
            <div
              style={contextMenuItemStyle}
              onMouseEnter={highlightItem}
              onMouseLeave={unhighlightItem}
              onClick={() => {
                const fn = onInsertAfterWpRef.current;
                const idx = wpMenu.index;
                closeWpMenu();
                fn?.(idx);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="2" style={{ marginRight: 8 }}>
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {t('map.wp_insert_after')}
            </div>
          )}
          {onRemoveWaypointRef.current && (
            <div
              style={{ ...contextMenuItemStyle, color: '#ff6b6b' }}
              onMouseEnter={highlightItem}
              onMouseLeave={unhighlightItem}
              onClick={() => {
                const fn = onRemoveWaypointRef.current;
                const idx = wpMenu.index;
                closeWpMenu();
                fn?.(idx);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
              </svg>
              {t('map.wp_delete')}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const contextMenuItemStyle: React.CSSProperties = {
  padding: '8px 16px',
  cursor: 'pointer',
  color: '#e0e0e0',
  fontSize: 13,
  display: 'flex',
  alignItems: 'center',
  transition: 'background 0.15s',
};

function highlightItem(e: React.MouseEvent<HTMLDivElement>) {
  (e.currentTarget as HTMLDivElement).style.background = '#3a3a3e';
}

function unhighlightItem(e: React.MouseEvent<HTMLDivElement>) {
  (e.currentTarget as HTMLDivElement).style.background = 'transparent';
}

export default MapView;
