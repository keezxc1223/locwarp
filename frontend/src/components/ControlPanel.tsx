import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';

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

interface SavedRoute {
  id: string;
  name: string;
  waypoints: Position[];
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
  bookmarks: Bookmark[];
  bookmarkCategories: string[];
  onBookmarkClick: (bm: Bookmark) => void;
  onBookmarkAdd: (bm: Bookmark) => void;
  onBookmarkDelete: (id: string) => void;
  onBookmarkEdit: (id: string, bm: Partial<Bookmark>) => void;
  onCategoryAdd: (name: string) => void;
  onCategoryDelete: (name: string) => void;
  onBookmarkImport?: (file: File) => Promise<void>;
  bookmarkExportUrl?: string;
  savedRoutes: SavedRoute[];
  onRouteLoad: (id: string) => void;
  onRouteSave: (name: string) => void;
  onRouteRename?: (id: string, name: string) => void;
  onRouteDelete?: (id: string) => void;
  onRouteGpxImport?: (file: File) => Promise<void>;
  onRouteGpxExport?: (id: string) => void;
  onRoutesImportAll?: (file: File) => Promise<void>;
  routesExportAllUrl?: string;
  randomWalkRadius: number;
  pauseRandomWalk?: { enabled: boolean; min: number; max: number };
  onPauseRandomWalkChange?: (v: { enabled: boolean; min: number; max: number }) => void;
  onRandomWalkRadiusChange: (radius: number) => void;
  modeExtraSection?: React.ReactNode;
  currentWaypointsCount?: number;
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
};

import type { StringKey } from '../i18n';
const modeLabelKeys: Record<SimMode, StringKey> = {
  [SimMode.Teleport]: 'mode.teleport',
  [SimMode.Navigate]: 'mode.navigate',
  [SimMode.Loop]: 'mode.loop',
  [SimMode.MultiStop]: 'mode.multi_stop',
  [SimMode.RandomWalk]: 'mode.random_walk',
  [SimMode.Joystick]: 'mode.joystick',
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
  bookmarks,
  bookmarkCategories,
  onBookmarkClick,
  onBookmarkAdd,
  onBookmarkDelete,
  onBookmarkEdit,
  onCategoryAdd,
  onCategoryDelete,
  onBookmarkImport,
  bookmarkExportUrl,
  savedRoutes,
  onRouteLoad,
  onRouteSave,
  onRouteRename,
  onRouteDelete,
  onRouteGpxImport,
  onRouteGpxExport,
  onRoutesImportAll,
  routesExportAllUrl,
  randomWalkRadius,
  pauseRandomWalk,
  onPauseRandomWalkChange,
  onRandomWalkRadiusChange,
  modeExtraSection,
  currentWaypointsCount = 0,
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
  const [routeName, setRouteName] = useState('');
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [editingRouteName, setEditingRouteName] = useState('');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryTab, setLibraryTab] = useState<'bookmarks' | 'routes'>('bookmarks');
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

  const handleSearchSelect = (lat: number, lng: number, _name: string) => {
    // Address search always teleports, regardless of current mode.
    onTeleport(lat, lng);
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
                { labelKey: 'move.walking' as const, value: 5, mode: 'walking' as MoveMode },
                { labelKey: 'move.running' as const, value: 10, mode: 'running' as MoveMode },
                { labelKey: 'move.driving' as const, value: 40, mode: 'driving' as MoveMode },
              ].map((opt) => (
                <button
                  key={opt.value}
                  className={`speed-btn${(moveMode === opt.mode && customSpeedKmh == null && speedMinKmh == null && speedMaxKmh == null) ? ' active' : ''}`}
                  onClick={() => {
                    onMoveModeChange(opt.mode);
                    onSpeedChange(opt.value);
                    onCustomSpeedChange(null);
                  }}
                  style={{ padding: '6px 4px' }}
                >
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{t(opt.labelKey)}</div>
                  <div style={{ fontSize: 10, opacity: 0.6 }}>{opt.value} km/h</div>
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

      {/* Action Buttons */}
      <div className="section">
        <div className="section-content" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!isRunning && (
            <button className="action-btn primary" onClick={onStart}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5,3 19,12 5,21" />
              </svg>
              {t('generic.start')}
            </button>
          )}
          {isRunning && (
            <button className="action-btn danger" onClick={onStop}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="4" y="4" width="16" height="16" rx="2" />
              </svg>
              {t('generic.stop')}
            </button>
          )}
          {isRunning && !isPaused && (
            <button className="action-btn" onClick={onPause}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="5" y="4" width="5" height="16" rx="1" />
                <rect x="14" y="4" width="5" height="16" rx="1" />
              </svg>
              {t('generic.pause')}
            </button>
          )}
          {isRunning && isPaused && (
            <button className="action-btn primary" onClick={onResume}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5,3 19,12 5,21" />
              </svg>
              {t('generic.resume')}
            </button>
          )}
        </div>
      </div>

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

      {/* Library entry button (bookmarks + saved routes) */}
      <div className="section">
        <button
          className="action-btn"
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '8px' }}
          onClick={(e) => { e.stopPropagation(); setLibraryOpen(true); }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
          </svg>
          {t('panel.library')}
          <span style={{ opacity: 0.6, fontSize: 11 }}>
            ({bookmarks.length} / {savedRoutes.length})
          </span>
        </button>
      </div>

      {libraryOpen && createPortal(
        <div
          className="anim-scale-in"
          style={{
            position: 'fixed', left: libraryPos.x, top: libraryPos.y, zIndex: 800,
            width: 'min(420px, 90vw)', maxHeight: '75vh',
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
              {t('panel.library_drag_hint')}
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
            <div style={{ padding: 12, overflowY: 'auto', flex: 1 }}>
              {libraryTab === 'bookmarks' ? (
                <BookmarkList
                  bookmarks={bookmarks}
                  categories={bookmarkCategories}
                  currentPosition={currentPosition}
                  onBookmarkClick={(b) => { onBookmarkClick(b); setLibraryOpen(false); }}
                  onBookmarkAdd={onBookmarkAdd}
                  onBookmarkDelete={onBookmarkDelete}
                  onBookmarkEdit={onBookmarkEdit}
                  onCategoryAdd={onCategoryAdd}
                  onCategoryDelete={onCategoryDelete}
                  onImport={onBookmarkImport}
                  exportUrl={bookmarkExportUrl}
                />
              ) : (
                <>
                  <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>
                    {t('panel.route_save_hint', { n: currentWaypointsCount })}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                    <input
                      type="text"
                      className="search-input"
                      placeholder={t('panel.route_name')}
                      value={routeName}
                      onChange={(e) => setRouteName(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button
                      className="action-btn primary"
                      disabled={!routeName.trim() || currentWaypointsCount === 0}
                      onClick={() => {
                        if (routeName.trim() && currentWaypointsCount > 0) {
                          onRouteSave(routeName.trim());
                          setRouteName('');
                        }
                      }}
                    >{t('generic.save')}</button>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                    {onRouteGpxImport && (
                      <label
                        className="action-btn"
                        title={t('panel.route_gpx_import')}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '4px 10px', fontSize: 11, cursor: 'pointer',
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                          <polyline points="17 8 12 3 7 8" />
                          <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                        {t('panel.route_gpx_import')}
                        <input
                          type="file"
                          accept=".gpx,application/gpx+xml"
                          style={{ display: 'none' }}
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            if (f) await onRouteGpxImport(f);
                            e.target.value = '';
                          }}
                        />
                      </label>
                    )}
                    {routesExportAllUrl && (
                      savedRoutes.length > 0 ? (
                        <a
                          className="action-btn"
                          href={routesExportAllUrl}
                          download="locwarp-routes.json"
                          title={t('panel.routes_export_all_tooltip')}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '4px 10px', fontSize: 11, cursor: 'pointer',
                            textDecoration: 'none',
                            color: '#4ecdc4',
                            background: 'rgba(78, 205, 196, 0.12)',
                            border: '1px solid rgba(78, 205, 196, 0.35)',
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                          </svg>
                          {t('panel.routes_export_all')}
                        </a>
                      ) : (
                        <button
                          className="action-btn"
                          disabled
                          title={t('panel.routes_export_all_disabled')}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '4px 10px', fontSize: 11,
                            cursor: 'not-allowed',
                            color: 'rgba(78, 205, 196, 0.45)',
                            background: 'rgba(78, 205, 196, 0.05)',
                            border: '1px solid rgba(78, 205, 196, 0.15)',
                            opacity: 0.55,
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                          </svg>
                          {t('panel.routes_export_all')}
                        </button>
                      )
                    )}
                    {onRoutesImportAll && (
                      <label
                        className="action-btn"
                        title={t('panel.routes_import_all_tooltip')}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '4px 10px', fontSize: 11, cursor: 'pointer',
                          color: '#4ecdc4',
                          background: 'rgba(78, 205, 196, 0.12)',
                          border: '1px solid rgba(78, 205, 196, 0.35)',
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                          <polyline points="17 8 12 3 7 8" />
                          <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                        {t('panel.routes_import_all')}
                        <input
                          type="file"
                          accept=".json,application/json"
                          style={{ display: 'none' }}
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            if (f) await onRoutesImportAll(f);
                            e.target.value = '';
                          }}
                        />
                      </label>
                    )}
                  </div>
                  {savedRoutes.length === 0 && (
                    <div style={{ fontSize: 12, opacity: 0.5, padding: '8px 0' }}>{t('panel.route_empty')}</div>
                  )}
                  {savedRoutes.map((route) => {
                    const isEditing = editingRouteId === route.id;
                    const commitRename = () => {
                      const n = editingRouteName.trim();
                      if (n && n !== route.name && onRouteRename) onRouteRename(route.id, n);
                      setEditingRouteId(null);
                    };
                    return (
                      <div
                        key={route.id}
                        className="bookmark-item"
                        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px', borderRadius: 4 }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="22,12 18,12 15,21 9,3 6,12 2,12" />
                        </svg>
                        {isEditing ? (
                          <input
                            type="text"
                            autoFocus
                            value={editingRouteName}
                            onChange={(e) => setEditingRouteName(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename();
                              else if (e.key === 'Escape') setEditingRouteId(null);
                            }}
                            style={{ flex: 1, fontSize: 13, padding: '2px 4px' }}
                          />
                        ) : (
                          <span
                            style={{ fontSize: 13, flex: 1, cursor: 'pointer' }}
                            onClick={() => { onRouteLoad(route.id); setLibraryOpen(false); }}
                            title={t('panel.route_load_tooltip')}
                          >
                            {route.name}
                          </span>
                        )}
                        <span style={{ opacity: 0.5, fontSize: 11 }}>
                          {route.waypoints.length} pts
                        </span>
                        {!isEditing && onRouteRename && (
                          <button
                            className="action-btn"
                            title={t('generic.rename')}
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingRouteId(route.id);
                              setEditingRouteName(route.name);
                            }}
                            style={{ padding: '2px 6px', fontSize: 10 }}
                          >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                            </svg>
                          </button>
                        )}
                        {onRouteGpxExport && (
                          <button
                            className="action-btn"
                            title={t('panel.route_gpx_export_tooltip')}
                            onClick={(e) => { e.stopPropagation(); onRouteGpxExport(route.id); }}
                            style={{
                              padding: '3px 8px', fontSize: 11, fontWeight: 600,
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              color: '#6c8cff',
                              background: 'rgba(108, 140, 255, 0.12)',
                              border: '1px solid rgba(108, 140, 255, 0.35)',
                            }}
                          >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                              <polyline points="7 10 12 15 17 10" />
                              <line x1="12" y1="15" x2="12" y2="3" />
                            </svg>
                            GPX
                          </button>
                        )}
                        {onRouteDelete && (
                          <button
                            className="action-btn"
                            title={t('generic.delete')}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm(t('panel.route_delete_confirm', { name: route.name }))) onRouteDelete(route.id);
                            }}
                            style={{ padding: '2px 6px', fontSize: 10, color: '#f44336' }}
                          >
                            X
                          </button>
                        )}
                      </div>
                    );
                  })}
                </>
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
