// Appearance settings: colour theme, glass style, motion.
//
// The theme table below is the single source of truth. applyAppearance()
// writes the theme's values onto <html> as CSS custom properties and sets
// data-glass / data-motion, which styles.css keys its tokens off.
//
// Two states exist on purpose: what is *saved* (localStorage, survives a
// restart) and what is *applied* (what the window currently shows). The
// settings page previews by applying without saving, then either saves or
// reverts.

export type ThemeId = 'ocean' | 'aurora' | 'forest' | 'sunset' | 'sakura' | 'graphite';
export type GlassMode = 'liquid' | 'frosted' | 'solid';
export interface Appearance { theme: ThemeId; glass: GlassMode; motion: boolean }

export interface ThemeDef {
  id: ThemeId;
  // Bare "R, G, B" so CSS can do rgba(var(--accent-rgb), a).
  accent: string;
  // Second hue for gradients and the ambient glow behind the sidebar.
  accent2: string;
  // Base tone of panels; kept very dark, only the hue moves.
  panel: string;
  bg: string;
}

export const THEMES: ReadonlyArray<ThemeDef> = [
  { id: 'ocean',    accent: '108, 140, 255', accent2: '150, 120, 255', panel: '20, 23, 36', bg: '#0a0c12' },
  { id: 'aurora',   accent: '160, 124, 255', accent2: '88, 196, 255',  panel: '25, 21, 40', bg: '#0c0a14' },
  { id: 'forest',   accent: '38, 176, 134',  accent2: '120, 208, 96',  panel: '16, 26, 27', bg: '#080d0d' },
  { id: 'sunset',   accent: '240, 124, 64',  accent2: '255, 94, 138',  panel: '31, 23, 22', bg: '#100b0a' },
  { id: 'sakura',   accent: '236, 98, 152',  accent2: '176, 132, 255', panel: '31, 21, 30', bg: '#100a0e' },
  { id: 'graphite', accent: '132, 146, 172', accent2: '110, 120, 140', panel: '24, 25, 29', bg: '#0b0b0d' },
];

export const DEFAULT_APPEARANCE: Appearance = { theme: 'ocean', glass: 'liquid', motion: true };

const KEY = 'locwarp.appearance';

export function themeDef(id: ThemeId): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

function sanitize(raw: unknown): Appearance {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Appearance>;
  return {
    theme: THEMES.some((t) => t.id === r.theme) ? (r.theme as ThemeId) : DEFAULT_APPEARANCE.theme,
    glass: r.glass === 'frosted' || r.glass === 'solid' || r.glass === 'liquid' ? r.glass : DEFAULT_APPEARANCE.glass,
    motion: typeof r.motion === 'boolean' ? r.motion : DEFAULT_APPEARANCE.motion,
  };
}

export function loadSavedAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitize(JSON.parse(raw));
  } catch { /* ignore */ }
  return { ...DEFAULT_APPEARANCE };
}

export function applyAppearance(a: Appearance): void {
  const root = document.documentElement;
  const th = themeDef(a.theme);
  root.style.setProperty('--accent-rgb', th.accent);
  root.style.setProperty('--accent-2-rgb', th.accent2);
  root.style.setProperty('--panel-rgb', th.panel);
  root.style.setProperty('--bg-primary', th.bg);
  root.dataset.theme = a.theme;
  root.dataset.glass = a.glass;
  root.dataset.motion = a.motion ? 'on' : 'off';
}

export function saveAppearance(a: Appearance): void {
  const clean = sanitize(a);
  try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch { /* ignore */ }
  applyAppearance(clean);
}

export function sameAppearance(a: Appearance, b: Appearance): boolean {
  return a.theme === b.theme && a.glass === b.glass && a.motion === b.motion;
}
