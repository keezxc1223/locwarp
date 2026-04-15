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

import type { DeviceRuntime, RuntimesMap } from '../hooks/useSimulation';
import type { DeviceInfo } from '../hooks/useDevice';

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
  onShowToast?: (msg: string) => void;
  // Group mode: when runtimes + devices are present and 2+ devices connected,
  // render per-device markers/polylines/circles. Single-device rendering is
  // still driven by the legacy currentPosition/destination/routePath props.
  runtimes?: RuntimesMap;
  devices?: DeviceInfo[];
}

const DEVICE_COLORS = ['#4285f4', '#ff9800'];
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
  randomWalkRadius,
  onMapClick,
  onTeleport,
  onNavigate,
  onAddBookmark,
  onAddWaypoint,
  showWaypointOption,
  deviceConnected = true,
  onShowToast,
  runtimes,
  devices,
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
  const waypointMarkersRef = useRef<L.Marker[]>([]);
  const polylineRef = useRef<L.Polyline | null>(null);
  // clickMarkerRef removed — left-click no longer drops a pin.
  const radiusCircleRef = useRef<L.Circle | null>(null);

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
      // Keep Leaflet's default control off so we can position our own
      // zoom control below the EtaBar on the left (default top-left
      // would collide with the overlay).
      zoomControl: false,
    });
    const zoomCtrl = L.control.zoom({ position: 'topleft' });
    zoomCtrl.addTo(map);
    // Nudge the whole topleft control cluster down so it sits below the
    // EtaBar instead of behind it.
    const topLeftEl = (map as any)._controlCorners?.topleft as HTMLElement | undefined;
    if (topLeftEl) {
      topLeftEl.style.marginTop = '56px';
    }

    // OSM Standard (Mapnik). Electron main hooks a compliant User-Agent
    // for these hosts (see electron/main.js), otherwise the tile.osm.org
    // endpoint returns HTTP 418 for the default Chromium UA.
    const osmLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
    // OSM France mirror — same Mapnik style, looser policy, used as a fallback
    // when the main tile server is rate-limited or regionally unreachable.
    const osmFrLayer = L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
      subdomains: 'abc', maxZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.fr/">OSM France</a>',
    });
    osmLayer.on('tileerror', () => {
      if (!map.hasLayer(osmFrLayer)) {
        map.removeLayer(osmLayer);
        osmFrLayer.addTo(map);
      }
    });
    osmLayer.addTo(map);

    // Left-click on the map dismisses any open context menu.
    // If the parent wires `onMapClick` (currently used by the "left-click
    // to add waypoint" toggle in Loop / MultiStop modes), forward the
    // coordinates there too.
    map.on('click', (e: L.LeafletMouseEvent) => {
      closeContextMenu();
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
  }, [currentPosition, dualMode]);

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
      // index 0 is the implicit start point; show it as "S" in green so the
      // map matches the side panel ("起點 / Start"), and number the rest 1..N.
      const isStart = wp.index === 0;
      const label = isStart ? 'S' : String(wp.index);
      const fillTop = isStart ? '#66bb6a' : '#ffb74d';
      const fillBot = isStart ? '#43a047' : '#ff9800';
      const textFill = isStart ? '#1b5e20' : '#e65100';
      const wpIcon = L.divIcon({
        className: 'waypoint-marker',
        html: `<svg width="32" height="44" viewBox="0 0 32 44">
          <defs>
            <filter id="wpShadow${wp.index}" x="-20%" y="-10%" width="140%" height="130%">
              <feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#000" flood-opacity="0.35"/>
            </filter>
            <linearGradient id="wpGrad${wp.index}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="${fillTop}"/>
              <stop offset="100%" stop-color="${fillBot}"/>
            </linearGradient>
          </defs>
          <ellipse cx="16" cy="41" rx="5" ry="1.8" fill="#000" opacity="0.15"/>
          <path d="M16 2C8.8 2 3 7.8 3 15c0 10 13 26 13 26s13-16 13-26C29 7.8 23.2 2 16 2z"
                fill="url(#wpGrad${wp.index})" filter="url(#wpShadow${wp.index})"/>
          <circle cx="16" cy="15" r="8" fill="#ffffff" opacity="0.95"/>
          <text x="16" y="19" text-anchor="middle" fill="${textFill}" font-size="12" font-weight="700" font-family="system-ui">${label}</text>
        </svg>`,
        iconSize: [32, 44],
        iconAnchor: [16, 41],
      });

      const marker = L.marker([wp.lat, wp.lng], { icon: wpIcon }).addTo(map);
      marker.bindTooltip(
        isStart ? tRef.current('panel.waypoint_start') : tRef.current('panel.waypoint_num', { n: wp.index }),
        { direction: 'top', offset: [0, -14] },
      );
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

    if (dualMode) return;

    if (routePath.length > 1) {
      const latlngs: L.LatLngExpression[] = routePath.map((p) => [p.lat, p.lng]);
      const polyline = L.polyline(latlngs, {
        color: '#4285f4',
        weight: 4,
        opacity: 0.85,
      }).addTo(map);
      polylineRef.current = polyline;
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

    // Draw circle when radius is set and we have a position
    if (randomWalkRadius && randomWalkRadius > 0 && currentPosition) {
      const circle = L.circle(
        [currentPosition.lat, currentPosition.lng],
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
  }, [randomWalkRadius, currentPosition, dualMode]);

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

  const recenter = useCallback(() => {
    const map = mapRef.current;
    if (!map || !currentPosition) return;
    map.setView([currentPosition.lat, currentPosition.lng], Math.max(map.getZoom(), 16), {
      animate: true,
    });
  }, [currentPosition]);

  // Coordinate-input overlay (replaces the sidebar's two-field coord input).
  // Accepts any of: "25.04, 121.51", "25.04,121.51", or "25.04 121.51".
  const [coordInput, setCoordInput] = useState('');
  const parseCoordInput = (raw: string): { lat: number; lng: number } | null => {
    const m = raw.trim().match(/^(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
    return { lat, lng };
  };
  const submitCoordGo = () => {
    const parsed = parseCoordInput(coordInput);
    if (!parsed) {
      if (onShowToast) onShowToast(tRef.current('panel.coord_invalid'));
      return;
    }
    onTeleport(parsed.lat, parsed.lng);
    setCoordInput('');
  };

  return (
    <div className="map-container" style={{ position: 'relative', flex: 1 }}>
      <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />

      {/* Recenter on user position — left side, below the zoom control. */}
      <button
        onClick={recenter}
        disabled={!currentPosition}
        title={t('map.recenter')}
        style={{
          position: 'absolute',
          left: 10,
          top: 132,  // just below the (shifted-down) zoom control
          zIndex: 800,
          width: 30,
          height: 30,
          borderRadius: 4,
          border: '1px solid rgba(0,0,0,0.25)',
          background: currentPosition ? '#6c8cff' : '#3a4050',
          color: '#fff',
          cursor: currentPosition ? 'pointer' : 'not-allowed',
          boxShadow: '0 2px 6px rgba(0,0,0,0.35)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          opacity: currentPosition ? 1 : 0.55,
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <line x1="12" y1="2" x2="12" y2="5" />
          <line x1="12" y1="19" x2="12" y2="22" />
          <line x1="2" y1="12" x2="5" y2="12" />
          <line x1="19" y1="12" x2="22" y2="12" />
        </svg>
      </button>

      {/* Coord input overlay — bottom-left, above the map's status footer.
          Takes a single "lat, lng" string; Enter or the teleport button goes.
          Stop right-click propagation so the browser's native context menu
          (Paste / Copy) still works inside the input instead of the map's
          custom teleport menu popping up. */}
      <div
        onContextMenu={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        className="anim-fade-slide-up"
        style={{
          position: 'absolute', left: 12, bottom: 100, zIndex: 851,
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'rgba(26, 29, 39, 0.82)',
          backdropFilter: 'blur(14px) saturate(140%)',
          WebkitBackdropFilter: 'blur(14px) saturate(140%)',
          borderRadius: 10,
          padding: '7px 9px',
          boxShadow: '0 10px 32px rgba(12, 18, 40, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
          border: '1px solid rgba(108, 140, 255, 0.15)',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6c8cff" strokeWidth="2" style={{ flexShrink: 0 }}>
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
        <input
          type="text"
          value={coordInput}
          onChange={(e) => setCoordInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitCoordGo(); }}
          placeholder={tRef.current('panel.coord_placeholder')}
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
          onClick={submitCoordGo}
          disabled={!coordInput.trim() || !deviceConnected}
          title={t('map.teleport_here')}
          style={{
            background: !coordInput.trim() || !deviceConnected ? 'rgba(108,140,255,0.3)' : '#6c8cff',
            color: '#fff', border: 'none', borderRadius: 4,
            padding: '4px 10px', fontSize: 11, fontWeight: 600,
            cursor: !coordInput.trim() || !deviceConnected ? 'not-allowed' : 'pointer',
          }}
        >Go</button>
      </div>

      {contextMenu.visible && (
        <div
          className="context-menu anim-scale-in-tl"
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 1000,
            background: 'rgba(26, 29, 39, 0.95)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            border: '1px solid rgba(108, 140, 255, 0.18)',
            borderRadius: 10,
            padding: '4px 0',
            boxShadow: '0 10px 32px rgba(12, 18, 40, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.04) inset',
            minWidth: 180,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 1. Coordinates label — always visible at the top of the menu.
                Not clickable; shows the exact lat/lng of the right-click
                target directly instead of making the user click through. */}
          <div
            style={{
              padding: '8px 16px 6px',
              color: '#9ac0ff',
              fontSize: 12,
              fontFamily: 'monospace',
              display: 'flex',
              alignItems: 'center',
              userSelect: 'text',
              cursor: 'default',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8, opacity: 0.7 }}>
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
            {contextMenu.lat.toFixed(6)}, {contextMenu.lng.toFixed(6)}
          </div>
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
              const txt = `${contextMenu.lat.toFixed(6)}, ${contextMenu.lng.toFixed(6)}`;
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
