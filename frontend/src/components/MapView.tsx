import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useT } from '../i18n';
import L from 'leaflet';

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

interface MapViewProps {
  currentPosition: Position | null;
  destination: Position | null;
  waypoints: Waypoint[];
  routePath: Position[];
  randomWalkRadius: number | null;
  onMapClick: (lat: number, lng: number) => void;
  onTeleport: (lat: number, lng: number) => void;
  onNavigate: (lat: number, lng: number) => void;
  onAddBookmark: (lat: number, lng: number) => void;
  onAddWaypoint?: (lat: number, lng: number) => void;
  showWaypointOption?: boolean;
  deviceConnected?: boolean;
  /** When true, left-clicking the map directly adds a waypoint instead of showing pin */
  drawingMode?: boolean;
  /** Cooldown circle — drawn from the last teleport point with radius = jump distance */
  cooldownCircle?: { lat: number; lng: number; distanceKm: number; remainingSeconds: number } | null;
  /** Bookmark markers -- clicking teleports/navigates like the list in the Library panel */
  bookmarkMarkers?: { id?: string; lat: number; lng: number; name: string; category?: string }[];
}

const MapView: React.FC<MapViewProps> = ({
  currentPosition,
  destination,
  waypoints,
  routePath,
  randomWalkRadius,
  onMapClick,
  onTeleport,
  onNavigate,
  onAddBookmark,
  onAddWaypoint,
  showWaypointOption,
  deviceConnected = true,
  drawingMode = false,
  cooldownCircle,
  bookmarkMarkers = [],
}) => {
  const t = useT();
  // The map-init useEffect only runs once, so its click handler captures the
  // first-render `t`. Language switches then don't reach the tooltip hint.
  // Route lookups through a ref that we keep in sync every render.
  const tRef = useRef(t);
  tRef.current = t;
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const currentMarkerRef = useRef<L.CircleMarker | null>(null);
  const prevPositionRef = useRef<Position | null>(null);
  const destMarkerRef = useRef<L.Marker | null>(null);
  const waypointMarkersRef = useRef<L.Marker[]>([]);
  const polylineRef = useRef<L.Polyline | null>(null);
  const clickMarkerRef = useRef<L.Marker | null>(null);
  const radiusCircleRef = useRef<L.Circle | null>(null);
  const cooldownCircleRef = useRef<L.Circle | null>(null);
  const bookmarkMarkersRef = useRef<L.Marker[]>([]);
  const [showBookmarkLayer, setShowBookmarkLayer] = useState(true);
  const [bookmarkSearch, setBookmarkSearch] = useState('');
  const onTeleportRef = useRef(onTeleport);
  onTeleportRef.current = onTeleport;
  // Keep drawingMode accessible inside the stable map click handler
  const drawingModeRef = useRef(drawingMode);
  drawingModeRef.current = drawingMode;
  const onAddWaypointRef = useRef(onAddWaypoint);
  onAddWaypointRef.current = onAddWaypoint;

  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    lat: 0,
    lng: 0,
  });

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [25.033, 121.5654],
      zoom: 13,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 20,
    }).addTo(map);

    const clickIcon = L.divIcon({
      className: 'click-marker',
      html: `<svg width="40" height="54" viewBox="0 0 40 54">
        <defs>
          <filter id="clickShadow" x="-20%" y="-10%" width="140%" height="130%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.4"/>
          </filter>
        </defs>
        <path d="M20 50 L20 46" stroke="#6c8cff" stroke-width="2" opacity="0.5"/>
        <ellipse cx="20" cy="50" rx="6" ry="2" fill="#000" opacity="0.2"/>
        <path d="M20 2C10.6 2 3 9.6 3 19c0 12.7 17 31 17 31s17-18.3 17-31C37 9.6 29.4 2 20 2z"
              fill="#6c8cff" filter="url(#clickShadow)"/>
        <path d="M20 4C11.7 4 5 10.7 5 19c0 11.5 15 28 15 28s15-16.5 15-28C35 10.7 28.3 4 20 4z"
              fill="#5a7ff0"/>
        <circle cx="20" cy="19" r="7" fill="#ffffff" opacity="0.95"/>
        <circle cx="20" cy="19" r="3" fill="#6c8cff"/>
      </svg>`,
      iconSize: [40, 54],
      iconAnchor: [20, 50],
    });

    map.on('click', (e: L.LeafletMouseEvent) => {
      closeContextMenu();

      // Drawing mode: left-click directly adds waypoint
      if (drawingModeRef.current && onAddWaypointRef.current) {
        onAddWaypointRef.current(e.latlng.lat, e.latlng.lng);
        return;
      }

      // Reuse the same marker to avoid a visible remount flash at (0,0)
      // before CSS transform kicks in. setLatLng is atomic.
      const clickHintLine1 = tRef.current('map.click_not_locate');
      const clickHintLine2 = tRef.current('map.click_use_right');
      const tooltipHtml = (
        `<div style="text-align:center;line-height:1.35">` +
          `<div>${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}</div>` +
          `<div style="font-size:10px;color:#ffb74d;margin-top:2px">${clickHintLine1}</div>` +
          `<div style="font-size:10px;color:#ffb74d">${clickHintLine2}</div>` +
        `</div>`
      );
      if (!clickMarkerRef.current) {
        clickMarkerRef.current = L.marker([e.latlng.lat, e.latlng.lng], { icon: clickIcon });
        clickMarkerRef.current.bindTooltip(
          tooltipHtml,
          { direction: 'top', offset: [0, -52], permanent: false },
        );
        clickMarkerRef.current.addTo(map);
      } else {
        clickMarkerRef.current.setLatLng([e.latlng.lat, e.latlng.lng]);
        clickMarkerRef.current.setTooltipContent(tooltipHtml);
      }
      clickMarkerRef.current.openTooltip();

      onMapClick(e.latlng.lat, e.latlng.lng);
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

    return () => {
      // Leaflet's map.remove() drops all attached layers, but our refs still
      // point to the now-detached layer objects. Without resetting them, a
      // re-mount (React 18 StrictMode double-invocation, Vite HMR, or any
      // future scenario where MapView unmounts) hits the `if (ref.current)`
      // branch in each child effect and tries to setLatLng on a layer that's
      // not on the map — silently no-ops, leaving markers invisible.
      map.remove();
      mapRef.current = null;
      currentMarkerRef.current = null;
      destMarkerRef.current = null;
      waypointMarkersRef.current = [];
      polylineRef.current = null;
      clickMarkerRef.current = null;
      radiusCircleRef.current = null;
      cooldownCircleRef.current = null;
      bookmarkMarkersRef.current = [];
      // Reset signature caches so child effects re-render content on re-mount
      destSigRef.current = null;
      waypointSigRef.current = '';
      prevPositionRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update current position marker — move existing marker instead of recreating
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !currentPosition) return;

    const latlng: L.LatLngExpression = [currentPosition.lat, currentPosition.lng];

    if (currentMarkerRef.current) {
      // Just move the existing marker — no flicker
      (currentMarkerRef.current as any).setLatLng(latlng);
      (currentMarkerRef.current as any).setTooltipContent(
        `${currentPosition.lat.toFixed(6)}, ${currentPosition.lng.toFixed(6)}`
      );
    } else {
      // First time: create the marker
      const personIcon = L.divIcon({
        className: 'current-pos-marker',
        html: `<div class="pos-pulse-ring"></div>
          <div class="pos-pulse-ring pos-pulse-ring-2"></div>
          <svg width="44" height="44" viewBox="0 0 44 44" class="pos-icon">
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
          </svg>`,
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      });

      const marker = L.marker(latlng, {
        icon: personIcon,
        zIndexOffset: 1000,
      }).addTo(map);

      marker.bindTooltip(
        `${currentPosition.lat.toFixed(6)}, ${currentPosition.lng.toFixed(6)}`,
        { direction: 'top', offset: [0, -20] }
      );

      currentMarkerRef.current = marker as any;
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
  }, [currentPosition]);

  // Update destination marker
  const destSigRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

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
  }, [destination]);

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
      const wpIcon = L.divIcon({
        className: 'waypoint-marker',
        html: `<svg width="32" height="44" viewBox="0 0 32 44">
          <defs>
            <filter id="wpShadow${wp.index}" x="-20%" y="-10%" width="140%" height="130%">
              <feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#000" flood-opacity="0.35"/>
            </filter>
            <linearGradient id="wpGrad${wp.index}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#ffb74d"/>
              <stop offset="100%" stop-color="#ff9800"/>
            </linearGradient>
          </defs>
          <ellipse cx="16" cy="41" rx="5" ry="1.8" fill="#000" opacity="0.15"/>
          <path d="M16 2C8.8 2 3 7.8 3 15c0 10 13 26 13 26s13-16 13-26C29 7.8 23.2 2 16 2z"
                fill="url(#wpGrad${wp.index})" filter="url(#wpShadow${wp.index})"/>
          <circle cx="16" cy="15" r="8" fill="#ffffff" opacity="0.95"/>
          <text x="16" y="19" text-anchor="middle" fill="#e65100" font-size="12" font-weight="700" font-family="system-ui">${wp.index + 1}</text>
        </svg>`,
        iconSize: [32, 44],
        iconAnchor: [16, 41],
      });

      const marker = L.marker([wp.lat, wp.lng], { icon: wpIcon }).addTo(map);
      marker.bindTooltip(t('panel.waypoint_num', { n: wp.index + 1 }), {
        direction: 'top',
        offset: [0, -14],
      });
      waypointMarkersRef.current.push(marker);
    });
  }, [waypoints]);

  // Update route polyline
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (polylineRef.current) {
      polylineRef.current.remove();
      polylineRef.current = null;
    }

    if (routePath.length > 1) {
      const latlngs: L.LatLngExpression[] = routePath.map((p) => [p.lat, p.lng]);
      const polyline = L.polyline(latlngs, {
        color: '#4285f4',
        weight: 4,
        opacity: 0.8,
        dashArray: '8, 8',
      }).addTo(map);
      polylineRef.current = polyline;
    }
  }, [routePath]);

  // Update random walk radius circle.
  // Re-uses the existing Circle (setLatLng/setRadius) instead of remove+recreate
  // because currentPosition ticks every 1s during navigation — recreating a
  // Leaflet layer per tick is wasteful and causes a brief redraw flash.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const shouldShow = randomWalkRadius && randomWalkRadius > 0 && currentPosition;

    if (!shouldShow) {
      if (radiusCircleRef.current) {
        radiusCircleRef.current.remove();
        radiusCircleRef.current = null;
      }
      return;
    }

    const center: L.LatLngExpression = [currentPosition.lat, currentPosition.lng];
    if (radiusCircleRef.current) {
      radiusCircleRef.current.setLatLng(center);
      radiusCircleRef.current.setRadius(randomWalkRadius);
    } else {
      radiusCircleRef.current = L.circle(center, {
        radius: randomWalkRadius,
        color: '#4285f4',
        weight: 2,
        opacity: 0.6,
        fillColor: '#4285f4',
        fillOpacity: 0.08,
        dashArray: '6, 6',
      }).addTo(map);
    }
  }, [randomWalkRadius, currentPosition]);

  // Cooldown circle: shows jump distance as an orange dashed ring.
  // Same setLatLng/setRadius pattern — cooldownCircle.remainingSeconds ticks
  // every 1s, so recreating the Circle per tick was 1 layer churn/sec for the
  // entire cooldown duration (up to 2 hours).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!cooldownCircle || cooldownCircle.distanceKm <= 1) {
      if (cooldownCircleRef.current) {
        cooldownCircleRef.current.remove();
        cooldownCircleRef.current = null;
      }
      return;
    }

    const center: L.LatLngExpression = [cooldownCircle.lat, cooldownCircle.lng];
    const radiusM = cooldownCircle.distanceKm * 1000;
    const mins = Math.ceil(cooldownCircle.remainingSeconds / 60);
    const tooltipHtml = `⏱ 跳點 ${cooldownCircle.distanceKm.toFixed(1)} km → 冷卻 ${mins} 分`;

    if (cooldownCircleRef.current) {
      cooldownCircleRef.current.setLatLng(center);
      cooldownCircleRef.current.setRadius(radiusM);
      cooldownCircleRef.current.setTooltipContent(tooltipHtml);
    } else {
      const circle = L.circle(center, {
        radius: radiusM,
        color: '#f59e0b',
        weight: 1.5,
        opacity: 0.7,
        fillColor: '#f59e0b',
        fillOpacity: 0.04,
        dashArray: '8, 6',
      }).addTo(map);
      circle.bindTooltip(tooltipHtml, { direction: 'top', sticky: true });
      cooldownCircleRef.current = circle;
    }
  }, [cooldownCircle]);

  // Bookmark markers — render the saved bookmarks on the map so users can
  // pick a destination visually instead of scrolling the Library list.
  // Click a marker → teleport (same as clicking it in the list).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    bookmarkMarkersRef.current.forEach(m => m.remove());
    bookmarkMarkersRef.current = [];

    if (!bookmarkMarkers || bookmarkMarkers.length === 0 || !showBookmarkLayer) return;

    // 搜尋：比對 name / category（大小寫不敏感）。空字串視為顯示全部。
    const q = bookmarkSearch.trim().toLowerCase();
    const visible = q
      ? bookmarkMarkers.filter(bm =>
          bm.name.toLowerCase().includes(q) ||
          (bm.category ?? '').toLowerCase().includes(q)
        )
      : bookmarkMarkers;

    visible.forEach(bm => {
      const icon = L.divIcon({
        className: 'bookmark-map-marker',
        html: `<div style="
          background:#f59e0b;border:2px solid #fff;border-radius:50% 50% 50% 0;
          width:20px;height:20px;transform:rotate(-45deg);
          box-shadow:0 2px 4px rgba(0,0,0,0.4);display:flex;align-items:center;
          justify-content:center;">
          <span style="transform:rotate(45deg);font-size:11px;color:#fff;">★</span>
        </div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 18],
      });
      const marker = L.marker([bm.lat, bm.lng], { icon });
      marker.bindTooltip(
        `<div style="text-align:center;line-height:1.5;min-width:100px">
          <div style="font-weight:600;font-size:12px;color:#fbbf24">★ ${bm.name}</div>
          ${bm.category ? `<div style="font-size:10px;color:#94a3b8">${bm.category}</div>` : ''}
          <div style="font-size:10px;color:#fbbf24;margin-top:2px">點擊傳送</div>
        </div>`,
        { direction: 'top', offset: [0, -12] }
      );
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        onTeleportRef.current(bm.lat, bm.lng);
      });
      marker.addTo(map);
      bookmarkMarkersRef.current.push(marker);
    });
  }, [bookmarkMarkers, showBookmarkLayer, bookmarkSearch]);

  // Close context menu on outside click
  useEffect(() => {
    const handler = () => closeContextMenu();
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [closeContextMenu]);

  const recenter = useCallback(() => {
    const map = mapRef.current;
    if (!map || !currentPosition) return;
    map.setView([currentPosition.lat, currentPosition.lng], Math.max(map.getZoom(), 16), {
      animate: true,
    });
  }, [currentPosition]);

  return (
    <div className="map-container" style={{ position: 'relative', flex: 1 }}>
      <div
        ref={mapContainerRef}
        style={{ width: '100%', height: '100%', cursor: drawingMode ? 'crosshair' : undefined }}
      />
      {/* Drawing mode banner */}
      {drawingMode && (
        <div style={{
          position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
          zIndex: 900, background: 'rgba(255,152,0,0.92)', color: '#1a1a1a',
          padding: '5px 14px', borderRadius: 14, fontSize: 12, fontWeight: 600,
          pointerEvents: 'none', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        }}>
          ✏️ 繪圖模式：點擊地圖新增航點
        </div>
      )}

      {/* Bookmark layer toggle + 搜尋 — 放在地圖右上，避開右下那一堆按鈕。
          圖層關閉時只顯示星星 pill；開啟時一起顯示搜尋框與過濾後的清單。 */}
      {bookmarkMarkers.length > 0 && (
        <div
          style={{
            position: 'absolute', top: 10, right: 10, zIndex: 950,
            display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6,
            maxWidth: 260,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {showBookmarkLayer && (
              <input
                type="text"
                value={bookmarkSearch}
                onChange={(e) => setBookmarkSearch(e.target.value)}
                placeholder="搜尋收藏…"
                style={{
                  height: 34, width: 180, padding: '0 10px', borderRadius: 8,
                  background: 'rgba(30,30,36,0.92)', color: '#fbbf24',
                  border: '1px solid #555', fontSize: 13,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
                  outline: 'none',
                }}
              />
            )}
            <button
              onClick={() => setShowBookmarkLayer(v => !v)}
              title={showBookmarkLayer ? `隱藏 ${bookmarkMarkers.length} 個收藏標記` : `顯示 ${bookmarkMarkers.length} 個收藏標記`}
              style={{
                height: 34, minWidth: 56, padding: '0 10px', borderRadius: 8, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 5,
                background: showBookmarkLayer ? 'rgba(245,158,11,0.92)' : 'rgba(30,30,36,0.92)',
                border: `1px solid ${showBookmarkLayer ? '#fbbf24' : '#555'}`,
                color: showBookmarkLayer ? '#1a1a1a' : '#fbbf24',
                fontWeight: 600,
                boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
                transition: 'all 0.15s',
              }}
            >
              <span style={{ fontSize: 16, lineHeight: 1 }}>★</span>
              <span style={{ fontSize: 12, lineHeight: 1 }}>
                {bookmarkMarkers.length}
              </span>
            </button>
          </div>

          {/* 搜尋結果清單：當有輸入字串時顯示符合的前 10 筆，點一下直接飛過去+傳送 */}
          {showBookmarkLayer && bookmarkSearch.trim() !== '' && (() => {
            const q = bookmarkSearch.trim().toLowerCase();
            const hits = bookmarkMarkers.filter(bm =>
              bm.name.toLowerCase().includes(q) ||
              (bm.category ?? '').toLowerCase().includes(q)
            ).slice(0, 10);
            return (
              <div style={{
                background: 'rgba(30,30,36,0.96)', border: '1px solid #555', borderRadius: 8,
                maxHeight: 260, overflowY: 'auto', minWidth: 200, width: '100%',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              }}>
                {hits.length === 0 ? (
                  <div style={{ padding: '10px 12px', color: '#94a3b8', fontSize: 12 }}>
                    找不到符合的收藏
                  </div>
                ) : (
                  hits.map((bm, i) => (
                    <div
                      key={bm.id ?? `${bm.lat},${bm.lng},${i}`}
                      onClick={() => {
                        const map = mapRef.current;
                        if (map) map.setView([bm.lat, bm.lng], Math.max(map.getZoom(), 16), { animate: true });
                        onTeleportRef.current(bm.lat, bm.lng);
                        setBookmarkSearch('');
                      }}
                      style={{
                        padding: '8px 12px', cursor: 'pointer', fontSize: 12,
                        color: '#fbbf24', borderBottom: '1px solid #3a3a42',
                        display: 'flex', flexDirection: 'column', gap: 2,
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#3a3a42')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <span style={{ fontWeight: 600 }}>★ {bm.name}</span>
                      {bm.category && (
                        <span style={{ fontSize: 10, color: '#94a3b8' }}>{bm.category}</span>
                      )}
                    </div>
                  ))
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Recenter on user position */}
      <button
        className={`map-btn map-btn--recenter${currentPosition ? '' : ' map-btn--disabled'}`}
        onClick={recenter}
        disabled={!currentPosition}
        title={t('map.recenter')}
        style={{ color: currentPosition ? 'var(--accent-blue)' : undefined }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <line x1="12" y1="2" x2="12" y2="5" />
          <line x1="12" y1="19" x2="12" y2="22" />
          <line x1="2" y1="12" x2="5" y2="12" />
          <line x1="19" y1="12" x2="22" y2="12" />
        </svg>
      </button>

      {contextMenu.visible && (
        <div
          className="context-menu"
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 10000,
            background: '#2a2a2e',
            border: '1px solid #444',
            borderRadius: 6,
            padding: '4px 0',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            minWidth: 180,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {deviceConnected ? (
            <>
              <div
                className="context-menu-item"
                style={contextMenuItemStyle}
                onMouseEnter={highlightItem}
                onMouseLeave={unhighlightItem}
                onClick={() => {
                  if (clickMarkerRef.current) { clickMarkerRef.current.remove(); clickMarkerRef.current = null; }
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
                  if (clickMarkerRef.current) { clickMarkerRef.current.remove(); clickMarkerRef.current = null; }
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
              style={{
                ...contextMenuItemStyle,
                color: '#ff6b6b',
                cursor: 'not-allowed',
                opacity: 0.75,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
                <circle cx="12" cy="12" r="10" />
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
              {t('map.device_disconnected')}
            </div>
          )}
          {showWaypointOption && onAddWaypoint && (
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
          )}
          <div
            style={{ height: 1, background: '#444', margin: '4px 0' }}
          />
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
