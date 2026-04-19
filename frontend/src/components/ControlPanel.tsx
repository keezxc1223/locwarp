import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import PauseControl from './PauseControl';
import { SimMode } from '../hooks/useSimulation';
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

export interface SavedRoute {
  id: string;
  name: string;
  waypoints: Position[];
}

interface ControlPanelProps {
  simMode: SimMode;
  defaultSpeed: number;
  isRunning: boolean;
  isPaused: boolean;
  currentPosition: Position | null;
  onModeChange: (mode: SimMode) => void;
  customSpeedKmh: number | null;
  onCustomSpeedChange: (speed: number | null) => void;
  customVarianceKmh: number | null;
  onCustomVarianceChange: (v: number | null) => void;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
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
  savedRoutes: SavedRoute[];
  onRouteLoad: (id: string) => void;
  onRouteSave: (name: string) => void;
  onRouteRename?: (id: string, name: string) => void;
  onRouteDelete?: (id: string) => void;
  onRouteGpxImport?: (file: File) => Promise<void>;
  onRouteGpxExport?: (id: string) => void;
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
  defaultSpeed,
  isRunning,
  isPaused,
  currentPosition,
  onModeChange,
  customSpeedKmh,
  onCustomSpeedChange,
  customVarianceKmh,
  onCustomVarianceChange,
  onStart,
  onStop,
  onPause,
  onResume,
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
  savedRoutes,
  onRouteLoad,
  onRouteSave,
  onRouteRename,
  onRouteDelete,
  onRouteGpxImport,
  onRouteGpxExport,
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
  // tracks whether Escape was pressed so onBlur doesn't commit the rename
  const renameCancelledRef = useRef(false);
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
    if (simMode === SimMode.Teleport) {
      onTeleport(lat, lng);
    } else {
      onNavigate(lat, lng);
    }
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
          <div className="section-content" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {Object.values(SimMode).map((mode) => (
              <button
                key={mode}
                className={`mode-btn${simMode === mode ? ' active' : ''}`}
                onClick={() => onModeChange(mode)}
                title={t(modeLabelKeys[mode])}
              >
                {modeIcons[mode]}
                <span style={{ fontSize: 11, marginTop: 2 }}>{t(modeLabelKeys[mode])}</span>
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
            {/* 自訂固定速度 + 上下浮動 — 整個速度設定唯一入口 */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, opacity: 0.7, whiteSpace: 'nowrap' }}>{t('panel.custom_speed')}:</span>
              <input
                type="number"
                className="search-input"
                placeholder={`${defaultSpeed}`}
                value={customSpeedKmh ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === '') {
                    onCustomSpeedChange(null)
                    onCustomVarianceChange(null)
                  } else {
                    const n = parseFloat(v)
                    if (!isNaN(n) && n > 0) onCustomSpeedChange(n)
                  }
                }}
                style={{ width: 70 }}
                min="0.1"
                step="0.5"
              />
              <span style={{ fontSize: 11, opacity: 0.5 }}>km/h</span>
              <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 4 }}>±</span>
              <input
                type="number"
                className="search-input"
                placeholder="0"
                value={customVarianceKmh ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === '') return onCustomVarianceChange(null)
                  const n = parseFloat(v)
                  if (!isNaN(n) && n >= 0) onCustomVarianceChange(n)
                }}
                disabled={customSpeedKmh == null}
                title={customSpeedKmh == null ? t('panel.custom_speed') : t('panel.speed_variance')}
                style={{ width: 56, opacity: customSpeedKmh == null ? 0.4 : 1 }}
                min="0"
                step="0.5"
              />
              <span style={{ fontSize: 11, opacity: 0.5 }}>km/h</span>
              {customSpeedKmh != null && (
                <button
                  className="action-btn"
                  style={{ padding: '2px 8px', fontSize: 11, marginLeft: 'auto' }}
                  onClick={() => { onCustomSpeedChange(null); onCustomVarianceChange(null); }}
                >
                  {t('generic.clear')}
                </button>
              )}
            </div>

            {/* 實際速度摘要：空白時用 defaultSpeed 顯示後端 fallback */}
            <div
              style={{
                marginTop: 8, padding: '6px 10px', borderRadius: 4,
                background: 'rgba(108,140,255,0.10)',
                border: '1px solid rgba(108,140,255,0.22)',
                fontSize: 11, color: '#c7d2fe',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span style={{ opacity: 0.75 }}>{t('panel.actual_speed')}：</span>
              <span style={{ fontWeight: 600 }}>
                {customSpeedKmh != null && customVarianceKmh != null && customVarianceKmh > 0
                  ? `${Math.max(0.1, customSpeedKmh - customVarianceKmh).toFixed(1)}~${(customSpeedKmh + customVarianceKmh).toFixed(1)} km/h`
                  : customSpeedKmh != null
                    ? `${customSpeedKmh} km/h`
                    : `${defaultSpeed} km/h`}
              </span>
            </div>
          </div>
        )}
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

      {/* Coordinate Input */}
      <div className="section">
        <div
          className="section-title"
          onClick={() => toggleSection('coords')}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {chevron(sections.coords)} {t('panel.coords')}
        </div>
        {sections.coords && (
          <div className="section-content">
            <input
              type="text"
              className="search-input"
              placeholder={t('panel.coord_lat')}
              value={coordLat}
              onChange={(e) => setCoordLat(e.target.value)}
              style={{ width: '100%', marginBottom: 6 }}
            />
            <input
              type="text"
              className="search-input"
              placeholder={t('panel.coord_lng')}
              value={coordLng}
              onChange={(e) => setCoordLng(e.target.value)}
              style={{ width: '100%', marginBottom: 6 }}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="action-btn primary"
                onClick={handleCoordGo}
                style={{ flex: 1 }}
              >
                {t('panel.coord_go')}
              </button>
              <button
                className="action-btn"
                onClick={() => { setCoordLat(''); setCoordLng(''); }}
                disabled={!coordLat && !coordLng}
                style={{ padding: '4px 12px' }}
                title={t('generic.clear')}
              >
                {t('generic.clear')}
              </button>
            </div>
            {currentPosition && (
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>
                {t('panel.current_pos')} {currentPosition.lat.toFixed(6)}, {currentPosition.lng.toFixed(6)}
              </div>
            )}
          </div>
        )}
      </div>

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
          style={{
            position: 'fixed', left: libraryPos.x, top: libraryPos.y, zIndex: 9000,
            width: 'min(420px, 90vw)', maxHeight: '75vh',
            background: '#23232a', border: '1px solid #3a3a42', borderRadius: 8,
            boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
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
              >✕</button>
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
                  {onRouteGpxImport && (
                    <div style={{ marginBottom: 10 }}>
                      <label
                        className="action-btn"
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
                    </div>
                  )}
                  {savedRoutes.length === 0 && (
                    <div style={{ fontSize: 12, opacity: 0.5, padding: '8px 0' }}>{t('panel.route_empty')}</div>
                  )}
                  {savedRoutes.map((route) => {
                    const isEditing = editingRouteId === route.id;
                    const commitRename = () => {
                      if (renameCancelledRef.current) { renameCancelledRef.current = false; return; }
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
                              else if (e.key === 'Escape') {
                                renameCancelledRef.current = true;
                                setEditingRouteId(null);
                              }
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
                            style={{ padding: '2px 6px', fontSize: 10 }}
                          >
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
                            ✕
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

    </div>
  );
};

export default ControlPanel;
