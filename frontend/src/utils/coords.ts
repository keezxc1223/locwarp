// Shared coordinate-parsing helpers. Used by the coord-fly input and the
// bulk-paste route / bookmark dialogs. Goal: scrape the first valid
// lat/lng pair out of arbitrary text so users can paste lines like
// "(-33.41902, -70.70187) 一般火" or "#3\n35.018, 135.584" without
// hand-cleaning them first.

// Brackets / quotes / degree symbols are turned into spaces so they can't
// glue numbers to surrounding labels and so leftover-text extraction (for
// the bookmark "name" field) doesn't have to special-case them.
const DECORATION_RE = /[()\[\]{}（）【】「」『』"'`°]/g;

// Decimal-required main pattern. The lookarounds (?<![\d.]) / (?![\d.])
// stop us from chopping a longer number like "12.345" mid-way and keep us
// from grabbing the "3" out of a label like "#3" then pairing it with the
// next number on the line.
const COORD_DECIMAL_RE = /(?<![\d.])(-?\d+\.\d+)\s*[,;\s]+\s*(-?\d+\.\d+)(?![\d.])/g;

// Fallback for users who type integer-only coords like "25, 121". Only
// used when the entire trimmed input is just two numbers, so a stray
// integer label can never be misread as a coord here.
const COORD_INTEGER_RE = /^(-?\d+(?:\.\d+)?)\s*[,;\s]+\s*(-?\d+(?:\.\d+)?)$/;

function inRange(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

// Returns the first valid lat/lng pair found anywhere in `raw`, or null.
// Any other text in the input is ignored — labels, prefixes ("#3", "OK"),
// trailing notes ("一般火"), brackets, etc. all get discarded.
export function parseCoord(raw: string): { lat: number; lng: number } | null {
  const cleaned = raw.replace(DECORATION_RE, ' ');
  COORD_DECIMAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COORD_DECIMAL_RE.exec(cleaned)) !== null) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }
  const fb = cleaned.trim().match(COORD_INTEGER_RE);
  if (fb) {
    const lat = parseFloat(fb[1]);
    const lng = parseFloat(fb[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }
  return null;
}
