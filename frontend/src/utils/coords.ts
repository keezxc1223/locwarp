import { useSyncExternalStore } from 'react';

// Shared coordinate helpers. Used by the coord-fly input, the bulk-paste
// route / bookmark dialogs, and every place that shows or copies a
// coordinate. Parsing goal: scrape the first valid pair out of arbitrary
// text so users can paste lines like "(-33.41902, -70.70187) 一般火" or
// "#3\n35.018, 135.584" without hand-cleaning them first.

// Brackets / quotes / degree symbols are turned into spaces so they can't
// glue numbers to surrounding labels and so leftover-text extraction (for
// the bookmark "name" field) doesn't have to special-case them.
const DECORATION_RE = /[()\[\]{}（）【】「」『』"'`°]/g;

// Decimal-required main pattern. The lookarounds (?<![\d.]) / (?![\d.])
// stop us from chopping a longer number like "12.345" mid-way and keep us
// from grabbing the "3" out of a label like "#3" then pairing it with the
// next number on the line. The `[^-\d.]+` between the two numbers means
// any non-numeric junk works as a separator: `, ` / `,lng=` / ` B ` /
// `:` / arbitrary CJK characters all qualify. `-` is intentionally
// excluded so a negative sign on the second number stays attached.
const COORD_DECIMAL_RE = /(?<![\d.])(-?\d+\.\d+)[^-\d.]+(-?\d+\.\d+)(?![\d.])/g;

// Fallback for users who type integer-only coords like "25, 121". Only
// used when the entire trimmed input is just two numbers, so a stray
// integer label can never be misread as a coord here.
const COORD_INTEGER_RE = /^(-?\d+(?:\.\d+)?)\s*[,;\s]+\s*(-?\d+(?:\.\d+)?)$/;

function inRange(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

// ---------------------------------------------------------------------------
// Coordinate system + axis order settings (issue #50)
//
// Everything inside the app (device GPS, map, saved coords, routes, GPX /
// JSON files) stays WGS84 with lat first. These two settings only affect
// coordinate TEXT crossing the UI boundary: what is shown, what is copied,
// and how typed / pasted text is interpreted.
// ---------------------------------------------------------------------------

export type CoordDatum = 'wgs84' | 'gcj02' | 'bd09';
export type CoordOrder = 'latlng' | 'lnglat';
export interface CoordSettings { datum: CoordDatum; order: CoordOrder }

const DATUM_KEY = 'locwarp.coord.datum';
const ORDER_KEY = 'locwarp.coord.order';

function loadSettings(): CoordSettings {
  let datum: CoordDatum = 'wgs84';
  let order: CoordOrder = 'latlng';
  try {
    const d = localStorage.getItem(DATUM_KEY);
    if (d === 'gcj02' || d === 'bd09') datum = d;
    if (localStorage.getItem(ORDER_KEY) === 'lnglat') order = 'lnglat';
  } catch { /* ignore */ }
  return { datum, order };
}

let settings: CoordSettings = loadSettings();
const listeners = new Set<() => void>();

export function getCoordSettings(): CoordSettings { return settings; }

export function setCoordSettings(patch: Partial<CoordSettings>): void {
  settings = { ...settings, ...patch };
  try {
    localStorage.setItem(DATUM_KEY, settings.datum);
    localStorage.setItem(ORDER_KEY, settings.order);
  } catch { /* ignore */ }
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Components that render coordinate text call this so they re-render when
// the user changes the setting. formatCoord / parseCoord read the module
// state directly, so the return value is only needed by the settings UI.
export function useCoordSettings(): CoordSettings {
  return useSyncExternalStore(subscribe, getCoordSettings, getCoordSettings);
}

export function isDefaultCoordSettings(): boolean {
  return settings.datum === 'wgs84' && settings.order === 'latlng';
}

export const DATUM_LABEL: Record<CoordDatum, string> = {
  wgs84: 'WGS84',
  gcj02: 'GCJ02',
  bd09: 'BD09',
};

// --- Datum math -------------------------------------------------------------

const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;
const X_PI = (Math.PI * 3000.0) / 180.0;

// The rectangle every public GCJ-02 implementation uses as its "inside
// China" test. It also covers Korea, western Japan, Taiwan, Vietnam,
// Mongolia and more, so it is only used here as a cheap pre-check.
function inChinaRect(lat: number, lng: number): boolean {
  return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
}

// Coarse outline of mainland China + Hong Kong + Macau + Hainan as
// [lng, lat], clockwise from the north-east. Amap / Baidu only offset
// coordinates inside this area; neighbouring countries and Taiwan are
// served unshifted, which the plain rectangle gets wrong by 400 m or more.
// Accuracy is a few tens of km, so places right on a land border may land
// on the wrong side. The Taiwan Strait edge is shared with inTaiwan().
const CHINA_OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [123.5, 53.6], [126.0, 52.9], [127.6, 50.3], [130.9, 47.8], [135.2, 48.5],
  [134.7, 47.6], [133.5, 45.5], [131.9, 45.3], [131.1, 44.7], [131.3, 43.4],
  [130.6, 42.4], [128.1, 41.9], [126.9, 41.75], [126.0, 40.9], [124.4, 40.05],
  [124.3, 39.8], [123.0, 37.5], [123.0, 31.0], [122.5, 28.0], [120.6, 25.7],
  [119.2, 24.2], [119.2, 22.0], [114.5, 21.5], [111.5, 18.0], [109.0, 17.8],
  [108.0, 18.5], [108.0, 21.5], [106.6, 21.95], [106.5, 22.9], [105.3, 23.4],
  [104.8, 22.8], [103.9, 22.5], [102.1, 22.4], [101.7, 21.1], [101.2, 21.1],
  [100.1, 21.5], [99.2, 22.1], [98.9, 23.2], [97.8, 23.9], [97.5, 24.5],
  [98.7, 25.9], [98.7, 27.5], [97.3, 28.2], [95.0, 29.2], [92.0, 27.8],
  [90.0, 28.3], [88.9, 27.3], [88.1, 27.9], [86.0, 27.9], [85.3, 28.3],
  [83.9, 29.3], [81.2, 30.2], [78.7, 31.5], [79.0, 32.5], [78.4, 32.6],
  [77.8, 35.5], [75.4, 36.9], [74.6, 37.2], [73.4, 39.4], [74.0, 40.1],
  [75.4, 40.6], [78.4, 41.4], [80.2, 42.1], [80.2, 43.0], [80.4, 44.6],
  [82.5, 45.3], [82.9, 46.7], [85.5, 47.1], [85.7, 48.4], [87.8, 49.2],
  [90.0, 47.9], [91.0, 45.2], [93.5, 44.9], [95.4, 44.3], [96.4, 42.7],
  [101.0, 42.6], [105.0, 41.6], [109.5, 42.5], [111.9, 43.7], [114.0, 44.9],
  [115.5, 45.4], [116.6, 46.3], [119.9, 46.8], [118.5, 47.9], [115.5, 47.9],
  [116.0, 48.8], [116.7, 49.85], [119.3, 50.6], [120.1, 51.7], [120.0, 52.6],
  [121.2, 53.3],
];

function inChina(lat: number, lng: number): boolean {
  if (!inChinaRect(lat, lng)) return false;
  let inside = false;
  const n = CHINA_OUTLINE.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = CHINA_OUTLINE[i];
    const [xj, yj] = CHINA_OUTLINE[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Taiwan main island + Penghu + Lanyu / Green Island. The slanted
// north-west edge keeps Pingtan / Nanri (Fujian coast) outside. Kinmen and
// Matsu sit against the mainland coast and fall on the mainland side.
function inTaiwan(lat: number, lng: number): boolean {
  if (lat < 21.7 || lat > 25.7 || lng < 119.2 || lng > 122.3) return false;
  if (lng < 120.6) {
    const edgeLat = 24.2 + ((lng - 119.2) / 1.4) * 1.5;
    if (lat > edgeLat) return false;
  }
  return true;
}

type LL = { lat: number; lng: number };

function wgsToGcjRaw(lat: number, lng: number): LL {
  const x = lng - 105.0;
  const y = lat - 35.0;
  const PI = Math.PI;
  let dLat = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  dLat += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  dLat += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  dLat += ((160.0 * Math.sin((y / 12.0) * PI) + 320.0 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  let dLng = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  dLng += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  dLng += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  dLng += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

function gcjToBd(lat: number, lng: number): LL {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI);
  return { lat: z * Math.sin(theta) + 0.006, lng: z * Math.cos(theta) + 0.0065 };
}

// WGS84 -> selected datum.
//   GCJ02: offset inside mainland China / HK / Macau only.
//   BD09:  Baidu's layer on top of GCJ02 there; in Taiwan (which Baidu also
//          serves as BD09) the layer is applied directly to WGS84.
// Everywhere else both equal WGS84.
export function fromWgs84(lat: number, lng: number, datum: CoordDatum = settings.datum): LL {
  if (datum === 'wgs84') return { lat, lng };
  if (inChina(lat, lng)) {
    const g = wgsToGcjRaw(lat, lng);
    return datum === 'gcj02' ? g : gcjToBd(g.lat, g.lng);
  }
  if (datum === 'bd09' && inTaiwan(lat, lng)) return gcjToBd(lat, lng);
  return { lat, lng };
}

// Selected datum -> WGS84. The forward transforms have no closed-form
// inverse, so iterate on the residual; converges to well under 1e-7 deg
// (about 1 cm) in a few rounds.
export function toWgs84(lat: number, lng: number, datum: CoordDatum = settings.datum): LL {
  if (datum === 'wgs84') return { lat, lng };
  let wLat = lat;
  let wLng = lng;
  for (let i = 0; i < 12; i++) {
    const f = fromWgs84(wLat, wLng, datum);
    const eLat = f.lat - lat;
    const eLng = f.lng - lng;
    wLat -= eLat;
    wLng -= eLng;
    if (Math.abs(eLat) < 1e-9 && Math.abs(eLng) < 1e-9) break;
  }
  // Text sitting right on a region edge can oscillate between "shifted"
  // and "unshifted"; if the round trip does not land back on the input,
  // the point is on the unshifted side.
  const check = fromWgs84(wLat, wLng, datum);
  if (Math.abs(check.lat - lat) > 1e-6 || Math.abs(check.lng - lng) > 1e-6) {
    return { lat, lng };
  }
  return { lat: wLat, lng: wLng };
}

// --- Formatting -------------------------------------------------------------

// Internal WGS84 lat/lng -> the two numbers in the user's datum and axis
// order, each tagged with which axis it is.
export function coordParts(lat: number, lng: number, digits = 6): Array<{ axis: 'lat' | 'lng'; text: string }> {
  const c = fromWgs84(lat, lng);
  const la = { axis: 'lat' as const, text: c.lat.toFixed(digits) };
  const ln = { axis: 'lng' as const, text: c.lng.toFixed(digits) };
  return settings.order === 'lnglat' ? [ln, la] : [la, ln];
}

// Internal WGS84 lat/lng -> text in the user's datum and axis order.
export function formatCoord(lat: number, lng: number, digits = 6): string {
  const [a, b] = coordParts(lat, lng, digits);
  return `${a.text}, ${b.text}`;
}

// --- Parsing ----------------------------------------------------------------

// Two numbers in text order -> internal WGS84 lat/lng, honouring the axis
// order and datum settings. If the configured order is impossible (a value
// beyond +-90 where a latitude is expected) but the swapped reading is
// valid, the swapped reading wins.
function resolvePair(a: number, b: number): LL | null {
  let lat = settings.order === 'lnglat' ? b : a;
  let lng = settings.order === 'lnglat' ? a : b;
  if (!inRange(lat, lng)) {
    if (!inRange(lng, lat)) return null;
    [lat, lng] = [lng, lat];
  }
  const w = toWgs84(lat, lng);
  return inRange(w.lat, w.lng) ? w : null;
}

// Returns the first valid coordinate found anywhere in `raw` as internal
// WGS84 lat/lng, or null. Any other text in the input is ignored: labels,
// prefixes ("#3", "OK"), trailing notes ("一般火"), brackets, etc.
export function parseCoord(raw: string): { lat: number; lng: number } | null {
  const cleaned = raw.replace(DECORATION_RE, ' ');
  COORD_DECIMAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COORD_DECIMAL_RE.exec(cleaned)) !== null) {
    const r = resolvePair(parseFloat(m[1]), parseFloat(m[2]));
    if (r) return r;
  }
  const fb = cleaned.trim().match(COORD_INTEGER_RE);
  if (fb) {
    const r = resolvePair(parseFloat(fb[1]), parseFloat(fb[2]));
    if (r) return r;
  }
  return null;
}

// Short label for the active non-default format, e.g. "GCJ02 · 經度, 緯度".
// Shown next to coordinate text so the axis order is never ambiguous.
export function coordBadge(t: (key: any) => string): string {
  const lat = t('coord.lat');
  const lng = t('coord.lng');
  const axes = settings.order === 'lnglat' ? `${lng}, ${lat}` : `${lat}, ${lng}`;
  return `${DATUM_LABEL[settings.datum]} · ${axes}`;
}

// One-line reminder of the active format for paste dialogs; empty string
// while the defaults are in use, so callers can append it unconditionally.
export function coordInputHint(t: (key: any) => string): string {
  return isDefaultCoordSettings() ? '' : `
${t('coord.input_as')} ${coordBadge(t)}`;
}
