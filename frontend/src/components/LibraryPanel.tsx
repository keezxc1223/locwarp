import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { formatCoord, parseCoord, useCoordSettings, isDefaultCoordSettings, coordBadge } from '../utils/coords';
import { getBookmarkUiState, setBookmarkUiState, bookmarkGpxExportUrl } from '../services/api';
import '../library.css';

// The 收藏 window: saved coordinates and saved routes.
//
// Both tabs are the same list with the same gestures, so the list itself
// (LibraryList) knows nothing about bookmarks or routes. Each tab hands it
// an Adapter: groups, items, and what "activate / rename / move / delete"
// mean for that kind of item.
//
//   click a row            do the main thing (teleport / load route)
//   right-click or the "…" the same menu, everything else lives there
//   Ctrl-click, Shift-click start selecting; a bar appears for bulk actions
//   drag a row             onto a category to move it, onto a row to reorder
//
// There are no modes to switch into and no icon-only toolbar to decode.

// ── Shapes shared with App / ControlPanel ──────────────────────────────

interface Bookmark {
  id?: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  country_code?: string;
  created_at?: string;
  last_used_at?: string;
}

export interface LibraryBookmarkProps {
  bookmarks: Bookmark[];
  categories: string[];
  categoryColors?: Record<string, string>;
  currentPosition: { lat: number; lng: number } | null;
  onBookmarkClick: (bm: Bookmark) => void;
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
  onCategoryExportGpx?: (name: string) => void;
  onCategoriesExportGpxZip?: (names: string[]) => void;
  showOnMap?: boolean;
  onShowOnMapChange?: (v: boolean) => void;
  onImport?: (file: File) => Promise<void>;
  onBulkPaste?: () => void;
  exportUrl?: string;
}

export interface RouteCategory { id: string; name: string; color?: string; sort_order?: number }
export interface SavedRoute {
  id: string;
  name: string;
  waypoints: { lat: number; lng: number }[];
  profile?: string;
  category_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface LibraryRouteProps {
  routes: SavedRoute[];
  categories: RouteCategory[];
  currentWaypointsCount: number;
  onRouteLoad: (id: string) => void;
  onRouteSave: (name: string, opts?: { categoryId?: string; overwriteId?: string }) => void;
  onRouteRename: (id: string, name: string) => void;
  onRouteDelete: (id: string) => void;
  onRoutesBulkDelete?: (ids: string[]) => Promise<void> | void;
  onRouteMove?: (ids: string[], targetCategoryId: string) => Promise<void> | void;
  onRouteGpxExport?: (id: string) => void;
  onRouteGpxImport?: (file: File) => Promise<void> | void;
  onCategoryAdd?: (name: string, color?: string) => Promise<void> | void;
  onCategoryDelete?: (id: string) => Promise<void> | void;
  onCategoryRename?: (id: string, name: string) => Promise<void> | void;
  onCategoryRecolor?: (id: string, color: string) => Promise<void> | void;
  onCategoryReorder?: (orderedIds: string[]) => Promise<void> | void;
  onRouteReorder?: (categoryId: string, orderedRouteIds: string[]) => Promise<void> | void;
  routesExportAllUrl?: string;
  onRoutesImportAll?: (file: File) => Promise<void> | void;
}

export type LibraryTab = 'bookmarks' | 'routes';

interface LibraryPanelProps {
  tab: LibraryTab;
  onTabChange: (t: LibraryTab) => void;
  onClose: () => void;
  onDragStart: (e: React.MouseEvent) => void;
  bm: LibraryBookmarkProps;
  rt: LibraryRouteProps;
}

// ── Generic list model ─────────────────────────────────────────────────

interface Group { key: string; name: string; color: string; locked: boolean; virtual?: boolean }
interface Item { id: string; name: string; sub: string; group: string; flag?: string; haystack: string; raw: any }

type MenuEntry =
  | { kind: 'item'; label: string; icon?: IconName; danger?: boolean; disabled?: boolean; checked?: boolean; hint?: string; confirm?: string; onClick: () => void }
  | { kind: 'sep' }
  | { kind: 'label'; label: string }
  | { kind: 'colors'; value: string; onPick: (c: string) => void };

interface AddForm {
  title: string;
  caption: string;
  placeholder: string;
  blocked: string | null;
  submit: (name: string, groupKey: string) => 'done' | { conflict: Item[] };
  overwrite?: (name: string, targetId: string) => void;
  saveNew?: (name: string, groupKey: string) => void;
}

interface Adapter {
  groups: Group[];
  items: Item[];
  sortModes: { id: string; label: string }[];
  sort: string;
  setSort: (id: string) => void;
  compare: ((a: Item, b: Item) => number) | null; // null = manual order
  isCollapsed: (key: string) => boolean;
  toggleCollapsed: (key: string) => void;
  setAllCollapsed: (v: boolean) => void;
  activate: (item: Item) => void;
  activateLabel: string;
  activateIcon: IconName;
  rename: (item: Item, name: string) => void;
  remove: (items: Item[]) => void | Promise<void>;
  restore?: (items: Item[]) => void; // present = delete is undoable, no confirm
  move: (items: Item[], groupKey: string) => void;
  reorder?: (groupKey: string, ids: string[]) => void;
  reorderGroups?: (keys: string[]) => void;
  groupAdd: (name: string) => void;
  groupRename?: (g: Group, name: string) => void;
  groupRecolor?: (g: Group, color: string) => void;
  groupDelete: (g: Group) => void;
  itemMenu: (item: Item, ui: ListUi) => MenuEntry[];
  groupMenu: (g: Group, ui: ListUi) => MenuEntry[];
  addMenu: (ui: ListUi) => MenuEntry[];
  moreMenu: (ui: ListUi) => MenuEntry[];
  addForm: AddForm;
  notice: { text: string; action: string; onAction: () => void } | null;
  text: { search: string; empty: string; emptyHint: string; noResults: string; unit: string };
}

// What an adapter may ask the list to do (open a form, a dialog).
interface ListUi {
  openAddForm: () => void;
  openGroupForm: () => void;
  openDialog: (node: (close: () => void) => React.ReactNode) => void;
}

const COLOR_PALETTE = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#64748b',
];
const AUTO_COLLAPSE_THRESHOLD = 30;
const UNCATEGORIZED = 'Uncategorized';
const isDefaultCatName = (n: string) => n === 'Default' || n === '預設';

function hashColor(name: string): string {
  const fixed: Record<string, string> = { Default: '#4285f4', Home: '#4caf50', Work: '#ff9800', Favorites: '#e91e63', Custom: '#9c27b0' };
  if (fixed[name]) return fixed[name];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 60%, 55%)`;
}

function pickFile(accept: string, cb: (f: File) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.onchange = () => { const f = input.files?.[0]; if (f) cb(f); };
  input.click();
}

function download(url: string, filename?: string): void {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename; else a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
}

function usePersisted<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key) as T | null;
      if (raw && allowed.includes(raw)) return raw;
    } catch { /* ignore */ }
    return fallback;
  });
  return [v, (next: T) => { setV(next); try { localStorage.setItem(key, next); } catch { /* ignore */ } }];
}

// ── Icons ──────────────────────────────────────────────────────────────

const ICONS = {
  search: <><circle cx="11" cy="11" r="7" /><line x1="20" y1="20" x2="16.5" y2="16.5" /></>,
  plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
  more: <><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>,
  close: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
  chevron: <polyline points="9 6 15 12 9 18" />,
  pin: <><path d="M12 22s7-6.2 7-12a7 7 0 10-14 0c0 5.8 7 12 7 12z" /><circle cx="12" cy="10" r="2.5" /></>,
  route: <><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8.5 18H15a3 3 0 000-6H9a3 3 0 010-6h6.5" /></>,
  go: <polygon points="3 11 22 2 13 21 11 13 3 11" />,
  eye: <><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></>,
  down: <><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>,
  up: <><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></>,
  trash: <><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></>,
  check: <polyline points="5 12 10 17 19 7" />,
  select: <><rect x="3" y="3" width="18" height="18" rx="3" /><polyline points="8 12 11 15 16 9" /></>,
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  paste: <><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4h6v3H9z" /><line x1="9" y1="12" x2="15" y2="12" /><line x1="9" y1="16" x2="15" y2="16" /></>,
  sort: <><line x1="4" y1="7" x2="20" y2="7" /><line x1="7" y1="12" x2="17" y2="12" /><line x1="10" y1="17" x2="14" y2="17" /></>,
  expand: <><polyline points="7 9 12 4 17 9" /><polyline points="7 15 12 20 17 15" /></>,
  collapse: <><polyline points="7 4 12 9 17 4" /><polyline points="7 20 12 15 17 20" /></>,
  undo: <><polyline points="9 14 4 9 9 4" /><path d="M4 9h10a6 6 0 010 12h-3" /></>,
  save: <><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></>,
} as const;
type IconName = keyof typeof ICONS;

const Ico: React.FC<{ n: IconName; size?: number }> = ({ n, size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
    {ICONS[n]}
  </svg>
);

// ── Popup menu ─────────────────────────────────────────────────────────

interface MenuState { x: number; y: number; entries: MenuEntry[]; align?: 'right' }

const Menu: React.FC<{ state: MenuState; onClose: () => void }> = ({ state, onClose }) => {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [armed, setArmed] = useState<number | null>(null);

  // Measure once mounted, then clamp inside the window.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = state.align === 'right' ? state.x - r.width : state.x;
    let top = state.y;
    left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - r.height - 8));
    setPos({ left, top });
  }, [state]);

  useEffect(() => {
    const out = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const id = window.setTimeout(() => {
      document.addEventListener('pointerdown', out, true);
      document.addEventListener('keydown', esc, true);
      window.addEventListener('blur', onClose);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('pointerdown', out, true);
      document.removeEventListener('keydown', esc, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="lib-menu"
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos?.left ?? state.x, top: pos?.top ?? state.y, visibility: pos ? 'visible' : 'hidden' }}
    >
      {state.entries.map((en, i) => {
        if (en.kind === 'sep') return <div key={i} className="lib-menu-sep" />;
        if (en.kind === 'label') return <div key={i} className="lib-menu-label">{en.label}</div>;
        if (en.kind === 'colors') {
          return (
            <div key={i} className="lib-menu-colors">
              {COLOR_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={c.toLowerCase() === en.value.toLowerCase() ? 'on' : ''}
                  style={{ background: c }}
                  title={c}
                  onClick={() => { en.onPick(c); onClose(); }}
                />
              ))}
              <input
                type="color"
                value={/^#[0-9a-f]{6}$/i.test(en.value) ? en.value : '#6c8cff'}
                title={t('bm.recolor_custom')}
                onChange={(e) => en.onPick(e.target.value)}
              />
            </div>
          );
        }
        const isArmed = armed === i;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={en.disabled}
            className={`lib-menu-item${en.danger ? ' danger' : ''}${isArmed ? ' armed' : ''}`}
            title={en.hint}
            onClick={() => {
              // Destructive entries without undo ask once, in place.
              if (en.confirm && !isArmed) { setArmed(i); return; }
              en.onClick();
              onClose();
            }}
          >
            <span className="lib-menu-ico">
              {en.checked !== undefined ? (en.checked ? <Ico n="check" /> : null) : en.icon ? <Ico n={en.icon} /> : null}
            </span>
            <span className="lib-menu-text">{isArmed ? en.confirm : en.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
};

// ── The list ───────────────────────────────────────────────────────────

const LibraryList: React.FC<{ a: Adapter }> = ({ a }) => {
  const t = useT();
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [form, setForm] = useState<'add' | 'group' | null>(null);
  const [dialog, setDialog] = useState<((close: () => void) => React.ReactNode) | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [renaming, setRenaming] = useState<{ type: 'item' | 'group'; key: string; value: string } | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [undo, setUndo] = useState<Item[] | null>(null);
  const [drag, setDrag] = useState<{ type: 'item' | 'group'; key: string; group: string } | null>(null);
  const [dropAt, setDropAt] = useState<{ type: 'item' | 'group'; key: string } | null>(null);
  const lastClick = useRef(0);
  const anchorRef = useRef<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const undoTimer = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const ui: ListUi = {
    openAddForm: () => setForm('add'),
    openGroupForm: () => setForm('group'),
    openDialog: (node) => setDialog(() => node),
  };

  const q = search.trim().toLowerCase();
  const groupByKey = useMemo(() => new Map(a.groups.map((g) => [g.key, g] as const)), [a.groups]);

  // Rows in the order they are drawn; also what Shift-click ranges over.
  const sections = useMemo(() => {
    const sorted = (list: Item[]) => (a.compare ? [...list].sort(a.compare) : list);
    if (q) {
      const hits = sorted(a.items.filter((it) => it.haystack.includes(q)));
      return [{ group: null as Group | null, items: hits }];
    }
    return a.groups.map((g) => ({ group: g as Group | null, items: sorted(a.items.filter((it) => it.group === g.key)) }));
  }, [a.groups, a.items, a.compare, q]);
  const visible = useMemo(
    () => sections.flatMap((s) => (s.group && a.isCollapsed(s.group.key) ? [] : s.items)),
    [sections, a],
  );

  useEffect(() => () => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
  }, []);

  // Drop ids that no longer exist (deleted elsewhere, list refreshed).
  useEffect(() => {
    if (selected.size === 0) return;
    const alive = new Set(a.items.map((i) => i.id));
    if ([...selected].some((id) => !alive.has(id))) {
      setSelected(new Set([...selected].filter((id) => alive.has(id))));
    }
  }, [a.items, selected]);

  const stopSelecting = () => { setSelecting(false); setSelected(new Set()); setConfirmBulk(false); };
  const toggle = (id: string) => {
    setConfirmBulk(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    anchorRef.current = id;
  };
  const selectRange = (id: string) => {
    const ids = visible.map((i) => i.id);
    const from = ids.indexOf(anchorRef.current ?? id);
    const to = ids.indexOf(id);
    if (from < 0 || to < 0) { toggle(id); return; }
    const [lo, hi] = from < to ? [from, to] : [to, from];
    setConfirmBulk(false);
    setSelected((prev) => new Set([...prev, ...ids.slice(lo, hi + 1)]));
  };

  const activate = (it: Item) => {
    const now = Date.now();
    if (now - lastClick.current < 200) return; // swallow accidental double clicks
    lastClick.current = now;
    a.activate(it);
    setFlashId(it.id);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashId(null), 600);
  };

  const removeItems = async (items: Item[]) => {
    if (items.length === 0) return;
    await a.remove(items);
    if (a.restore) {
      setUndo(items);
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => setUndo(null), 8000);
    }
  };

  const onRowClick = (e: React.MouseEvent, it: Item) => {
    if (renaming) return;
    if (e.shiftKey) { setSelecting(true); selectRange(it.id); return; }
    if (e.ctrlKey || e.metaKey) { setSelecting(true); toggle(it.id); return; }
    if (selecting) { toggle(it.id); return; }
    activate(it);
  };

  const moveEntries = (items: Item[], from: string | null): MenuEntry[] => {
    const targets = a.groups.filter((g) => !g.virtual && g.key !== from);
    if (targets.length === 0) return [];
    return [
      { kind: 'sep' },
      { kind: 'label', label: t('lib.move_to') },
      ...targets.map((g): MenuEntry => ({
        kind: 'item', label: g.name, icon: 'folder', onClick: () => { a.move(items, g.key); if (selecting) stopSelecting(); },
      })),
    ];
  };

  const openItemMenu = (it: Item, x: number, y: number, align?: 'right') => {
    const entries: MenuEntry[] = [
      { kind: 'item', label: a.activateLabel, icon: a.activateIcon, onClick: () => activate(it) },
      ...a.itemMenu(it, ui),
      { kind: 'sep' },
      { kind: 'item', label: t('generic.rename'), icon: 'edit', onClick: () => setRenaming({ type: 'item', key: it.id, value: it.name }) },
      { kind: 'item', label: t('lib.select'), icon: 'select', onClick: () => { setSelecting(true); setSelected(new Set([it.id])); anchorRef.current = it.id; } },
      ...moveEntries([it], it.group),
      { kind: 'sep' },
      {
        kind: 'item', label: t('generic.delete'), icon: 'trash', danger: true,
        confirm: a.restore ? undefined : t('lib.confirm_delete'),
        onClick: () => { void removeItems([it]); },
      },
    ];
    setMenu({ x, y, entries, align });
  };

  const openGroupMenu = (g: Group, x: number, y: number, align?: 'right') => {
    const inGroup = a.items.filter((i) => i.group === g.key);
    const entries: MenuEntry[] = [];
    if (!g.virtual) {
      if (a.groupRename && !g.locked) {
        entries.push({ kind: 'item', label: t('generic.rename'), icon: 'edit', onClick: () => setRenaming({ type: 'group', key: g.key, value: g.name }) });
      }
      if (a.groupRecolor) {
        entries.push({ kind: 'label', label: t('lib.color') });
        entries.push({ kind: 'colors', value: g.color, onPick: (c) => a.groupRecolor!(g, c) });
        entries.push({ kind: 'sep' });
      }
      entries.push(...a.groupMenu(g, ui));
    }
    if (inGroup.length > 0) {
      entries.push({
        kind: 'item', label: t('lib.select_group'), icon: 'select',
        onClick: () => { setSelecting(true); setSelected(new Set([...selected, ...inGroup.map((i) => i.id)])); },
      });
    }
    if (!g.virtual && !g.locked) {
      entries.push({ kind: 'sep' });
      entries.push({
        kind: 'item', label: t('lib.delete_group'), icon: 'trash', danger: true,
        confirm: t('lib.confirm_delete_group'), onClick: () => a.groupDelete(g),
      });
    }
    if (entries.length) setMenu({ x, y, entries, align });
  };

  const menuFromButton = (e: React.MouseEvent, build: (x: number, y: number) => void) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    build(r.right, r.bottom + 4);
  };

  const sortEntries: MenuEntry[] = [
    { kind: 'label', label: t('bm.sort_label') },
    ...a.sortModes.map((m): MenuEntry => ({ kind: 'item', label: m.label, checked: a.sort === m.id, onClick: () => a.setSort(m.id) })),
  ];

  // ── Drag and drop ────────────────────────────────────────────────────
  // A row dropped on a row of its own category reorders (manual sort only);
  // dropped anywhere in another category it moves there.
  const canDrag = !selecting && !q && !renaming;
  const onDropItem = (target: Item) => {
    if (!drag || drag.type !== 'item') return;
    const src = a.items.find((i) => i.id === drag.key);
    if (!src || src.id === target.id) return;
    if (src.group !== target.group) { a.move([src], target.group); return; }
    if (a.compare || !a.reorder) return;
    const ids = a.items.filter((i) => i.group === target.group).map((i) => i.id);
    const from = ids.indexOf(src.id);
    const to = ids.indexOf(target.id);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, src.id);
    a.reorder(target.group, ids);
  };
  const onDropGroup = (g: Group) => {
    if (!drag || g.virtual) return;
    if (drag.type === 'item') {
      const src = a.items.find((i) => i.id === drag.key);
      if (src && src.group !== g.key) a.move([src], g.key);
      return;
    }
    if (!a.reorderGroups || drag.key === g.key) return;
    const keys = a.groups.filter((x) => !x.virtual).map((x) => x.key);
    const from = keys.indexOf(drag.key);
    const to = keys.indexOf(g.key);
    if (from < 0 || to < 0) return;
    keys.splice(from, 1);
    keys.splice(to, 0, drag.key);
    a.reorderGroups(keys);
  };
  const endDrag = () => { setDrag(null); setDropAt(null); };

  // Native edge-scroll during HTML5 drag is too slow on long lists.
  const dragY = useRef(0);
  useEffect(() => {
    if (!drag) return;
    const el = listRef.current;
    if (!el) return;
    const over = (e: DragEvent) => { dragY.current = e.clientY; };
    window.addEventListener('dragover', over);
    let raf = 0;
    const tick = () => {
      const r = el.getBoundingClientRect();
      const y = dragY.current;
      if (y > 0) {
        const top = y - r.top;
        const bottom = r.bottom - y;
        if (top >= 0 && top < 60) el.scrollTop -= 16 * (1 - top / 60);
        else if (bottom >= 0 && bottom < 60) el.scrollTop += 16 * (1 - bottom / 60);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('dragover', over); };
  }, [drag]);

  // ── Rows ─────────────────────────────────────────────────────────────

  const commitRename = () => {
    if (!renaming) return;
    const name = renaming.value.trim();
    if (name) {
      if (renaming.type === 'item') {
        const it = a.items.find((i) => i.id === renaming.key);
        if (it && name !== it.name) a.rename(it, name);
      } else {
        const g = groupByKey.get(renaming.key);
        if (g && name !== g.name) a.groupRename?.(g, name);
      }
    }
    setRenaming(null);
  };
  const renameInput = (
    <input
      className="lib-rename"
      autoFocus
      value={renaming?.value ?? ''}
      onChange={(e) => setRenaming((r) => (r ? { ...r, value: e.target.value } : r))}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commitRename();
        if (e.key === 'Escape') setRenaming(null);
      }}
      onBlur={commitRename}
    />
  );

  const renderRow = (it: Item, showGroup: boolean) => {
    const isSel = selected.has(it.id);
    const isRenaming = renaming?.type === 'item' && renaming.key === it.id;
    const g = groupByKey.get(it.group);
    const cls = ['lib-row'];
    if (isSel) cls.push('selected');
    if (flashId === it.id) cls.push('flash');
    if (drag?.type === 'item' && drag.key === it.id) cls.push('dragging');
    if (dropAt?.type === 'item' && dropAt.key === it.id) cls.push('drop');
    return (
      <div
        key={it.id}
        className={cls.join(' ')}
        role="button"
        tabIndex={0}
        draggable={canDrag}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', it.name);
          setDrag({ type: 'item', key: it.id, group: it.group });
        }}
        onDragOver={(e) => {
          if (drag?.type !== 'item' || drag.key === it.id) return;
          if (drag.group === it.group && (a.compare || !a.reorder)) return;
          e.preventDefault();
          setDropAt({ type: 'item', key: it.id });
        }}
        onDragLeave={() => { if (dropAt?.key === it.id) setDropAt(null); }}
        onDrop={(e) => { e.preventDefault(); onDropItem(it); endDrag(); }}
        onDragEnd={endDrag}
        onClick={(e) => onRowClick(e, it)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter') { if (selecting) toggle(it.id); else activate(it); }
          if (e.key === 'F2') setRenaming({ type: 'item', key: it.id, value: it.name });
          if (e.key === 'Delete') void removeItems(selecting && isSel ? a.items.filter((i) => selected.has(i.id)) : a.restore ? [it] : []);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (selecting) return;
          openItemMenu(it, e.clientX, e.clientY);
        }}
      >
        {selecting
          ? <span className={`lib-check${isSel ? ' on' : ''}`}>{isSel && <Ico n="check" size={11} />}</span>
          : <span className="lib-dot" style={{ background: g?.color ?? '#888' }} />}
        {it.flag && (
          <img
            className="lib-flag"
            src={`https://flagcdn.com/w20/${it.flag}.png`}
            alt={it.flag.toUpperCase()}
            width={15}
            height={11}
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
        )}
        <span className="lib-row-main">
          {isRenaming ? renameInput : <span className="lib-row-name" title={it.name}>{it.name}</span>}
          <span className="lib-row-sub">{showGroup && g ? `${g.name} · ` : ''}{it.sub}</span>
        </span>
        {!selecting && !isRenaming && (
          <button
            type="button"
            className="lib-kebab"
            title={t('lib.more')}
            onClick={(e) => menuFromButton(e, (x, y) => openItemMenu(it, x, y, 'right'))}
          ><Ico n="more" /></button>
        )}
      </div>
    );
  };

  const total = a.items.length;
  const selectedItems = a.items.filter((i) => selected.has(i.id));
  const allVisibleSelected = visible.length > 0 && visible.every((i) => selected.has(i.id));

  return (
    <div className="lib-body">
      <div className="lib-toolbar">
        <label className="lib-search">
          <Ico n="search" size={13} />
          <input
            ref={searchRef}
            type="text"
            value={search}
            placeholder={a.text.search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && search) { e.stopPropagation(); setSearch(''); }
              if (e.key === 'Enter' && q && visible[0] && !selecting) activate(visible[0]);
            }}
          />
          {search && (
            <button type="button" title={t('bm.search_clear')} onClick={() => { setSearch(''); searchRef.current?.focus(); }}>
              <Ico n="close" size={12} />
            </button>
          )}
        </label>
        <button
          type="button"
          className="lib-btn primary"
          onClick={(e) => menuFromButton(e, (x, y) => setMenu({ x, y, entries: a.addMenu(ui), align: 'right' }))}
        ><Ico n="plus" size={13} />{t('lib.add')}</button>
        <button
          type="button"
          className="lib-btn icon"
          title={t('lib.more')}
          onClick={(e) => menuFromButton(e, (x, y) => setMenu({
            x, y, align: 'right',
            entries: [
              { kind: 'item', label: t('lib.select_multiple'), icon: 'select', disabled: total === 0, onClick: () => setSelecting(true) },
              { kind: 'sep' },
              ...sortEntries,
              { kind: 'sep' },
              ...a.moreMenu(ui),
              { kind: 'item', label: t('lib.expand_all'), icon: 'expand', onClick: () => a.setAllCollapsed(false) },
              { kind: 'item', label: t('lib.collapse_all'), icon: 'collapse', onClick: () => a.setAllCollapsed(true) },
            ],
          }))}
        ><Ico n="more" size={15} /></button>
      </div>

      {a.notice && (
        <div className="lib-notice">
          <span>{a.notice.text}</span>
          <button type="button" onClick={a.notice.onAction}>{a.notice.action}</button>
        </div>
      )}

      {form === 'add' && <AddFormView a={a} onClose={() => setForm(null)} />}
      {form === 'group' && (
        <InlineName
          title={t('bm.add_category')}
          placeholder={t('lib.group_name')}
          submitLabel={t('generic.add')}
          onSubmit={(name) => { a.groupAdd(name); setForm(null); }}
          onClose={() => setForm(null)}
        />
      )}

      <div className="lib-list" ref={listRef}>
        {total === 0 && !form && (
          <div className="lib-empty">
            <div className="lib-empty-title">{a.text.empty}</div>
            <div className="lib-empty-hint">{a.text.emptyHint}</div>
            <button type="button" className="lib-btn primary" disabled={!!a.addForm.blocked} onClick={() => setForm('add')}>
              <Ico n="plus" size={13} />{a.addForm.title}
            </button>
            {a.addForm.blocked && <div className="lib-empty-hint">{a.addForm.blocked}</div>}
          </div>
        )}
        {q && total > 0 && sections[0].items.length === 0 && (
          <div className="lib-empty">
            <div className="lib-empty-title">{a.text.noResults}</div>
            <div className="lib-empty-hint">{t('lib.no_results_hint').replace('{q}', search.trim())}</div>
          </div>
        )}
        {q && sections[0].items.map((it) => renderRow(it, true))}
        {!q && total > 0 && sections.map(({ group, items }) => {
          const g = group!;
          const collapsed = a.isCollapsed(g.key);
          const isRenaming = renaming?.type === 'group' && renaming.key === g.key;
          const cls = ['lib-group-head'];
          if (dropAt?.type === 'group' && dropAt.key === g.key) cls.push('drop');
          if (drag?.type === 'group' && drag.key === g.key) cls.push('dragging');
          return (
            <div key={g.key} className="lib-group">
              <div
                className={cls.join(' ')}
                role="button"
                tabIndex={0}
                draggable={canDrag && !g.virtual && !!a.reorderGroups}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', g.name);
                  setDrag({ type: 'group', key: g.key, group: g.key });
                }}
                onDragOver={(e) => {
                  if (!drag || g.virtual) return;
                  if (drag.type === 'group' ? drag.key === g.key : drag.group === g.key) return;
                  e.preventDefault();
                  setDropAt({ type: 'group', key: g.key });
                }}
                onDragLeave={() => { if (dropAt?.key === g.key) setDropAt(null); }}
                onDrop={(e) => { e.preventDefault(); onDropGroup(g); endDrag(); }}
                onDragEnd={endDrag}
                onClick={() => { if (!isRenaming) a.toggleCollapsed(g.key); }}
                onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === 'Enter') a.toggleCollapsed(g.key); }}
                onContextMenu={(e) => { e.preventDefault(); openGroupMenu(g, e.clientX, e.clientY); }}
              >
                <span className={`lib-chevron${collapsed ? '' : ' open'}`}><Ico n="chevron" size={11} /></span>
                <span className="lib-dot" style={{ background: g.color }} />
                {isRenaming ? renameInput : <span className="lib-group-name">{g.name}</span>}
                <span className="lib-count">{items.length}</span>
                {!isRenaming && (
                  <button
                    type="button"
                    className="lib-kebab"
                    title={t('lib.more')}
                    onClick={(e) => menuFromButton(e, (x, y) => openGroupMenu(g, x, y, 'right'))}
                  ><Ico n="more" /></button>
                )}
              </div>
              {!collapsed && (
                <div className="lib-group-items">
                  {items.length === 0
                    ? <div className="lib-group-empty">{t('lib.group_empty')}</div>
                    : items.map((it) => renderRow(it, false))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {selecting && (
        <div className="lib-bar">
          {confirmBulk ? (
            <>
              <span className="lib-bar-text">{t('lib.confirm_bulk').replace('{n}', String(selectedItems.length))}</span>
              <button type="button" className="lib-btn" onClick={() => setConfirmBulk(false)}>{t('generic.cancel')}</button>
              <button
                type="button"
                className="lib-btn danger"
                onClick={async () => { await removeItems(selectedItems); stopSelecting(); }}
              >{t('generic.delete')}</button>
            </>
          ) : (
            <>
              <span className="lib-bar-text">{t('lib.selected_n').replace('{n}', String(selectedItems.length))}</span>
              <button
                type="button"
                className="lib-btn"
                onClick={() => setSelected(allVisibleSelected ? new Set() : new Set(visible.map((i) => i.id)))}
              >{allVisibleSelected ? t('bm.deselect_all') : t('bm.select_all')}</button>
              <button
                type="button"
                className="lib-btn"
                disabled={selectedItems.length === 0}
                onClick={(e) => menuFromButton(e, (x, y) => setMenu({ x, y: y - 8, align: 'right', entries: moveEntries(selectedItems, null).slice(1) }))}
              ><Ico n="folder" size={13} />{t('lib.move')}</button>
              <button
                type="button"
                className="lib-btn danger"
                disabled={selectedItems.length === 0}
                onClick={() => setConfirmBulk(true)}
              ><Ico n="trash" size={13} /></button>
              <button type="button" className="lib-btn" onClick={stopSelecting}>{t('lib.done')}</button>
            </>
          )}
        </div>
      )}

      {undo && !selecting && (
        <div className="lib-bar undo">
          <span className="lib-bar-text">
            {undo.length === 1
              ? t('lib.deleted_one').replace('{name}', undo[0].name)
              : t('lib.deleted_n').replace('{n}', String(undo.length))}
          </span>
          <button
            type="button"
            className="lib-btn"
            onClick={() => { a.restore?.(undo); setUndo(null); }}
          ><Ico n="undo" size={13} />{t('lib.undo')}</button>
        </div>
      )}

      {menu && <Menu state={menu} onClose={() => setMenu(null)} />}
      {dialog && dialog(() => setDialog(null))}
    </div>
  );
};

// ── Inline forms ───────────────────────────────────────────────────────

const InlineName: React.FC<{
  title: string; placeholder: string; submitLabel: string;
  onSubmit: (name: string) => void; onClose: () => void;
}> = ({ title, placeholder, submitLabel, onSubmit, onClose }) => {
  const t = useT();
  const [name, setName] = useState('');
  const ok = name.trim() !== '';
  return (
    <div className="lib-form">
      <div className="lib-form-title">{title}</div>
      <input
        className="lib-input"
        autoFocus
        value={name}
        placeholder={placeholder}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && ok) onSubmit(name.trim());
          if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        }}
      />
      <div className="lib-form-actions">
        <button type="button" className="lib-btn" onClick={onClose}>{t('generic.cancel')}</button>
        <button type="button" className="lib-btn primary" disabled={!ok} onClick={() => onSubmit(name.trim())}>{submitLabel}</button>
      </div>
    </div>
  );
};

// "Save what is on the map right now": current position, or current route.
const AddFormView: React.FC<{ a: Adapter; onClose: () => void }> = ({ a, onClose }) => {
  const t = useT();
  const f = a.addForm;
  const real = a.groups.filter((g) => !g.virtual);
  const [name, setName] = useState('');
  const [group, setGroup] = useState(real[0]?.key ?? '');
  const [conflict, setConflict] = useState<Item[] | null>(null);
  const [target, setTarget] = useState('');
  const ok = name.trim() !== '' && !f.blocked;
  const submit = () => {
    if (!ok) return;
    const res = f.submit(name.trim(), group);
    if (res === 'done') { onClose(); return; }
    setConflict(res.conflict);
    setTarget(res.conflict[0].id);
  };
  return (
    <div className="lib-form">
      <div className="lib-form-title">{f.title}</div>
      <div className="lib-form-caption">{f.blocked ?? f.caption}</div>
      {!conflict ? (
        <>
          <input
            className="lib-input"
            autoFocus
            value={name}
            placeholder={f.placeholder}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
            }}
          />
          <select className="lib-input" value={group} onChange={(e) => setGroup(e.target.value)} title={t('lib.category')}>
            {real.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
          </select>
          <div className="lib-form-actions">
            <button type="button" className="lib-btn" onClick={onClose}>{t('generic.cancel')}</button>
            <button type="button" className="lib-btn primary" disabled={!ok} onClick={submit}>{t('generic.save')}</button>
          </div>
        </>
      ) : (
        <>
          <div className="lib-form-warn">
            {t('route.overwrite_body').replace('{n}', String(conflict.length)).replace('{name}', name.trim())}
          </div>
          {conflict.length > 1 && (
            <select className="lib-input" value={target} onChange={(e) => setTarget(e.target.value)}>
              {conflict.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.sub}</option>)}
            </select>
          )}
          <div className="lib-form-actions">
            <button type="button" className="lib-btn" onClick={() => setConflict(null)}>{t('generic.cancel')}</button>
            <button type="button" className="lib-btn" onClick={() => { f.saveNew?.(name.trim(), group); onClose(); }}>{t('route.overwrite_save_as_new')}</button>
            <button type="button" className="lib-btn primary" onClick={() => { f.overwrite?.(name.trim(), target); onClose(); }}>{t('route.overwrite_yes')}</button>
          </div>
        </>
      )}
    </div>
  );
};

// ── Dialogs ────────────────────────────────────────────────────────────

const Dialog: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) =>
  createPortal(
    <div className="lib-scrim" onClick={onClose} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="lib-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="lib-dialog-title">{title}</div>
        {children}
      </div>
    </div>,
    document.body,
  );

// Name + coordinate (+ category when adding). The coordinate is one text
// field read with parseCoord, so it follows 設定 > 座標格式 like every
// other coordinate input in the app.
const CoordDialog: React.FC<{
  title: string;
  initial?: { name: string; lat: number; lng: number };
  groups?: Group[];
  submitLabel: string;
  onSubmit: (v: { name: string; lat: number; lng: number; group: string }) => void;
  onClose: () => void;
}> = ({ title, initial, groups, submitLabel, onSubmit, onClose }) => {
  const t = useT();
  const [name, setName] = useState(initial?.name ?? '');
  const [coord, setCoord] = useState(initial ? formatCoord(initial.lat, initial.lng, 6) : '');
  const [group, setGroup] = useState(groups?.[0]?.key ?? '');
  const parsed = parseCoord(coord);
  const ok = name.trim() !== '' && !!parsed;
  const submit = () => { if (ok && parsed) { onSubmit({ name: name.trim(), lat: parsed.lat, lng: parsed.lng, group }); onClose(); } };
  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') submit(); };
  return (
    <Dialog title={title} onClose={onClose}>
      <label className="lib-field">
        <span>{t('lib.name')}</span>
        <input className="lib-input" autoFocus value={name} placeholder={t('lib.coord_name')} onChange={(e) => setName(e.target.value)} onKeyDown={onKey} />
      </label>
      <label className="lib-field">
        <span>{t('lib.coordinate')}{!isDefaultCoordSettings() && ` (${coordBadge(t)})`}</span>
        <input
          className="lib-input mono"
          value={coord}
          placeholder={formatCoord(25.033, 121.564, 3)}
          onChange={(e) => setCoord(e.target.value)}
          onKeyDown={onKey}
        />
        {coord.trim() !== '' && !parsed && <span className="lib-field-err">{t('lib.coord_invalid')}</span>}
      </label>
      {groups && (
        <label className="lib-field">
          <span>{t('lib.category')}</span>
          <select className="lib-input" value={group} onChange={(e) => setGroup(e.target.value)}>
            {groups.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
          </select>
        </label>
      )}
      <div className="lib-form-actions">
        <button type="button" className="lib-btn" onClick={onClose}>{t('generic.cancel')}</button>
        <button type="button" className="lib-btn primary" disabled={!ok} onClick={submit}>{submitLabel}</button>
      </div>
    </Dialog>
  );
};

const PickGroupsDialog: React.FC<{
  title: string; groups: Group[]; initial: string[]; submitLabel: string;
  onSubmit: (keys: string[]) => void; onClose: () => void;
}> = ({ title, groups, initial, submitLabel, onSubmit, onClose }) => {
  const t = useT();
  const [picked, setPicked] = useState<Set<string>>(new Set(initial));
  const all = picked.size === groups.length;
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="lib-picklist">
        <label className="lib-pick all">
          <input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(groups.map((g) => g.key)))} />
          {t('bm.select_all')}
        </label>
        {groups.map((g) => (
          <label key={g.key} className="lib-pick">
            <input
              type="checkbox"
              checked={picked.has(g.key)}
              onChange={() => setPicked((prev) => {
                const next = new Set(prev);
                if (next.has(g.key)) next.delete(g.key); else next.add(g.key);
                return next;
              })}
            />
            <span className="lib-dot" style={{ background: g.color }} />
            {g.name}
          </label>
        ))}
      </div>
      <div className="lib-form-actions">
        <button type="button" className="lib-btn" onClick={onClose}>{t('generic.cancel')}</button>
        <button
          type="button"
          className="lib-btn primary"
          disabled={picked.size === 0}
          onClick={() => { onSubmit(groups.filter((g) => picked.has(g.key)).map((g) => g.key)); onClose(); }}
        >{submitLabel}</button>
      </div>
    </Dialog>
  );
};

// ── Adapter: saved coordinates ─────────────────────────────────────────

type BmSort = 'default' | 'name' | 'date_added' | 'last_used';

function useBookmarkAdapter(p: LibraryBookmarkProps): Adapter {
  const t = useT();
  useCoordSettings();
  const [sort, setSort] = usePersisted<BmSort>('locwarp.bookmark_sort', ['default', 'name', 'date_added', 'last_used'], 'default');
  const [flyRaw, setFlyRaw] = usePersisted<'1' | '0'>('locwarp.bookmark_fly_gps', ['1', '0'], '1');
  const flyGps = flyRaw === '1' || !p.onBookmarkPreview;
  const displayCat = (name: string) => (name === '預設' ? t('bm.default') : name === UNCATEGORIZED ? t('lib.uncategorized') : name);

  // Collapse state lives in the backend settings file. Above the threshold
  // every category starts collapsed; crossing it in either direction
  // resets to that rule, manual toggles hold in between.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const savedExpanded = useRef<string[] | null>(null);
  const wasOver = useRef<boolean | null>(null);
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    let dead = false;
    getBookmarkUiState()
      .then((s) => { if (!dead) savedExpanded.current = s.expanded_categories; })
      .catch(() => { /* first run or backend offline */ })
      .finally(() => { if (!dead) setLoaded(true); });
    return () => { dead = true; };
  }, []);
  useEffect(() => {
    if (!loaded || p.categories.length === 0) return;
    const over = p.bookmarks.length > AUTO_COLLAPSE_THRESHOLD;
    if (wasOver.current === null || over !== wasOver.current) {
      const next: Record<string, boolean> = {};
      if (over) p.categories.forEach((c) => { next[c] = true; });
      else if (savedExpanded.current) {
        const open = new Set(savedExpanded.current);
        p.categories.forEach((c) => { next[c] = !open.has(c); });
      }
      setCollapsed(next);
    }
    wasOver.current = over;
  }, [loaded, p.bookmarks.length, p.categories]);
  const persistCollapsed = (next: Record<string, boolean>) => {
    setCollapsed(next);
    const expanded = p.categories.filter((c) => !next[c]);
    savedExpanded.current = expanded;
    if (!loaded) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void setBookmarkUiState(expanded).catch(() => { /* best effort */ }); }, 400);
  };

  const color = (name: string) => p.categoryColors?.[name] || hashColor(name);
  const groups: Group[] = p.categories.map((c) => ({ key: c, name: displayCat(c), color: color(c), locked: isDefaultCatName(c) }));
  if (p.bookmarks.some((b) => !p.categories.includes(b.category))) {
    groups.push({ key: UNCATEGORIZED, name: displayCat(UNCATEGORIZED), color: '#888', locked: true, virtual: true });
  }
  const items: Item[] = p.bookmarks.filter((b) => !!b.id).map((b) => {
    const sub = formatCoord(b.lat, b.lng, 5);
    return {
      id: b.id!, name: b.name, sub, flag: b.country_code || undefined,
      group: p.categories.includes(b.category) ? b.category : UNCATEGORIZED,
      haystack: `${(b.name ?? '').toLowerCase()} ${sub}`, raw: b,
    };
  });
  const compare: Adapter['compare'] =
    sort === 'name' ? (x, y) => x.name.localeCompare(y.name, 'zh-Hant')
      : sort === 'date_added' ? (x, y) => (y.raw.created_at || '').localeCompare(x.raw.created_at || '')
        : sort === 'last_used' ? (x, y) => (y.raw.last_used_at || '').localeCompare(x.raw.last_used_at || '')
          : null;
  const realGroups = groups.filter((g) => !g.virtual);

  return {
    groups, items, compare,
    sort, setSort: (id) => setSort(id as BmSort),
    sortModes: [
      { id: 'default', label: t('lib.sort_manual') },
      { id: 'name', label: t('bm.sort_name') },
      { id: 'date_added', label: t('bm.sort_date_added') },
      { id: 'last_used', label: t('bm.sort_last_used') },
    ],
    isCollapsed: (k) => !!collapsed[k],
    toggleCollapsed: (k) => persistCollapsed({ ...collapsed, [k]: !collapsed[k] }),
    setAllCollapsed: (v) => persistCollapsed(Object.fromEntries(groups.map((g) => [g.key, v]))),
    activate: (it) => (flyGps ? p.onBookmarkClick(it.raw) : p.onBookmarkPreview!(it.raw)),
    activateLabel: flyGps ? t('lib.teleport_here') : t('lib.view_on_map'),
    activateIcon: flyGps ? 'go' : 'eye',
    rename: (it, name) => p.onBookmarkEdit(it.id, { name }),
    remove: (list) => { list.forEach((it) => p.onBookmarkDelete(it.id)); },
    restore: (list) => list.forEach((it) => p.onBookmarkAdd({
      name: it.raw.name, lat: it.raw.lat, lng: it.raw.lng,
      category: it.group === UNCATEGORIZED ? (p.categories[0] ?? 'Default') : it.group,
    })),
    move: (list, key) => list.forEach((it) => p.onBookmarkEdit(it.id, { category: key })),
    reorder: p.onBookmarkReorder ? (key, ids) => p.onBookmarkReorder!(key, ids) : undefined,
    reorderGroups: p.onCategoryReorder ? (keys) => p.onCategoryReorder!(keys) : undefined,
    groupAdd: (name) => p.onCategoryAdd(name),
    groupRename: p.onCategoryRename ? (g, name) => p.onCategoryRename!(g.key, name) : undefined,
    groupRecolor: p.onCategoryRecolor ? (g, c) => p.onCategoryRecolor!(g.key, c) : undefined,
    groupDelete: (g) => p.onCategoryDelete(g.key),
    itemMenu: (it, ui) => {
      const b: Bookmark = it.raw;
      const out: MenuEntry[] = [];
      if (p.onBookmarkPreview) {
        out.push(flyGps
          ? { kind: 'item', label: t('lib.view_on_map'), icon: 'eye', onClick: () => p.onBookmarkPreview!(b) }
          : { kind: 'item', label: t('lib.teleport_here'), icon: 'go', onClick: () => p.onBookmarkClick(b) });
      }
      out.push({ kind: 'item', label: t('bm.copy'), icon: 'copy', onClick: () => { void copyText(`${b.name} ${formatCoord(b.lat, b.lng, 6)}`); } });
      out.push({
        kind: 'item', label: t('lib.edit_coord'), icon: 'pin',
        onClick: () => ui.openDialog((close) => (
          <CoordDialog
            title={t('lib.edit_coord')}
            initial={{ name: b.name, lat: b.lat, lng: b.lng }}
            submitLabel={t('generic.save')}
            // The backend PUT wants the whole bookmark, not a patch.
            onSubmit={(v) => p.onBookmarkEdit(it.id, { ...b, name: v.name, lat: v.lat, lng: v.lng })}
            onClose={close}
          />
        )),
      });
      out.push({ kind: 'item', label: t('bm.export_gpx'), icon: 'down', onClick: () => download(bookmarkGpxExportUrl(it.id)) });
      return out;
    },
    groupMenu: (g, ui) => {
      const out: MenuEntry[] = [];
      if (p.onCategoryExportGpx) out.push({ kind: 'item', label: t('bm.export_category_gpx'), icon: 'down', onClick: () => p.onCategoryExportGpx!(g.key) });
      if (p.onCategoriesExportGpxZip && realGroups.length > 1) {
        out.push({
          kind: 'item', label: t('bm.export_categories_zip'), icon: 'down',
          onClick: () => ui.openDialog((close) => (
            <PickGroupsDialog
              title={t('bm.export_categories_zip')} groups={realGroups} initial={[g.key]}
              submitLabel={t('bm.export')} onSubmit={(keys) => p.onCategoriesExportGpxZip!(keys)} onClose={close}
            />
          )),
        });
      }
      return out;
    },
    addMenu: (ui) => {
      const out: MenuEntry[] = [
        { kind: 'item', label: t('lib.save_position'), icon: 'pin', disabled: !p.currentPosition, hint: p.currentPosition ? undefined : t('bm.no_position'), onClick: ui.openAddForm },
        {
          kind: 'item', label: t('lib.add_by_coord'), icon: 'edit',
          onClick: () => ui.openDialog((close) => (
            <CoordDialog
              title={t('lib.add_by_coord')} groups={realGroups} submitLabel={t('generic.add')}
              onSubmit={(v) => p.onBookmarkAdd({ name: v.name, lat: v.lat, lng: v.lng, category: v.group })}
              onClose={close}
            />
          )),
        },
      ];
      if (p.onBulkPaste) out.push({ kind: 'item', label: t('bm.bulk_paste_title'), icon: 'paste', onClick: p.onBulkPaste });
      out.push({ kind: 'sep' });
      out.push({ kind: 'item', label: t('bm.add_category'), icon: 'folder', onClick: ui.openGroupForm });
      if (p.onImport) {
        out.push({ kind: 'sep' });
        out.push({ kind: 'item', label: t('lib.import_file'), icon: 'up', hint: t('bm.import_tooltip'), onClick: () => pickFile('application/json,.json,.gpx,application/gpx+xml', (f) => { void p.onImport!(f); }) });
      }
      return out;
    },
    moreMenu: (ui) => {
      const out: MenuEntry[] = [];
      if (p.onShowOnMapChange) out.push({ kind: 'item', label: t('lib.show_pins'), checked: !!p.showOnMap, onClick: () => p.onShowOnMapChange!(!p.showOnMap) });
      if (p.onBookmarkPreview) out.push({ kind: 'item', label: t('lib.click_moves_gps'), checked: flyGps, hint: t('bm.fly_gps_tooltip'), onClick: () => setFlyRaw(flyGps ? '0' : '1') });
      if (out.length) out.push({ kind: 'sep' });
      if (p.exportUrl) out.push({ kind: 'item', label: t('lib.export_all'), icon: 'down', hint: t('bm.export_tooltip'), onClick: () => download(p.exportUrl!, 'bookmarks.json') });
      if (p.onCategoriesExportGpxZip && realGroups.length > 0) {
        out.push({
          kind: 'item', label: t('lib.export_gpx_zip'), icon: 'down',
          onClick: () => ui.openDialog((close) => (
            <PickGroupsDialog
              title={t('bm.export_categories_zip')} groups={realGroups} initial={realGroups.map((g) => g.key)}
              submitLabel={t('bm.export')} onSubmit={(keys) => p.onCategoriesExportGpxZip!(keys)} onClose={close}
            />
          )),
        });
      }
      if (p.exportUrl || p.onCategoriesExportGpxZip) out.push({ kind: 'sep' });
      return out;
    },
    addForm: {
      title: t('lib.save_position'),
      caption: p.currentPosition ? formatCoord(p.currentPosition.lat, p.currentPosition.lng, 6) : '',
      placeholder: t('lib.coord_name'),
      blocked: p.currentPosition ? null : t('bm.no_position'),
      submit: (name, key) => {
        if (p.currentPosition) p.onBookmarkAdd({ name, lat: p.currentPosition.lat, lng: p.currentPosition.lng, category: key });
        return 'done';
      },
    },
    notice: flyGps ? null : { text: t('lib.preview_notice'), action: t('lib.preview_notice_action'), onAction: () => setFlyRaw('1') },
    text: {
      search: t('lib.search_coords'), empty: t('lib.empty_coords'), emptyHint: t('lib.empty_coords_hint'),
      noResults: t('lib.no_coords_found'), unit: '',
    },
  };
}

// ── Adapter: saved routes ──────────────────────────────────────────────

type RtSort = 'default' | 'name' | 'date_added' | 'date_updated';

function useRouteAdapter(p: LibraryRouteProps): Adapter {
  const t = useT();
  const [sort, setSort] = usePersisted<RtSort>('locwarp.route_sort', ['default', 'name', 'date_added', 'date_updated'], 'default');
  const [collapsed, setCollapsedRaw] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('locwarp.route_collapsed') || '{}'); } catch { return {}; }
  });
  const setCollapsed = (next: Record<string, boolean>) => {
    setCollapsedRaw(next);
    try { localStorage.setItem('locwarp.route_collapsed', JSON.stringify(next)); } catch { /* ignore */ }
  };
  const displayCat = (name: string) => (name === '預設' ? t('bm.default') : name);
  const defaultId = p.categories.find((c) => c.id === 'default')?.id ?? p.categories[0]?.id ?? 'default';

  const groups: Group[] = p.categories.map((c) => ({ key: c.id, name: displayCat(c.name), color: c.color || '#6c8cff', locked: c.id === 'default' }));
  const known = new Set(groups.map((g) => g.key));
  const unit = t('route.points_unit');
  const items: Item[] = p.routes.map((r) => ({
    id: r.id, name: r.name, sub: `${r.waypoints.length} ${unit}`,
    group: known.has(r.category_id || 'default') ? (r.category_id || 'default') : defaultId,
    haystack: (r.name ?? '').toLowerCase(), raw: r,
  }));
  const stamp = (r: SavedRoute) => r.updated_at || r.created_at || '';
  const compare: Adapter['compare'] =
    sort === 'name' ? (x, y) => x.name.localeCompare(y.name, 'zh-Hant')
      : sort === 'date_added' ? (x, y) => (y.raw.created_at || '').localeCompare(x.raw.created_at || '')
        : sort === 'date_updated' ? (x, y) => stamp(y.raw).localeCompare(stamp(x.raw))
          : null;
  const n = p.currentWaypointsCount;

  return {
    groups, items, compare,
    sort, setSort: (id) => setSort(id as RtSort),
    sortModes: [
      { id: 'default', label: t('lib.sort_manual') },
      { id: 'name', label: t('bm.sort_name') },
      { id: 'date_added', label: t('bm.sort_date_added') },
      { id: 'date_updated', label: t('route.sort_date_updated') },
    ],
    isCollapsed: (k) => !!collapsed[k],
    toggleCollapsed: (k) => setCollapsed({ ...collapsed, [k]: !collapsed[k] }),
    setAllCollapsed: (v) => setCollapsed(Object.fromEntries(groups.map((g) => [g.key, v]))),
    activate: (it) => p.onRouteLoad(it.id),
    activateLabel: t('route.load'),
    activateIcon: 'route',
    rename: (it, name) => p.onRouteRename(it.id, name),
    remove: async (list) => {
      const ids = list.map((i) => i.id);
      if (ids.length > 1 && p.onRoutesBulkDelete) await p.onRoutesBulkDelete(ids);
      else ids.forEach((id) => p.onRouteDelete(id));
    },
    move: (list, key) => { void p.onRouteMove?.(list.map((i) => i.id), key); },
    reorder: p.onRouteReorder ? (key, ids) => { void p.onRouteReorder!(key, ids); } : undefined,
    reorderGroups: p.onCategoryReorder ? (keys) => { void p.onCategoryReorder!(keys); } : undefined,
    groupAdd: (name) => { void p.onCategoryAdd?.(name); },
    groupRename: p.onCategoryRename ? (g, name) => { void p.onCategoryRename!(g.key, name); } : undefined,
    groupRecolor: p.onCategoryRecolor ? (g, c) => { void p.onCategoryRecolor!(g.key, c); } : undefined,
    groupDelete: (g) => { void p.onCategoryDelete?.(g.key); },
    itemMenu: (it) => (p.onRouteGpxExport
      ? [{ kind: 'item', label: t('route.export_gpx'), icon: 'down', onClick: () => p.onRouteGpxExport!(it.id) }]
      : []),
    groupMenu: () => [],
    addMenu: (ui) => {
      const out: MenuEntry[] = [
        { kind: 'item', label: t('lib.save_route'), icon: 'save', disabled: n === 0, hint: n === 0 ? t('lib.no_route') : undefined, onClick: ui.openAddForm },
        { kind: 'sep' },
        { kind: 'item', label: t('bm.add_category'), icon: 'folder', onClick: ui.openGroupForm },
      ];
      if (p.onRouteGpxImport || p.onRoutesImportAll) out.push({ kind: 'sep' });
      if (p.onRouteGpxImport) out.push({ kind: 'item', label: t('panel.route_gpx_import'), icon: 'up', onClick: () => pickFile('.gpx,application/gpx+xml', (f) => { void p.onRouteGpxImport!(f); }) });
      if (p.onRoutesImportAll) out.push({ kind: 'item', label: t('lib.import_routes_json'), icon: 'up', hint: t('panel.routes_import_all_tooltip'), onClick: () => pickFile('application/json,.json', (f) => { void p.onRoutesImportAll!(f); }) });
      return out;
    },
    moreMenu: () => (p.routesExportAllUrl
      ? [
        {
          kind: 'item', label: t('lib.export_all'), icon: 'down', disabled: p.routes.length === 0,
          hint: p.routes.length === 0 ? t('panel.routes_export_all_disabled') : t('panel.routes_export_all_tooltip'),
          onClick: () => download(p.routesExportAllUrl!, 'routes.json'),
        },
        { kind: 'sep' },
      ]
      : []),
    addForm: {
      title: t('lib.save_route'),
      caption: t('lib.route_points').replace('{n}', String(n)),
      placeholder: t('panel.route_name'),
      blocked: n === 0 ? t('lib.no_route') : null,
      submit: (name, key) => {
        const same = items.filter((i) => i.name === name);
        if (same.length > 0) return { conflict: same };
        p.onRouteSave(name, { categoryId: key });
        return 'done';
      },
      overwrite: (name, id) => p.onRouteSave(name, { overwriteId: id }),
      saveNew: (name, key) => p.onRouteSave(name, { categoryId: key }),
    },
    notice: null,
    text: {
      search: t('route.search_placeholder'), empty: t('lib.empty_routes'), emptyHint: t('lib.empty_routes_hint'),
      noResults: t('route.search_no_results'), unit,
    },
  };
}

// ── Shell ──────────────────────────────────────────────────────────────

const LibraryPanel: React.FC<LibraryPanelProps> = ({ tab, onTabChange, onClose, onDragStart, bm, rt }) => {
  const t = useT();
  const bmAdapter = useBookmarkAdapter(bm);
  const rtAdapter = useRouteAdapter(rt);
  return (
    <div className="lib">
      <div className="lib-head" onMouseDown={onDragStart}>
        <div className="lib-tabs" onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" className={tab === 'bookmarks' ? 'on' : ''} onClick={() => onTabChange('bookmarks')}>
            <Ico n="pin" size={13} />{t('lib.tab_coords')}<span>{bm.bookmarks.length}</span>
          </button>
          <button type="button" className={tab === 'routes' ? 'on' : ''} onClick={() => onTabChange('routes')}>
            <Ico n="route" size={13} />{t('lib.tab_routes')}<span>{rt.routes.length}</span>
          </button>
        </div>
        <button type="button" className="lib-close" title={t('panel.close')} onMouseDown={(e) => e.stopPropagation()} onClick={onClose}>
          <Ico n="close" size={14} />
        </button>
      </div>
      {/* Keyed so search text and selection never leak between tabs. */}
      <LibraryList key={tab} a={tab === 'bookmarks' ? bmAdapter : rtAdapter} />
    </div>
  );
};

export default LibraryPanel;
