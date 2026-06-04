import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import RouteEngineSelector from './RouteEngineSelector';

// Apply-speed button that disables itself for ~1.5 s after a click so a
// frantic double-tap doesn't fire two consecutive hot-swaps (which used to
// be able to wedge the route planner into walking back to the leg start).
const ApplySpeedButton: React.FC<{ onApply: () => Promise<void> | void; t: (k: any) => string }> = ({ onApply, t }) => {
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <button
        className="action-btn primary"
        style={{ width: '100%', padding: '6px 10px', fontSize: 12, opacity: busy ? 0.6 : 1 }}
        disabled={busy}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          try { await onApply(); } finally { setTimeout(() => setBusy(false), 1500); }
        }}
        title={t('panel.apply_speed_tooltip')}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6, verticalAlign: 'middle' }}>
          <polyline points="20 6 9 17 4 12" />
        </svg>
        {t('panel.apply_speed')}
      </button>
    </div>
  );
};
import PauseControl from './PauseControl';
import { SimMode, MoveMode } from '../hooks/useSimulation';
import AddressSearch from './AddressSearch';
import BookmarkList from './BookmarkList';
import RouteList, { RouteCategory, SavedRoute } from './RouteList';

interface Position {
  lat: number;
  lng: number;
}

interface Bookmark {
  id?: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
}

interface ControlPanelProps {
  simMode: SimMode;
  moveMode: MoveMode;
  speed: number;
  isRunning: boolean;
  isPaused: boolean;
  currentPosition: Position | null;
  onModeChange: (mode: SimMode) => void;
  onSpeedChange: (speed: number) => void;
  onMoveModeChange: (mode: MoveMode) => void;
  customSpeedKmh: number | null;
  onCustomSpeedChange: (speed: number | null) => void;
  speedMinKmh: number | null;
  onSpeedMinChange: (v: number | null) => void;
  speedMaxKmh: number | null;
  onSpeedMaxChange: (v: number | null) => void;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onRestore: () => void;
  onApplySpeed?: () => Promise<void> | void;
  waypointProgress?: { current: number; next: number; total: number } | null;
  onTeleport: (lat: number, lng: number) => void;
  onNavigate: (lat: number, lng: number) => void;
  // Address-search fires this instead of onTeleport so the recent-places
  // history can distinguish "I searched for this" from "I right-click
  // teleported". The action is still a teleport; only the tagging
  // changes.
  onAddressSelect?: (lat: number, lng: number, name: string) => void;
  bookmarks: Bookmark[];
  bookmarkCategories: string[];
  bookmarkCategoryColors?: Record<string, string>;
  onBookmarkClick: (bm: Bookmark) => void;
  // Camera-only fly: pans the map to the bookmark coordinate without
  // moving the iPhone GPS. BookmarkList exposes a checkbox letting the
  // user choose between this and the legacy GPS teleport.
  onBookmarkPreview?: (bm: Bookmark) => void;
  onBookmarkAdd: (bm: Bookmark) => void;
  onBookmarkDelete: (id: string) => void;
  onBookmarkEdit: (id: string, bm: Partial<Bookmark>) => void;
  onCategoryAdd: (name: string) => void;
  onCategoryDelete: (name: string) => void;
  onCategoryRename?: (oldName: string, newName: string) => void;
  onCategoryRecolor?: (name: string, color: string) => void;
  onCategoryReorder?: (orderedNames: string[]) => void;
  onBookmarkReorder?: (categoryName: string, orderedIds: string[]) => void;
  bookmarkShowOnMap?: boolean;
  onBookmarkShowOnMapChange?: (v: boolean) => void;
  onBookmarkImport?: (file: File) => Promise<void>;
  onBookmarkBulkPaste?: () => void;
  bookmarkExportUrl?: string;
  savedRoutes: SavedRoute[];
  routeCategories: RouteCategory[];
  onRouteLoad: (id: string) => void;
  onRouteSave: (name: string, opts?: { categoryId?: string; overwriteId?: string }) => void;
  onRouteRename?: (id: string, name: string) => void;
  onRouteDelete?: (id: string) => void;
  onRoutesBulkDelete?: (ids: string[]) => Promise<void> | void;
  onRouteMove?: (ids: string[], targetCategoryId: string) => Promise<void> | void;
  onRouteGpxImport?: (file: File) => Promise<void>;
  onRouteGpxExport?: (id: string) => void;
  onRoutesImportAll?: (file: File) => Promise<void>;
  routesExportAllUrl?: string;
  onRouteCategoryAdd?: (name: string, color?: string) => Promise<void> | void;
  onRouteCategoryDelete?: (id: string) => Promise<void> | void;
  onRouteCategoryRename?: (id: string, name: string) => Promise<void> | void;
  onRouteCategoryRecolor?: (id: string, color: string) => Promise<void> | void;
  onRouteCategoryReorder?: (orderedIds: string[]) => Promise<void> | void;
  onRouteReorder?: (categoryId: string, orderedRouteIds: string[]) => Promise<void> | void;
  randomWalkRadius: number;
  pauseRandomWalk?: { enabled: boolean; min: number; max: number };
  onPauseRandomWalkChange?: (v: { enabled: boolean; min: number; max: number }) => void;
  onRandomWalkRadiusChange: (radius: number) => void;
  randomWalkCenterMode?: 'fixed' | 'follow';
  onRandomWalkCenterModeChange?: (v: 'fixed' | 'follow') => void;
  forwardWalk?: { enabled: boolean; turnDeg: number };
  onForwardWalkChange?: (v: { enabled: boolean; turnDeg: number }) => void;
  goldDittoA?: string;
  onGoldDittoAChange?: (v: string) => void;
  onGoldDittoStart?: () => void;
  goldDittoBusy?: boolean;
  modeExtraSection?: React.ReactNode;
  currentWaypointsCount?: number;
  loadedRouteName?: string | null;
  straightLine?: boolean;
  onStraightLineChange?: (v: boolean) => void;
  keepWaypoints?: boolean;
  onKeepWaypointsChange?: (v: boolean) => void;
  routeEngine?: 'osrm' | 'osrm_fossgis' | 'valhalla' | 'brouter';
  onRouteEngineChange?: (v: 'osrm' | 'osrm_fossgis' | 'valhalla' | 'brouter') => void;
  clickToAddWaypoint?: boolean;
  onClickToAddWaypointChange?: (v: boolean) => void;
  // Jump mode: when toggled on for Loop / MultiStop, the device teleports
  // point-to-point with configurable pre / post delays around each
  // teleport, instead of walking the routed path.
  jumpMode?: boolean;
  onJumpModeChange?: (v: boolean) => void;
  jumpPreDelay?: number;
  onJumpPreDelayChange?: (v: number) => void;
  jumpPostDelay?: number;
  onJumpPostDelayChange?: (v: number) => void;
  // Incremented by any external source (e.g. map top-left library
  // button) to request the library panel be opened. useEffect on the
  // value toggles libraryOpen=true so the parent doesn't have to own
  // the open state.
  openLibraryToken?: number;
  // Which tab to show when opening via the token. Defaults to 'bookmarks'.
  openLibraryTab?: 'bookmarks' | 'routes';
}

interface SectionState {
  mode: boolean;
  speed: boolean;
  coords: boolean;
  search: boolean;
  bookmarks: boolean;
  routes: boolean;
}

const modeIcons: Record<SimMode, JSX.Element> = {
  [SimMode.Teleport]: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="2" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="2" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="22" y2="12" />
    </svg>
  ),
  [SimMode.Navigate]: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="3,11 22,2 13,21 11,13" />
    </svg>
  ),
  [SimMode.Loop]: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="17,1 21,5 17,9" />
      <path d="M3 11V9a4 4 0 014-4h14" />
      <polyline points="7,23 3,19 7,15" />
      <path d="M21 13v2a4 4 0 01-4 4H3" />
    </svg>
  ),
  [SimMode.MultiStop]: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="18" r="3" />
      <line x1="9" y1="6" x2="15" y2="6" />
      <line x1="6" y1="9" x2="6" y2="15" />
      <line x1="18" y1="9" x2="18" y2="15" />
    </svg>
  ),
  [SimMode.RandomWalk]: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12c2-3 4-1 6-4s2-5 4-2 3 4 5 1 3-4 5-1" />
    </svg>
  ),
  [SimMode.Joystick]: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
    </svg>
  ),
  [SimMode.GoldDitto]: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="6" r="2.5" />
      <circle cx="6.5" cy="11" r="2.5" />
      <circle cx="17.5" cy="11" r="2.5" />
      <circle cx="9" cy="17" r="2.5" />
      <circle cx="15" cy="17" r="2.5" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  ),
};

import type { StringKey } from '../i18n';
const modeLabelKeys: Record<SimMode, StringKey> = {
  [SimMode.Teleport]: 'mode.teleport',
  [SimMode.Navigate]: 'mode.navigate',
  [SimMode.Loop]: 'mode.loop',
  [SimMode.MultiStop]: 'mode.multi_stop',
  [SimMode.RandomWalk]: 'mode.random_walk',
  [SimMode.Joystick]: 'mode.joystick',
  [SimMode.GoldDitto]: 'mode.goldditto',
};

const ControlPanel: React.FC<ControlPanelProps> = ({
  simMode,
  moveMode,
  speed,
  isRunning,
  isPaused,
  currentPosition,
  onModeChange,
  onSpeedChange,
  onMoveModeChange,
  customSpeedKmh,
  onCustomSpeedChange,
  speedMinKmh,
  onSpeedMinChange,
  speedMaxKmh,
  onSpeedMaxChange,
  onStart,
  onStop,
  onPause,
  onResume,
  onRestore,
  onApplySpeed,
  waypointProgress,
  onTeleport,
  onNavigate,
  onAddressSelect,
  bookmarks,
  bookmarkCategories,
  bookmarkCategoryColors,
  onBookmarkClick,
  onBookmarkPreview,
  onBookmarkAdd,
  onBookmarkDelete,
  onBookmarkEdit,
  onCategoryAdd,
  onCategoryDelete,
  onCategoryRename,
  onCategoryRecolor,
  onCategoryReorder,
  onBookmarkReorder,
  bookmarkShowOnMap,
  onBookmarkShowOnMapChange,
  onBookmarkImport,
  onBookmarkBulkPaste,
  bookmarkExportUrl,
  savedRoutes,
  routeCategories,
  onRouteLoad,
  onRouteSave,
  onRouteRename,
  onRouteDelete,
  onRoutesBulkDelete,
  onRouteMove,
  onRouteGpxImport,
  onRouteGpxExport,
  onRoutesImportAll,
  routesExportAllUrl,
  onRouteCategoryAdd,
  onRouteCategoryDelete,
  onRouteCategoryRename,
  onRouteCategoryRecolor,
  onRouteCategoryReorder,
  onRouteReorder,
  randomWalkRadius,
  pauseRandomWalk,
  onPauseRandomWalkChange,
  onRandomWalkRadiusChange,
  randomWalkCenterMode = 'fixed',
  onRandomWalkCenterModeChange,
  forwardWalk = { enabled: false, turnDeg: 35 },
  onForwardWalkChange,
  goldDittoA = '',
  onGoldDittoAChange,
  onGoldDittoStart,
  goldDittoBusy = false,
  modeExtraSection,
  currentWaypointsCount = 0,
  loadedRouteName = null,
  straightLine = false,
  onStraightLineChange,
  keepWaypoints = false,
  onKeepWaypointsChange,
  routeEngine = 'osrm',
  onRouteEngineChange,
  clickToAddWaypoint = false,
  onClickToAddWaypointChange,
  jumpMode = false,
  onJumpModeChange,
  jumpPreDelay = 2,
  onJumpPreDelayChange,
  jumpPostDelay = 4,
  onJumpPostDelayChange,
  openLibraryToken,
  openLibraryTab,
}) => {
  const [sections, setSections] = useState<SectionState>({
    mode: true,
    speed: true,
    coords: true,
    search: true,
    bookmarks: true,
    routes: true,
  });

  const t = useT();
  const [coordLat, setCoordLat] = useState('');
  const [coordLng, setCoordLng] = useState('');
  const [goldDittoAHidden, setGoldDittoAHidden] = useState<boolean>(() => {
    try { return localStorage.getItem('locwarp.goldditto.a_hidden') === '1' } catch { return false }
  });
  useEffect(() => {
    try { localStorage.setItem('locwarp.goldditto.a_hidden', goldDittoAHidden ? '1' : '0') } catch { /* ignore */ }
  }, [goldDittoAHidden]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryTab, setLibraryTab] = useState<'bookmarks' | 'routes'>('bookmarks');

  // Toggle the library panel whenever `openLibraryToken` changes. Used
  // by the map top-left library button in MapView, which just
  // increments a counter in App.tsx. We TOGGLE (not always-open) so a
  // second click on the star closes the panel. Guard with !token to
  // skip the initial mount (token starts at 0) — without that, the
  // panel would flash open on app launch.
  useEffect(() => {
    if (!openLibraryToken) return;
    setLibraryOpen((prev) => !prev);
    if (openLibraryTab) setLibraryTab(openLibraryTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openLibraryToken]);
  const [libraryPos, setLibraryPos] = useState<{ x: number; y: number }>(() => ({
    x: Math.max(20, window.innerWidth - 440),
    y: 70,
  }));
  const dragRef = React.useRef<{ dx: number; dy: number } | null>(null);

  const startDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button,input,select,textarea')) return;
    dragRef.current = { dx: e.clientX - libraryPos.x, dy: e.clientY - libraryPos.y };
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const x = Math.min(Math.max(0, ev.clientX - dragRef.current.dx), window.innerWidth - 100);
      const y = Math.min(Math.max(0, ev.clientY - dragRef.current.dy), window.innerHeight - 40);
      setLibraryPos({ x, y });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Keep the floating library window inside the viewport. Its position is
  // remembered across opens, so without this a window that was dragged to
  // the right edge (or opened on a wide window) ends up partly or fully
  // off-screen and unreachable after the window is shrunk (issue #34).
  // Re-clamp on open and on every resize.
  useEffect(() => {
    if (!libraryOpen) return;
    const clamp = () => {
      // Mirror the CSS clamp(280px, 34vw, 440px) so the reposition math
      // matches the rendered width.
      const w = Math.max(280, Math.min(window.innerWidth * 0.34, 440));
      setLibraryPos((p) => ({
        x: Math.min(Math.max(8, p.x), Math.max(8, window.innerWidth - w - 8)),
        y: Math.min(Math.max(8, p.y), Math.max(8, window.innerHeight - 80)),
      }));
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [libraryOpen]);

  const toggleSection = (key: keyof SectionState) => {
    setSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleCoordGo = () => {
    const lat = parseFloat(coordLat);
    const lng = parseFloat(coordLng);
    if (!isNaN(lat) && !isNaN(lng)) {
      if (simMode === SimMode.Teleport) {
        onTeleport(lat, lng);
      } else {
        onNavigate(lat, lng);
      }
    }
  };

  const handleSearchSelect = (lat: number, lng: number, name: string) => {
    // Address search always teleports, regardless of current mode.
    // When the parent wires onAddressSelect we route through it so the
    // recent-places list can tag this entry as kind=search.
    if (onAddressSelect) onAddressSelect(lat, lng, name);
    else onTeleport(lat, lng);
  };

  const chevron = (open: boolean) => (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      style={{
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 0.2s',
      }}
    >
      <polyline points="9,18 15,12 9,6" />
    </svg>
  );

  return (
    <div className="control-panel" style={{ overflowY: 'auto', flex: 1 }}>
      {/* Mode Selector */}
      <div className="section">
        <div
          className="section-title"
          onClick={() => toggleSection('mode')}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {chevron(sections.mode)} {t('panel.mode')}
        </div>
        {loadedRouteName && currentWaypointsCount > 0 && (
          <div
            className="section-content"
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 6,
              padding: '6px 10px', marginBottom: 6, fontSize: 12,
              background: 'rgba(108, 140, 255, 0.10)',
              border: '1px solid rgba(108, 140, 255, 0.30)',
              borderRadius: 6,
            }}
            title={loadedRouteName}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9ac0ff" strokeWidth="2" style={{ flexShrink: 0, marginTop: 2 }}>
              <circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" />
              <path d="M8 19h6a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h4" />
            </svg>
            <span style={{ opacity: 0.7, flexShrink: 0 }}>{t('panel.loaded_route')}</span>
            {/* Wrap long names across lines instead of truncating with an
                ellipsis so the full route name is always readable. */}
            <span style={{
              fontWeight: 600, flex: 1, minWidth: 0,
              whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word',
              lineHeight: 1.3,
            }}>
              {loadedRouteName}
            </span>
          </div>
        )}
        {sections.mode && (
          <div
            className="section-content"
            style={{
              // 2-column grid gives each button enough width for the
              // longer EN labels ('Random Walk', 'Multi-stop') without
              // ellipsing them.
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 6,
            }}
          >
            {Object.values(SimMode).map((mode) => (
              <button
                key={mode}
                className={`mode-btn${simMode === mode ? ' active' : ''}`}
                onClick={() => onModeChange(mode)}
                title={t(modeLabelKeys[mode])}
                style={{ justifyContent: 'flex-start', minWidth: 0 }}
              >
                {modeIcons[mode]}
                <span style={{ fontSize: 11, whiteSpace: 'normal', lineHeight: 1.15 }}>
                  {t(modeLabelKeys[mode])}
                </span>
              </button>
            ))}
            {onStraightLineChange && (
              <label
                className="lw-checkbox"
                title={t('panel.straight_line_tooltip')}
                style={{
                  gridColumn: '1 / -1',
                  padding: '6px 10px',
                  background: straightLine ? 'rgba(108, 140, 255, 0.10)' : 'transparent',
                  border: `1px solid ${straightLine ? 'rgba(108, 140, 255, 0.32)' : 'transparent'}`,
                  borderRadius: 6,
                  fontSize: 11,
                }}
              >
                <input
                  type="checkbox"
                  checked={straightLine}
                  onChange={(e) => onStraightLineChange(e.target.checked)}
                />
                <span className="lw-checkbox-box"></span>
                <span className="lw-checkbox-label" style={{ lineHeight: 1.15 }}>
                  {t('panel.straight_line')}
                </span>
              </label>
            )}
            {onRouteEngineChange && (
              <RouteEngineSelector
                value={routeEngine}
                onChange={onRouteEngineChange}
                disabled={straightLine}
              />
            )}
            {onClickToAddWaypointChange && (simMode === SimMode.Loop || simMode === SimMode.MultiStop) && (
              <label
                className="lw-checkbox"
                title={t('panel.click_waypoint_tooltip')}
                style={{
                  gridColumn: '1 / -1',
                  padding: '6px 10px',
                  background: clickToAddWaypoint ? 'rgba(108, 140, 255, 0.10)' : 'transparent',
                  border: `1px solid ${clickToAddWaypoint ? 'rgba(108, 140, 255, 0.32)' : 'transparent'}`,
                  borderRadius: 6,
                  fontSize: 11,
                }}
              >
                <input
                  type="checkbox"
                  checked={clickToAddWaypoint}
                  onChange={(e) => onClickToAddWaypointChange(e.target.checked)}
                />
                <span className="lw-checkbox-box"></span>
                <span className="lw-checkbox-label" style={{ lineHeight: 1.15 }}>
                  {t('panel.click_waypoint')}
                </span>
              </label>
            )}
            {onKeepWaypointsChange && (simMode === SimMode.Loop || simMode === SimMode.MultiStop) && (
              <label
                className="lw-checkbox"
                title={t('panel.keep_waypoints_tooltip')}
                style={{
                  gridColumn: '1 / -1',
                  padding: '6px 10px',
                  background: keepWaypoints ? 'rgba(108, 140, 255, 0.10)' : 'transparent',
                  border: `1px solid ${keepWaypoints ? 'rgba(108, 140, 255, 0.32)' : 'transparent'}`,
                  borderRadius: 6,
                  fontSize: 11,
                }}
              >
                <input
                  type="checkbox"
                  checked={keepWaypoints}
                  onChange={(e) => onKeepWaypointsChange(e.target.checked)}
                />
                <span className="lw-checkbox-box"></span>
                <span className="lw-checkbox-label" style={{ lineHeight: 1.15 }}>
                  {t('panel.keep_waypoints')}
                </span>
              </label>
            )}
            {onJumpModeChange && (simMode === SimMode.Loop || simMode === SimMode.MultiStop) && (
              <div
                style={{
                  gridColumn: '1 / -1',
                  padding: '6px 10px',
                  background: jumpMode ? 'rgba(77, 210, 138, 0.10)' : 'transparent',
                  border: `1px solid ${jumpMode ? 'rgba(77, 210, 138, 0.32)' : 'transparent'}`,
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <label
                  className="lw-checkbox"
                  title={t('panel.jump_mode_tooltip')}
                  style={{ fontSize: 11, padding: 0, background: 'transparent', border: 'none' }}
                >
                  <input
                    type="checkbox"
                    checked={jumpMode}
                    onChange={(e) => onJumpModeChange(e.target.checked)}
                  />
                  <span className="lw-checkbox-box"></span>
                  <span className="lw-checkbox-label" style={{ lineHeight: 1.15 }}>
                    {t('panel.jump_mode')}
                  </span>
                </label>
                {jumpMode && (
                  <>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, opacity: 0.85 }}>
                      {t('panel.jump_pre_delay')}
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        value={jumpPreDelay}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value)
                          if (Number.isFinite(v) && v >= 0 && onJumpPreDelayChange) onJumpPreDelayChange(v)
                        }}
                        style={{
                          width: 60, padding: '2px 6px', fontSize: 11,
                          background: '#0f1218', color: '#e6e8ee',
                          border: '1px solid rgba(255,255,255,0.12)', borderRadius: 4,
                        }}
                      />
                      <span style={{ opacity: 0.7 }}>{t('panel.jump_delay_seconds')}</span>
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, opacity: 0.85 }}>
                      {t('panel.jump_post_delay')}
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        value={jumpPostDelay}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value)
                          if (Number.isFinite(v) && v >= 0 && onJumpPostDelayChange) onJumpPostDelayChange(v)
                        }}
                        style={{
                          width: 60, padding: '2px 6px', fontSize: 11,
                          background: '#0f1218', color: '#e6e8ee',
                          border: '1px solid rgba(255,255,255,0.12)', borderRadius: 4,
                        }}
                      />
                      <span style={{ opacity: 0.7 }}>{t('panel.jump_delay_seconds')}</span>
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {modeExtraSection}

      {/* Random Walk Radius - shown when RandomWalk mode is selected */}
      {simMode === SimMode.RandomWalk && (
        <div className="section" style={{ margin: '0 0 8px 0' }}>
          <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            {t('panel.random_walk_range')}
          </div>
          <div className="section-content">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="number"
                className="search-input"
                value={randomWalkRadius}
                onChange={(e) => {
                  const v = parseInt(e.target.value)
                  if (!isNaN(v) && v > 0) onRandomWalkRadiusChange(v)
                }}
                style={{ flex: 1, maxWidth: 100 }}
                min="50"
                step="50"
              />
              <span style={{ fontSize: 12, opacity: 0.6 }}>{t('panel.meters_radius')}</span>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {[200, 500, 1000, 2000].map((r) => (
                <button
                  key={r}
                  className={`action-btn${randomWalkRadius === r ? ' primary' : ''}`}
                  style={{ padding: '4px 10px', fontSize: 11 }}
                  onClick={() => onRandomWalkRadiusChange(r)}
                >
                  {r >= 1000 ? `${r / 1000}km` : `${r}m`}
                </button>
              ))}
            </div>

            {/* Sampling-circle centre mode */}
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>{t('panel.rw_center_mode')}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['fixed', 'follow'] as const).map((m) => (
                  <button
                    key={m}
                    className={`action-btn${randomWalkCenterMode === m ? ' primary' : ''}`}
                    style={{ flex: 1, padding: '4px 8px', fontSize: 11 }}
                    onClick={() => onRandomWalkCenterModeChange?.(m)}
                  >
                    {t(m === 'fixed' ? 'panel.rw_center_fixed' : 'panel.rw_center_follow')}
                  </button>
                ))}
              </div>
              {randomWalkCenterMode === 'follow' && (
                <div style={{ fontSize: 10, opacity: 0.55, marginTop: 4 }}>{t('panel.rw_center_follow_hint')}</div>
              )}
            </div>

            {/* Forward (correlated) walk: avoid backtracking */}
            {onForwardWalkChange && (
              <div style={{
                marginTop: 8,
                padding: '8px 10px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(108, 140, 255, 0.10)',
                borderRadius: 6,
              }}>
                <label className="lw-checkbox">
                  <input
                    type="checkbox"
                    checked={forwardWalk.enabled}
                    onChange={(e) => onForwardWalkChange({ ...forwardWalk, enabled: e.target.checked })}
                  />
                  <span className="lw-checkbox-box"></span>
                  <span className="lw-checkbox-label">{t('panel.forward_walk')}</span>
                </label>
                {forwardWalk.enabled && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11 }}>
                    <span style={{ opacity: 0.6, minWidth: 16 }}>{t('panel.forward_turn_straight')}</span>
                    <input
                      type="range"
                      min={10}
                      max={90}
                      step={5}
                      value={forwardWalk.turnDeg}
                      onChange={(e) => onForwardWalkChange({ ...forwardWalk, turnDeg: parseInt(e.target.value) })}
                      style={{ flex: 1 }}
                    />
                    <span style={{ opacity: 0.6, minWidth: 16 }}>{t('panel.forward_turn_winding')}</span>
                  </div>
                )}
              </div>
            )}

            {pauseRandomWalk && onPauseRandomWalkChange && (
              <div style={{ marginTop: 8 }}>
                <PauseControl
                  labelKey="pause.random_walk"
                  value={pauseRandomWalk}
                  onChange={onPauseRandomWalkChange}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Gold Ditto (拉金盆) — shown when GoldDitto mode is selected */}
      {simMode === SimMode.GoldDitto && (
        <div className="section" style={{ margin: '0 0 8px 0' }}>
          <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {modeIcons[SimMode.GoldDitto]}
            {t('mode.goldditto')}
          </div>
          <div className="section-content">
            <div style={{ fontSize: 11, opacity: 0.7, lineHeight: 1.4, marginBottom: 8 }}>
              {t('goldditto.flow_help')}
            </div>
            <label style={{ display: 'block', fontSize: 11, opacity: 0.8, marginBottom: 4 }}>
              {t('goldditto.a_label')}
              <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.6 }}>
                {t('goldditto.a_hint')}
              </span>
            </label>
            <div style={{ position: 'relative', marginBottom: 8 }}>
              <input
                type={goldDittoAHidden ? 'password' : 'text'}
                className="search-input"
                value={goldDittoA}
                placeholder={t('goldditto.a_placeholder')}
                onChange={(e) => onGoldDittoAChange?.(e.target.value)}
                style={{ width: '100%', paddingRight: 32 }}
              />
              <button
                type="button"
                onClick={() => setGoldDittoAHidden((v) => !v)}
                title={t(goldDittoAHidden ? 'goldditto.a_show' : 'goldditto.a_hide')}
                style={{
                  position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
                  width: 26, height: 26, padding: 0,
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'currentColor', opacity: 0.65,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.65' }}
              >
                {goldDittoAHidden ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                    <path d="M14.12 14.12A3 3 0 119.88 9.88" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            <button
              className="action-btn primary"
              onClick={() => onGoldDittoStart?.()}
              disabled={goldDittoBusy}
              style={{ width: '100%', padding: '8px 12px', fontSize: 13, fontWeight: 600 }}
            >
              {t('goldditto.start_button')}
            </button>
          </div>
        </div>
      )}

      {/* Speed Selector */}
      <div className="section">
        <div
          className="section-title"
          onClick={() => toggleSection('speed')}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {chevron(sections.speed)} {t('panel.speed')}
        </div>
        {sections.speed && (
          <div className="section-content">
            <div className="speed-selector">
              {[
                { labelKey: 'move.walking' as const, value: 10.8, mode: 'walking' as MoveMode },
                { labelKey: 'move.running' as const, value: 19.8, mode: 'running' as MoveMode },
                { labelKey: 'move.driving' as const, value: 60, mode: 'driving' as MoveMode },
              ].map((opt) => (
                <button
                  key={opt.value}
                  className={`speed-btn${(moveMode === opt.mode && customSpeedKmh == null && speedMinKmh == null && speedMaxKmh == null) ? ' active' : ''}`}
                  onClick={() => {
                    onMoveModeChange(opt.mode);
                    onSpeedChange(opt.value);
                    onCustomSpeedChange(null);
                  }}
                  style={{ padding: '4px 2px' }}
                >
                  <div style={{ fontSize: 11, fontWeight: 500 }}>{t(opt.labelKey)}</div>
                  <div style={{ fontSize: 9, opacity: 0.6 }}>{opt.value} km/h</div>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, opacity: 0.7, whiteSpace: 'nowrap' }}>{t('panel.custom_speed')}:</span>
              <input
                type="number"
                className="search-input"
                placeholder="km/h"
                value={customSpeedKmh ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === '') {
                    onCustomSpeedChange(null)
                  } else {
                    const n = parseFloat(v)
                    if (!isNaN(n) && n > 0) onCustomSpeedChange(n)
                  }
                }}
                style={{ flex: 1, maxWidth: 80 }}
                min="0.1"
                step="0.5"
              />
              <span style={{ fontSize: 11, opacity: 0.5 }}>km/h</span>
              {customSpeedKmh && (
                <button
                  className="action-btn"
                  style={{ padding: '2px 8px', fontSize: 11 }}
                  onClick={() => onCustomSpeedChange(null)}
                >
                  {t('generic.clear')}
                </button>
              )}
            </div>
            {customSpeedKmh && (
              <div style={{ fontSize: 11, color: '#4caf50', marginTop: 4 }}>
                {t('panel.custom_speed_active')}: {customSpeedKmh} km/h ({(customSpeedKmh / 3.6).toFixed(1)} m/s)
              </div>
            )}

            {/* Random range (overrides fixed) */}
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{t('panel.speed_range')}:</span>
                {(speedMinKmh != null || speedMaxKmh != null) && (
                  <button
                    className="action-btn"
                    style={{ padding: '2px 8px', fontSize: 11 }}
                    onClick={() => { onSpeedMinChange(null); onSpeedMaxChange(null); }}
                  >
                    {t('generic.clear')}
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="number"
                  className="search-input"
                  placeholder={t('panel.speed_range_min')}
                  value={speedMinKmh ?? ''}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === '') return onSpeedMinChange(null)
                    const n = parseFloat(v)
                    if (!isNaN(n) && n > 0) onSpeedMinChange(n)
                  }}
                  style={{ flex: 1, fontSize: 12 }}
                  min="0.1"
                  step="1"
                />
                <span style={{ fontSize: 12, opacity: 0.5 }}>~</span>
                <input
                  type="number"
                  className="search-input"
                  placeholder={t('panel.speed_range_max')}
                  value={speedMaxKmh ?? ''}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === '') return onSpeedMaxChange(null)
                    const n = parseFloat(v)
                    if (!isNaN(n) && n > 0) onSpeedMaxChange(n)
                  }}
                  style={{ flex: 1, fontSize: 12 }}
                  min="0.1"
                  step="1"
                />
              </div>
            </div>
            {speedMinKmh != null && speedMaxKmh != null && (
              <div style={{ fontSize: 11, color: '#ffb74d', marginTop: 4 }}>
                {t('panel.speed_range_active')}: {Math.min(speedMinKmh, speedMaxKmh)}~{Math.max(speedMinKmh, speedMaxKmh)} km/h ({t('panel.speed_range_hint')})
              </div>
            )}
          </div>
        )}

        {/* Apply-speed button — only visible while a route is running so the
            user can hot-swap speed mid-nav without stopping / restarting. */}
        {isRunning && onApplySpeed && <ApplySpeedButton onApply={onApplySpeed} t={t} />}
      </div>

      {/* Start / Stop / Pause moved to the bottom-left of the map (sits
          above the coord-input strip). See MapView's TransportButtons
          render. Sidebar has nothing left for this row — keeping just a
          spacer so the bottom Section content reflows cleanly. */}

      {/* Coordinate input moved into the map overlay (see MapView). */}

      {/* Address Search */}
      <div className="section">
        <div
          className="section-title"
          onClick={() => toggleSection('search')}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {chevron(sections.search)} {t('panel.address_search')}
        </div>
        {sections.search && (
          <div className="section-content">
            <AddressSearch onSelect={handleSearchSelect} />
          </div>
        )}
      </div>

      {/* Library entry button moved to the map's topleft control stack
          (see MapView A3 star). Keeping this block removed — the map
          button is the only entry point now. */}

      {/* Official LINE pinned to the sidebar bottom — questions / feedback
          channel for users. Styled like the GitHub footer (inline icon +
          brand colour). */}
      <div className="section" style={{ marginTop: 'auto', paddingTop: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 11, opacity: 0.7, textAlign: 'center', lineHeight: 1.5, whiteSpace: 'pre-line' }}>
          {t('support.contact_caption')}
        </div>
        <a
          href="https://lin.ee/UwdCrmf"
          target="_blank"
          rel="noopener noreferrer"
          title={t('support.line_tooltip')}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            textDecoration: 'none', color: '#fff',
            background: '#06C755',
            padding: '10px 16px',
            borderRadius: 8,
            fontSize: 16, fontWeight: 700,
            letterSpacing: '0.02em',
            boxShadow: '0 2px 10px rgba(6, 199, 85, 0.4)',
            width: '100%',
            boxSizing: 'border-box',
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314"/>
          </svg>
          {t('support.line_label')}
        </a>
      </div>

      {libraryOpen && createPortal(
        <div
          className="anim-scale-in"
          style={{
            position: 'fixed', left: libraryPos.x, top: libraryPos.y, zIndex: 800,
            // Scale with the window: shrinks toward 280px on a small app
            // window, caps at 440px on a large one (issue #34).
            width: 'clamp(280px, 34vw, 440px)', maxHeight: '72vh',
            background: 'rgba(26, 29, 39, 0.96)',
            backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
            border: '1px solid rgba(108, 140, 255, 0.18)', borderRadius: 12,
            boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.04) inset',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
            <div
              onMouseDown={startDrag}
              style={{
                display: 'flex', alignItems: 'center',
                padding: '6px 10px', fontSize: 11, opacity: 0.6,
                background: '#1c1c22', borderBottom: '1px solid #3a3a42',
                cursor: 'move', userSelect: 'none',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6 }}>
                <circle cx="9" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="9" cy="18" r="1" />
                <circle cx="15" cy="6" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="18" r="1" />
              </svg>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid #3a3a42' }}>
              <button
                className={`action-btn${libraryTab === 'bookmarks' ? ' primary' : ''}`}
                style={{ flex: 1, borderRadius: 0, padding: '10px', background: libraryTab === 'bookmarks' ? '#2d4373' : 'transparent' }}
                onClick={() => setLibraryTab('bookmarks')}
              >{t('panel.bookmarks_count')} ({bookmarks.length})</button>
              <button
                className={`action-btn${libraryTab === 'routes' ? ' primary' : ''}`}
                style={{ flex: 1, borderRadius: 0, padding: '10px', background: libraryTab === 'routes' ? '#2d4373' : 'transparent' }}
                onClick={() => setLibraryTab('routes')}
              >{t('panel.routes_count')} ({savedRoutes.length})</button>
              <button
                className="action-btn"
                style={{ padding: '10px 14px', borderRadius: 0 }}
                onClick={() => setLibraryOpen(false)}
                title={t('panel.close')}
              >X</button>
            </div>
            <div style={{ padding: 12, overflowY: 'auto', flex: 1, minWidth: 0 }}>
              {libraryTab === 'bookmarks' ? (
                <BookmarkList
                  bookmarks={bookmarks}
                  categories={bookmarkCategories}
                  categoryColors={bookmarkCategoryColors}
                  currentPosition={currentPosition}
                  onBookmarkClick={(b) => { onBookmarkClick(b); }}
                  onBookmarkPreview={onBookmarkPreview}
                  onBookmarkAdd={onBookmarkAdd}
                  onBookmarkDelete={onBookmarkDelete}
                  onBookmarkEdit={onBookmarkEdit}
                  onCategoryAdd={onCategoryAdd}
                  onCategoryDelete={onCategoryDelete}
                  onCategoryRename={onCategoryRename}
                  onCategoryRecolor={onCategoryRecolor}
                  onCategoryReorder={onCategoryReorder}
                  onBookmarkReorder={onBookmarkReorder}
                  showOnMap={bookmarkShowOnMap}
                  onShowOnMapChange={onBookmarkShowOnMapChange}
                  onImport={onBookmarkImport}
                  onBulkPaste={onBookmarkBulkPaste}
                  exportUrl={bookmarkExportUrl}
                />
              ) : (
                <RouteList
                  routes={savedRoutes}
                  categories={routeCategories}
                  currentWaypointsCount={currentWaypointsCount}
                  onRouteLoad={(id) => { onRouteLoad(id); setLibraryOpen(false); }}
                  onRouteSave={onRouteSave}
                  onRouteRename={(id, name) => onRouteRename?.(id, name)}
                  onRouteDelete={(id) => onRouteDelete?.(id)}
                  onRoutesBulkDelete={onRoutesBulkDelete}
                  onRouteMove={onRouteMove}
                  onRouteGpxExport={onRouteGpxExport}
                  onRouteGpxImport={onRouteGpxImport}
                  onCategoryAdd={onRouteCategoryAdd}
                  onCategoryDelete={onRouteCategoryDelete}
                  onCategoryRename={onRouteCategoryRename}
                  onCategoryRecolor={onRouteCategoryRecolor}
                  onCategoryReorder={onRouteCategoryReorder}
                  onRouteReorder={onRouteReorder}
                  routesExportAllUrl={routesExportAllUrl}
                  onRoutesImportAll={onRoutesImportAll}
                />
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Footer — author + GitHub link */}
      <div
        style={{
          marginTop: 12,
          padding: '8px 4px 4px',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          fontSize: 11,
          opacity: 0.55,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        }}
      >
        <span>LocWarp by</span>
        <a
          href="https://github.com/keezxc1223/locwarp"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: '#6c8cff',
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
          </svg>
          keezxc1223/locwarp
        </a>
      </div>
    </div>
  );
};

export default ControlPanel;
