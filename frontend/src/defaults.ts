// Initial values for the mushroom map layer: what a setting is when the
// user has never chosen one, and how a stored value is read back safely.
//
// Kept import-free so it can be loaded on its own.

export type PipiKindKey = 'mushroom' | 'flower' | 'smoke';

export const INITIAL_PIPI_KINDS: Readonly<Record<PipiKindKey, boolean>> = {
  mushroom: true,
  flower: false,
  smoke: false,
};

/** 花的子篩選：只顯示彩帶花、顯示普花（GLOSSARY.md: 彩帶花、普花）。 */
export type PipiFlowerFilter = { ribbonOnly: boolean; showCommon: boolean };

export const INITIAL_PIPI_FLOWER_FILTER: Readonly<PipiFlowerFilter> = {
  ribbonOnly: false,
  showCommon: true,
};

/** 標記大小（GLOSSARY.md）：小、中、大三級。 */
export type PipiMarkerSize = 'small' | 'medium' | 'large';

export const INITIAL_PIPI_MARKER_SIZE: PipiMarkerSize = 'medium';

/**
 * Stored JSON object of boolean switches → a complete set of switches.
 *
 * @param storedJson raw localStorage value, or null when nothing was saved.
 * @param initial the 初始值 of every switch; its keys are the ones returned.
 * @returns a new object. Each key keeps its saved boolean; a key that is
 *   missing or not a boolean (or every key, when the value isn't a JSON
 *   object) takes its `initial` value.
 */
function resolveSwitches<K extends string>(storedJson: string | null, initial: { readonly [P in K]: boolean }): Record<K, boolean> {
  let raw: unknown = null;
  try { raw = JSON.parse(storedJson ?? 'null'); } catch { /* malformed → initial values */ }
  const saved = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<K, unknown>>;
  const out = {} as Record<K, boolean>;
  for (const k of Object.keys(initial) as K[]) {
    const v = saved[k];
    out[k] = typeof v === 'boolean' ? v : initial[k];
  }
  return out;
}

/** Stored `locwarp.pipi_kinds` JSON → point-kind filter, as {@link resolveSwitches} with INITIAL_PIPI_KINDS. */
export function resolvePipiKinds(storedJson: string | null): Record<PipiKindKey, boolean> {
  return resolveSwitches(storedJson, INITIAL_PIPI_KINDS);
}

/** Stored `locwarp.pipi_flower_filter` JSON → 花的子篩選, as {@link resolveSwitches} with INITIAL_PIPI_FLOWER_FILTER. */
export function resolvePipiFlowerFilter(storedJson: string | null): PipiFlowerFilter {
  return resolveSwitches(storedJson, INITIAL_PIPI_FLOWER_FILTER);
}

/** Stored `locwarp.pipi_marker_size` value → 標記大小; anything unrecognised gets the initial size. */
export function resolvePipiMarkerSize(stored: string | null): PipiMarkerSize {
  return stored === 'small' || stored === 'medium' || stored === 'large' ? stored : INITIAL_PIPI_MARKER_SIZE;
}

/**
 * Mushroom sub-filter. Sizes and types are stored as what to hide, so a
 * size or type the site adds later shows up by default instead of being
 * silently filtered out. `minMinutes` hides mushrooms about to end.
 */
export type PipiMushroomFilter = { hiddenSizes: string[]; hiddenNames: string[]; minMinutes: number };

export const INITIAL_PIPI_MUSHROOM_FILTER: Readonly<PipiMushroomFilter> = {
  hiddenSizes: [],
  hiddenNames: [],
  minMinutes: 0,
};

/** Stored `locwarp.pipi_mushroom_filter` JSON -> a complete, well-typed filter. */
export function resolvePipiMushroomFilter(storedJson: string | null): PipiMushroomFilter {
  let raw: unknown = null;
  try { raw = JSON.parse(storedJson ?? 'null'); } catch { /* malformed -> initial values */ }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 200) : []);
  const m = typeof o.minMinutes === 'number' && Number.isFinite(o.minMinutes) ? Math.max(0, Math.min(600, Math.floor(o.minMinutes))) : 0;
  return { hiddenSizes: strings(o.hiddenSizes), hiddenNames: strings(o.hiddenNames), minMinutes: m };
}
