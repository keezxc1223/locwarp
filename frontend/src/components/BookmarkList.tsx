import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { getBookmarkUiState, setBookmarkUiState, bookmarkGpxExportUrl } from '../services/api';

const AUTO_COLLAPSE_THRESHOLD = 30;

interface Bookmark {
  id?: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  // ISO 3166-1 alpha-2 (lowercase), optional. Rendered as a small flag
  // icon next to the bookmark name when present.
  country_code?: string;
  created_at?: string;  // ISO timestamp, used by 'date added' sort
  last_used_at?: string;  // ISO timestamp, used by 'last used' sort
}

interface Position {
  lat: number;
  lng: number;
}

interface BookmarkListProps {
  bookmarks: Bookmark[];
  categories: string[];
  // Stored color per category (name → hex). Overrides the hash-from-name
  // fallback so renaming a category doesn't re-roll its dot color.
  categoryColors?: Record<string, string>;
  currentPosition: Position | null;
  onBookmarkClick: (bm: Bookmark) => void;
  // Camera-only fly: pans the map to the bookmark coordinate without
  // moving the iPhone GPS. Used when the "click also flies GPS"
  // checkbox is unticked. Optional: if not supplied the toggle hides.
  onBookmarkPreview?: (bm: Bookmark) => void;
  onBookmarkAdd: (bm: Bookmark) => void;
  onBookmarkDelete: (id: string) => void;
  onBookmarkEdit: (id: string, bm: Partial<Bookmark>) => void;
  onCategoryAdd: (name: string) => void;
  onCategoryDelete: (name: string) => void;
  onCategoryRename?: (oldName: string, newName: string) => void;
  // Persist a new color for a category (works for Default too).
  onCategoryRecolor?: (name: string, color: string) => void;
  // Persist a new category order. Receives the full ordered list of category
  // names. Triggered by the up/down arrows surfaced in reorder mode.
  onCategoryReorder?: (orderedNames: string[]) => void;
  // Persist a new bookmark order within a single category. Receives the
  // category name and the ordered list of bookmark IDs in that category.
  onBookmarkReorder?: (categoryName: string, orderedIds: string[]) => void;
  showOnMap?: boolean;
  onShowOnMapChange?: (v: boolean) => void;
  onImport?: (file: File) => Promise<void>;
  // Bulk paste: opens a textarea dialog where the user can drop
  // whitespace-separated "lat lng name" lines and push them all as
  // bookmarks at once. Wired separately from onImport so the file-
  // picker flow stays untouched.
  onBulkPaste?: () => void;
  exportUrl?: string;
}

// Preset palette for the color picker. Covers warm + cool + neutral so every
// category can find a visually distinct slot.
const COLOR_PALETTE = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#14b8a6', '#3b82f6', '#6366f1', '#a855f7',
  '#ec4899', '#64748b',
];

const CATEGORY_COLORS: Record<string, string> = {
  Default: '#4285f4',
  Home: '#4caf50',
  Work: '#ff9800',
  Favorites: '#e91e63',
  Custom: '#9c27b0',
};

function getCategoryColor(name: string): string {
  if (CATEGORY_COLORS[name]) return CATEGORY_COLORS[name];
  // Deterministic color from name
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 55%)`;
}

const BookmarkList: React.FC<BookmarkListProps> = ({
  bookmarks,
  categories,
  categoryColors,
  currentPosition,
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
  showOnMap = false,
  onShowOnMapChange,
  onImport,
  onBulkPaste,
  exportUrl,
}) => {
  // Prefer the stored color (set at creation, editable via color picker). Only
  // fall back to CATEGORY_COLORS / name hash for legacy categories that have
  // never had a color assigned.
  const resolveColor = (name: string): string => {
    const stored = categoryColors?.[name];
    if (stored) return stored;
    return getCategoryColor(name);
  };
  // Name of the category whose dot is currently being recolored (shows popover).
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  const t = useT();
  // Backend may store the built-in default category as the Chinese '預設'.
  // Translate at render time so EN users see "Default" without touching storage.
  const displayCat = (name: string) => (name === '預設' ? t('bm.default') : name);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [uiStateLoaded, setUiStateLoaded] = useState(false);
  const uiStateSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClickTs = useRef<number>(0);
  const [flashedBmId, setFlashedBmId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState(categories[0] || 'Default');
  const [showCategoryMgr, setShowCategoryMgr] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [editCategoryName, setEditCategoryName] = useState('');
  // Split "24.14, 120.65" (or tab/whitespace) into [lat, lng] so a user can
  // paste a Google-Maps-style pair into just the lat field instead of
  // splitting it themselves.
  const trySplitLatLng = (s: string): [string, string] | null => {
    const m = s.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\t ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    return m ? [m[1], m[2]] : null;
  };

  const [contextMenu, setContextMenu] = useState<{ bm: Bookmark; x: number; y: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  // Full edit dialog (name + lat + lng) — triggered by context menu "Edit".
  const [editDialog, setEditDialog] = useState<Bookmark | null>(null);
  const [editDialogName, setEditDialogName] = useState('');
  const [editDialogLat, setEditDialogLat] = useState('');
  const [editDialogLng, setEditDialogLng] = useState('');
  const [showCustomDialog, setShowCustomDialog] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customLat, setCustomLat] = useState('');
  const [customLng, setCustomLng] = useState('');
  const [customCategory, setCustomCategory] = useState(categories[0] || 'Default');
  const [search, setSearch] = useState('');
  // Reorder mode: when on, each category header in the manager panel and each
  // bookmark row inside its category shows up/down arrows + a drag handle that
  // persist a new order back to the backend. Off by default — must opt in.
  const [reorderMode, setReorderMode] = useState(false);
  // Saved sort mode from before entering reorder mode. Reorder mode forces
  // 'default' so the arrows / drag results match the displayed order; we
  // restore the previous sort when the user exits.
  const sortBeforeReorderRef = useRef<SortMode | null>(null);
  // Drag-and-drop state for in-list reordering. We track the dragged id so we
  // can highlight it (lower opacity), and the hover target so we can draw a
  // drop indicator line. Categories and bookmarks have separate slots so a
  // category drag doesn't reach into the bookmark list.
  const [draggedBmId, setDraggedBmId] = useState<string | null>(null);
  const [dragOverBmId, setDragOverBmId] = useState<string | null>(null);
  const [dragCatName, setDragCatName] = useState<string | null>(null);
  const [draggedCatName, setDraggedCatName] = useState<string | null>(null);
  const [dragOverCatName, setDragOverCatName] = useState<string | null>(null);
  // Multi-select mode: tick rows and batch-delete. When active, row clicks
  // toggle selection instead of teleporting.
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const exitMultiSelect = () => {
    setMultiSelect(false);
    setSelectedIds(new Set());
  };
  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    const msg = t('bm.delete_confirm').replace('{n}', String(selectedIds.size));
    if (!window.confirm(msg)) return;
    const ids = Array.from(selectedIds);
    await Promise.all(ids.map((id) => {
      try { return Promise.resolve(onBookmarkDelete(id)); } catch { return Promise.resolve(); }
    }));
    exitMultiSelect();
  };
  // "Click also flies GPS" toggle persisted in localStorage so the choice
  // survives restart. Default true = legacy behavior (clicking a bookmark
  // teleports iPhone). When false, click only pans the map view (preview).
  const [flyGps, setFlyGpsRaw] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem('locwarp.bookmark_fly_gps');
      // Default to true unless the user has explicitly stored '0'.
      return v === null ? true : v === '1';
    } catch { return true; }
  });
  const setFlyGps = (v: boolean) => {
    setFlyGpsRaw(v);
    try { localStorage.setItem('locwarp.bookmark_fly_gps', v ? '1' : '0'); } catch { /* ignore */ }
  };

  // Sort mode persisted in localStorage so it survives restart.
  type SortMode = 'default' | 'name' | 'date_added' | 'last_used';
  const [sortMode, setSortModeRaw] = useState<SortMode>(() => {
    try {
      const v = localStorage.getItem('locwarp.bookmark_sort') as SortMode | null;
      if (v === 'default' || v === 'name' || v === 'date_added' || v === 'last_used') return v;
    } catch { /* ignore */ }
    return 'default';
  });
  const setSortMode = (m: SortMode) => {
    setSortModeRaw(m);
    try { localStorage.setItem('locwarp.bookmark_sort', m); } catch { /* ignore */ }
  };

  const sortBookmarks = (list: Bookmark[]): Bookmark[] => {
    if (sortMode === 'default') return list;
    const copy = [...list];
    if (sortMode === 'name') {
      copy.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    } else if (sortMode === 'date_added') {
      copy.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    } else if (sortMode === 'last_used') {
      copy.sort((a, b) => (b.last_used_at || '').localeCompare(a.last_used_at || ''));
    }
    return copy;
  };

  // Close the context menu on ESC, or on any click / right-click that
  // isn't on the menu itself. Uses pointerdown so it fires before React
  // click handlers inside the menu.
  useEffect(() => {
    if (!contextMenu) return;
    const onOutside = (e: Event) => {
      const target = e.target as Element | null;
      if (target && target.closest?.('[data-bookmark-context-menu]')) return;
      setContextMenu(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    // Register on the next tick so the opening right-click's bubbling
    // doesn't dismiss the menu the moment we render it.
    const id = setTimeout(() => {
      document.addEventListener('pointerdown', onOutside);
      document.addEventListener('contextmenu', onOutside);
      document.addEventListener('keydown', onEsc);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('contextmenu', onOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }, [contextMenu]);

  // Dismiss the category color picker on outside click / ESC.
  useEffect(() => {
    if (!colorPickerFor) return;
    const onOutside = (e: Event) => {
      const t = e.target as Element | null;
      if (t && t.closest?.('[data-category-color-picker]')) return;
      setColorPickerFor(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setColorPickerFor(null);
    };
    const id = setTimeout(() => {
      document.addEventListener('pointerdown', onOutside);
      document.addEventListener('keydown', onEsc);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }, [colorPickerFor]);

  // Collapse state is persisted in ~/.locwarp/settings.json via the
  // /api/bookmarks/ui-state endpoint. The rule, designed so "paste a lot
  // of bookmarks and get them auto-collapsed" always works:
  //
  //   - While bookmarks.length > AUTO_COLLAPSE_THRESHOLD, all categories
  //     are collapsed by default. User can still manually expand one.
  //   - While <= threshold, use the user's saved expand list (or all
  //     expanded if never saved).
  //   - Crossing the threshold (up or down) resets state to the rule,
  //     so their manual choice from the other regime doesn't leak
  //     (e.g. they expanded two categories at 10 bookmarks, then bulk
  //     paste 50 more; those two no longer stay expanded after the
  //     crossing — user can re-expand if they want).
  //
  // We intentionally do NOT gate on a "user touched anything" flag,
  // because that confused the expected auto-collapse behaviour: a saved
  // list from an earlier session made the auto-rule inert when the
  // user pasted more bookmarks later.
  const savedExpandedRef = useRef<string[] | null>(null);
  const prevOverThresholdRef = useRef<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBookmarkUiState()
      .then((state) => {
        if (cancelled) return;
        savedExpandedRef.current = state.expanded_categories;
      })
      .catch(() => { /* leave null, auto-rule handles first load */ })
      .finally(() => { if (!cancelled) setUiStateLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!uiStateLoaded) return;
    if (categories.length === 0) return;
    const isOver = bookmarks.length > AUTO_COLLAPSE_THRESHOLD;
    const wasOver = prevOverThresholdRef.current;
    // Only reset when crossing the threshold, or on the very first eval.
    // Between crossings the user's manual toggles are preserved.
    if (wasOver === null || isOver !== wasOver) {
      if (isOver) {
        const all: Record<string, boolean> = {};
        categories.forEach((c) => { all[c] = true; });
        setCollapsed(all);
      } else {
        const saved = savedExpandedRef.current;
        if (saved === null) {
          setCollapsed({});
        } else {
          const savedSet = new Set(saved);
          const next: Record<string, boolean> = {};
          categories.forEach((c) => { next[c] = !savedSet.has(c); });
          setCollapsed(next);
        }
      }
    }
    prevOverThresholdRef.current = isOver;
  }, [uiStateLoaded, bookmarks.length, categories]);

  // Debounce saves so that rapid open/close of several categories sends
  // one POST 400ms after the last flip, not one per click.
  const scheduleUiStateSave = (nextCollapsed: Record<string, boolean>) => {
    if (!uiStateLoaded) return; // don't overwrite during initial fetch
    if (uiStateSaveTimer.current) clearTimeout(uiStateSaveTimer.current);
    uiStateSaveTimer.current = setTimeout(() => {
      const expanded = categories.filter((c) => !nextCollapsed[c]);
      void setBookmarkUiState(expanded).catch(() => { /* best effort */ });
    }, 400);
  };

  const toggleCategory = (cat: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [cat]: !prev[cat] };
      // Mirror to savedExpandedRef so a cross-down-under-threshold event
      // restores the user's most recent manual choice, not the stale
      // backend snapshot from session start.
      savedExpandedRef.current = categories.filter((c) => !next[c]);
      scheduleUiStateSave(next);
      return next;
    });
  };

  // Click handler: flash the bookmark green for 500ms as visual feedback
  // and apply a 150ms debounce so accidental double-clicks don't fire
  // twice (which on slow connections would race the teleport).
  // When `flyGps` is off and a preview handler is wired, we route to the
  // camera-only path instead of the GPS teleport.
  const handleBookmarkClick = (bm: Bookmark) => {
    const now = Date.now();
    if (now - lastClickTs.current < 150) return;
    lastClickTs.current = now;
    if (!flyGps && onBookmarkPreview) {
      onBookmarkPreview(bm);
    } else {
      onBookmarkClick(bm);
    }
    if (bm.id) {
      setFlashedBmId(bm.id);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashedBmId(null), 500);
    }
  };

  const handleAddBookmark = () => {
    if (!newName.trim() || !currentPosition) return;
    onBookmarkAdd({
      name: newName.trim(),
      lat: currentPosition.lat,
      lng: currentPosition.lng,
      category: newCategory,
    });
    setNewName('');
    setShowAddDialog(false);
  };

  const handleAddCustom = () => {
    const name = customName.trim();
    const lat = parseFloat(customLat);
    const lng = parseFloat(customLng);
    if (!name) return;
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return;
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return;
    onBookmarkAdd({ name, lat, lng, category: customCategory });
    setCustomName(''); setCustomLat(''); setCustomLng('');
    setShowCustomDialog(false);
  };

  const handleContextMenu = (e: React.MouseEvent, bm: Bookmark) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ bm, x: e.clientX, y: e.clientY });
  };

  const bookmarksByCategory = categories.reduce<Record<string, Bookmark[]>>((acc, cat) => {
    acc[cat] = bookmarks.filter((bm) => bm.category === cat);
    return acc;
  }, {});

  // Include uncategorized
  const uncategorized = bookmarks.filter((bm) => !categories.includes(bm.category));
  if (uncategorized.length > 0) {
    bookmarksByCategory['Uncategorized'] = uncategorized;
  }

  // Reorder mode only makes sense when sorted by the underlying 'default' order
  // (other sort modes would re-rank items and the arrows / drag would feel
  // broken). Entering reorder mode therefore forces sort to 'default' and we
  // restore the user's previous sort on exit.
  const enterReorderMode = () => {
    if (sortMode !== 'default') {
      sortBeforeReorderRef.current = sortMode;
      setSortMode('default');
    } else {
      sortBeforeReorderRef.current = null;
    }
    if (multiSelect) exitMultiSelect();
    setReorderMode(true);
  };
  const exitReorderMode = () => {
    setReorderMode(false);
    setDraggedBmId(null);
    setDragOverBmId(null);
    setDragCatName(null);
    setDraggedCatName(null);
    setDragOverCatName(null);
    const prev = sortBeforeReorderRef.current;
    if (prev && prev !== 'default') {
      setSortMode(prev);
    }
    sortBeforeReorderRef.current = null;
  };
  const reorderAvailable = reorderMode;
  // Reorder via drag-and-drop. Drop ONTO target = the dragged item takes the
  // target's display position; everything between them shifts to fill the gap.
  const dropBookmarkOn = (cat: string, srcId: string, dstId: string) => {
    if (!onBookmarkReorder || srcId === dstId) return;
    const list = bookmarksByCategory[cat] || [];
    const srcIdx = list.findIndex((b) => b.id === srcId);
    const dstIdx = list.findIndex((b) => b.id === dstId);
    if (srcIdx < 0 || dstIdx < 0) return;
    const arr = [...list];
    const [moved] = arr.splice(srcIdx, 1);
    arr.splice(dstIdx, 0, moved);
    onBookmarkReorder(cat, arr.map((b) => b.id || '').filter(Boolean));
  };
  const dropCategoryOn = (srcCat: string, dstCat: string) => {
    if (!onCategoryReorder || srcCat === dstCat) return;
    const srcIdx = categories.indexOf(srcCat);
    const dstIdx = categories.indexOf(dstCat);
    if (srcIdx < 0 || dstIdx < 0) return;
    const arr = [...categories];
    const [moved] = arr.splice(srcIdx, 1);
    arr.splice(dstIdx, 0, moved);
    onCategoryReorder(arr);
  };

  // Auto-scroll the surrounding scrollable container while a drag is in
  // progress: HTML5 native DnD's built-in edge-scroll is sluggish and barely
  // triggers on long lists, so we drive it from a rAF loop ourselves. Wheel
  // events keep working as normal (Chromium delivers them through dragover).
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragCursorYRef = useRef(0);
  useEffect(() => {
    const dragging = !!(draggedBmId || draggedCatName);
    if (!dragging) return;
    let scroller: HTMLElement | null = wrapRef.current?.parentElement ?? null;
    while (scroller) {
      const cs = getComputedStyle(scroller);
      const scrollable = (cs.overflowY === 'auto' || cs.overflowY === 'scroll')
        && scroller.scrollHeight > scroller.clientHeight + 1;
      if (scrollable) break;
      scroller = scroller.parentElement;
    }
    if (!scroller) return;
    const onDragOver = (e: DragEvent) => {
      dragCursorYRef.current = e.clientY;
    };
    window.addEventListener('dragover', onDragOver);
    const EDGE = 80;
    const MAX_SPEED = 18;
    let raf = 0;
    const tick = () => {
      const el = scroller!;
      const r = el.getBoundingClientRect();
      const y = dragCursorYRef.current;
      if (y > 0) {
        const fromTop = y - r.top;
        const fromBottom = r.bottom - y;
        if (fromTop >= 0 && fromTop < EDGE) {
          el.scrollTop -= MAX_SPEED * (1 - fromTop / EDGE);
        } else if (fromBottom >= 0 && fromBottom < EDGE) {
          el.scrollTop += MAX_SPEED * (1 - fromBottom / EDGE);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('dragover', onDragOver);
    };
  }, [draggedBmId, draggedCatName]);

  return (
    <div ref={wrapRef}>
      {/* Row 1: the two primary "add" actions. Kept on their own row so the
          secondary tools (export / import / multi-select / reorder / gear)
          don't push them off-screen on narrow library panels. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <button
          className="action-btn"
          onClick={() => setShowAddDialog(!showAddDialog)}
          style={{ padding: '3px 8px', fontSize: 12 }}
          title={t('bm.add_here')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {t('bm.add')}
        </button>
        <button
          className="action-btn"
          onClick={() => {
            setCustomCategory(categories[0] || 'Default');
            setShowCustomDialog(true);
          }}
          style={{ padding: '3px 8px', fontSize: 12 }}
          title={t('bm.add_custom_tooltip')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="10" r="3" />
            <path d="M12 2a8 8 0 00-8 8c0 6 8 12 8 12s8-6 8-12a8 8 0 00-8-8z" />
          </svg>
          {t('bm.add_custom')}
        </button>
        {exportUrl && (
          <a
            className="action-btn"
            href={exportUrl}
            download="bookmarks.json"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 8px', fontSize: 12, cursor: 'pointer',
              textDecoration: 'none',
            }}
            title={t('bm.export_tooltip')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {t('bm.export')}
          </a>
        )}
        {onImport && (
          <label
            className="action-btn"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 8px', fontSize: 12, cursor: 'pointer',
            }}
            title={t('bm.import_tooltip')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            {t('bm.import')}
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) await onImport(f);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>
      {/* Row 2: secondary tools (bulk paste / multi-select / reorder /
          manage categories). Icon-only to keep the row compact. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        {onBulkPaste && (
          <button
            className="action-btn"
            onClick={onBulkPaste}
            style={{ padding: '3px 6px', fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
            title={t('bm.bulk_paste_tooltip')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              <line x1="15" y1="12" x2="18" y2="12" />
              <line x1="15" y1="16" x2="18" y2="16" />
            </svg>
          </button>
        )}
        <button
          className="action-btn"
          onClick={() => {
            if (multiSelect) {
              exitMultiSelect();
            } else {
              // Opening multi-select closes any other mutually-exclusive
              // panel that'd otherwise stack on top and confuse the user.
              setShowCategoryMgr(false);
              setMultiSelect(true);
              if (reorderMode) exitReorderMode();
            }
          }}
          style={{
            padding: '3px 6px', fontSize: 12, display: 'inline-flex', alignItems: 'center',
            background: multiSelect ? 'rgba(108,140,255,0.2)' : undefined,
            borderColor: multiSelect ? 'rgba(108,140,255,0.6)' : undefined,
          }}
          title={multiSelect ? t('bm.exit_multi_select') : t('bm.multi_select_tooltip')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 11 12 14 22 4" />
            <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
          </svg>
        </button>
        {(onCategoryReorder || onBookmarkReorder) && (
          <button
            className="action-btn"
            onClick={() => {
              if (reorderMode) exitReorderMode();
              else enterReorderMode();
            }}
            style={{
              padding: '3px 6px', fontSize: 12, display: 'inline-flex', alignItems: 'center',
              background: reorderMode ? 'rgba(108,140,255,0.2)' : undefined,
              borderColor: reorderMode ? 'rgba(108,140,255,0.6)' : undefined,
            }}
            title={t('bm.reorder_tooltip')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="17 11 12 6 7 11" />
              <polyline points="17 17 12 22 7 17" />
              <line x1="12" y1="6" x2="12" y2="22" />
            </svg>
          </button>
        )}
        <button
          className="action-btn"
          onClick={() => {
            setShowCategoryMgr((prev) => {
              const next = !prev;
              if (next && multiSelect) exitMultiSelect();
              return next;
            });
          }}
          style={{ padding: '3px 8px', fontSize: 12 }}
          title={t('bm.manage_categories')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
      </div>

      {/* Search box. Sticks to top of the scroll container so users with
          long lists don't have to scroll back up to start a new search. */}
      <div style={{
        position: 'sticky', top: -12, zIndex: 5,
        background: '#1e1e24',
        marginLeft: -12, marginRight: -12,
        padding: '8px 12px',
        borderBottom: '1px solid rgba(108, 140, 255, 0.08)',
        marginBottom: 8,
      }}>
        <div style={{ position: 'relative' }}>
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2"
          style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', opacity: 0.4, pointerEvents: 'none' }}
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="search-input"
          placeholder={t('bm.search_placeholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: '100%', paddingLeft: 26, paddingRight: search ? 24 : 8, fontSize: 12 }}
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            title={t('bm.search_clear')}
            style={{
              position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', color: '#bbb',
              cursor: 'pointer', padding: '2px 6px', fontSize: 14, lineHeight: 1,
            }}
          >×</button>
        )}
        </div>
      </div>

      {/* Show-all-on-map toggle */}
      {onShowOnMapChange && (
        <label
          className="lw-checkbox"
          style={{ display: 'flex', marginTop: 8, fontSize: 11.5 }}
        >
          <input
            type="checkbox"
            checked={showOnMap}
            onChange={(e) => onShowOnMapChange(e.target.checked)}
          />
          <span className="lw-checkbox-box"></span>
          <span className="lw-checkbox-label">{t('bm.show_on_map')}</span>
        </label>
      )}

      {/* Click-also-flies-GPS toggle. Only useful when the parent wires up
          the camera-only preview path; otherwise hide so the checkbox
          doesn't look like a no-op. */}
      {onBookmarkPreview && (
        <label
          className="lw-checkbox"
          title={t('bm.fly_gps_tooltip')}
          style={{ display: 'flex', marginTop: 6, fontSize: 11.5 }}
        >
          <input
            type="checkbox"
            checked={flyGps}
            onChange={(e) => setFlyGps(e.target.checked)}
          />
          <span className="lw-checkbox-box"></span>
          <span className="lw-checkbox-label">{t('bm.fly_gps')}</span>
        </label>
      )}

      {/* Sort control — choose how the bookmark list is ordered. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 11, color: '#bbb' }}>
        <span style={{ opacity: 0.7 }}>{t('bm.sort_label')}</span>
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          style={{
            flex: 1, background: '#1e1e22', color: '#e0e0e0',
            border: '1px solid rgba(255,255,255,0.12)', borderRadius: 4,
            padding: '3px 6px', fontSize: 11,
          }}
        >
          {/* Explicit inline colors so the popup list is readable on
              Windows native select dropdown (which defaults to white bg). */}
          <option value="default" style={{ background: '#1e1e22', color: '#e0e0e0' }}>{t('bm.sort_default')}</option>
          <option value="name" style={{ background: '#1e1e22', color: '#e0e0e0' }}>{t('bm.sort_name')}</option>
          <option value="date_added" style={{ background: '#1e1e22', color: '#e0e0e0' }}>{t('bm.sort_date_added')}</option>
          <option value="last_used" style={{ background: '#1e1e22', color: '#e0e0e0' }}>{t('bm.sort_last_used')}</option>
        </select>
      </div>

      {/* Add bookmark dialog */}
      {showAddDialog && (
        <div
          style={{
            background: '#2a2a2e',
            border: '1px solid #444',
            borderRadius: 6,
            padding: 12,
            marginBottom: 8,
          }}
        >
          <input
            type="text"
            className="search-input"
            placeholder={t('bm.name_placeholder')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddBookmark()}
            style={{ width: '100%', marginBottom: 8 }}
            autoFocus
          />
          <select
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            style={{
              width: '100%',
              marginBottom: 8,
              padding: '6px 8px',
              background: '#1e1e22',
              color: '#e0e0e0',
              border: '1px solid #444',
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {displayCat(cat)}
              </option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="action-btn primary" onClick={handleAddBookmark} style={{ flex: 1, fontSize: 12 }}>
              {t('generic.save')}
            </button>
            <button className="action-btn" onClick={() => setShowAddDialog(false)} style={{ fontSize: 12 }}>
              {t('generic.cancel')}
            </button>
          </div>
          {!currentPosition && (
            <div style={{ fontSize: 11, color: '#f44336', marginTop: 6 }}>
              {t('bm.no_position')}
            </div>
          )}
        </div>
      )}

      {/* Category manager */}
      {showCategoryMgr && (
        <div
          style={{
            background: '#2a2a2e',
            border: '1px solid #444',
            borderRadius: 6,
            padding: 12,
            marginBottom: 8,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, opacity: 0.7 }}>
            {t('bm.manage_categories')}
          </div>
          {categories.map((cat) => (
            <div
              key={cat}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 0',
                fontSize: 12,
                position: 'relative',
              }}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!onCategoryRecolor) return;
                  setColorPickerFor((prev) => (prev === cat ? null : cat));
                }}
                title={t('bm.recolor_tooltip')}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: resolveColor(cat),
                  border: '1.5px solid rgba(255,255,255,0.15)',
                  padding: 0,
                  cursor: onCategoryRecolor ? 'pointer' : 'default',
                  flexShrink: 0,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                }}
              />
              {colorPickerFor === cat && onCategoryRecolor && (
                <div
                  data-category-color-picker
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute',
                    top: 22, left: 0, zIndex: 50,
                    background: '#1e1e22',
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: 6,
                    padding: 6,
                    boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
                    display: 'grid',
                    gridTemplateColumns: 'repeat(5, 22px)',
                    gap: 4,
                  }}
                >
                  {COLOR_PALETTE.map((c) => {
                    const selected = resolveColor(cat).toLowerCase() === c.toLowerCase();
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCategoryRecolor(cat, c);
                          setColorPickerFor(null);
                        }}
                        style={{
                          width: 22, height: 22, borderRadius: '50%',
                          background: c,
                          border: selected
                            ? '2px solid #fff'
                            : '1.5px solid rgba(255,255,255,0.12)',
                          cursor: 'pointer', padding: 0,
                          transition: 'transform 0.1s',
                        }}
                        title={c}
                      />
                    );
                  })}
                  <input
                    type="color"
                    value={resolveColor(cat)}
                    onChange={(e) => onCategoryRecolor(cat, e.target.value)}
                    title={t('bm.recolor_custom')}
                    style={{
                      gridColumn: '1 / span 5',
                      width: '100%', height: 22,
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: 4, padding: 0, marginTop: 2,
                      background: '#1e1e22',
                      cursor: 'pointer',
                    }}
                  />
                </div>
              )}
              {editingCategory === cat ? (
                <input
                  type="text"
                  className="search-input"
                  autoFocus
                  value={editCategoryName}
                  onChange={(e) => setEditCategoryName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const next = editCategoryName.trim();
                      if (next && next !== cat && onCategoryRename) onCategoryRename(cat, next);
                      setEditingCategory(null);
                    }
                    if (e.key === 'Escape') setEditingCategory(null);
                  }}
                  onBlur={() => setEditingCategory(null)}
                  style={{ flex: 1, padding: '2px 4px', fontSize: 12 }}
                />
              ) : (
                <span style={{ flex: 1 }}>{displayCat(cat)}</span>
              )}
              {cat !== 'Default' && cat !== '預設' && onCategoryRename && editingCategory !== cat && (
                <button
                  onClick={() => { setEditingCategory(cat); setEditCategoryName(cat); }}
                  title={t('bm.rename_category')}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--fg-muted, #888)',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                    <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
              )}
              {cat !== 'Default' && cat !== '預設' && (
                <button
                  onClick={() => onCategoryDelete(cat)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#f44336',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input
              type="text"
              className="search-input"
              placeholder={t('bm.add_category')}
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newCategoryName.trim()) {
                  onCategoryAdd(newCategoryName.trim());
                  setNewCategoryName('');
                }
              }}
              style={{ flex: 1 }}
            />
            <button
              className="action-btn"
              onClick={() => {
                if (newCategoryName.trim()) {
                  onCategoryAdd(newCategoryName.trim());
                  setNewCategoryName('');
                }
              }}
              style={{ fontSize: 11 }}
            >
              {t('bm.new_category')}
            </button>
          </div>
        </div>
      )}

      {/* Search mode: flat filtered list, no category grouping */}
      {search.trim() !== '' && (() => {
        const q = search.trim().toLowerCase();
        const matches = sortBookmarks(bookmarks.filter((bm) => {
          const name = (bm.name ?? '').toLowerCase();
          const coord = `${bm.lat.toFixed(5)}, ${bm.lng.toFixed(5)}`;
          return name.includes(q) || coord.includes(q);
        }));
        if (matches.length === 0) {
          return (
            <div style={{ fontSize: 12, opacity: 0.5, padding: '10px 0', textAlign: 'center' }}>
              {t('bm.search_no_results')}
            </div>
          );
        }
        return (
          <div style={{ paddingLeft: 4 }}>
            {matches.map((bm) => {
              const isSelected = bm.id ? selectedIds.has(bm.id) : false;
              return (
                <div
                  key={bm.id ?? `${bm.lat}-${bm.lng}`}
                  className="bookmark-item"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '5px 6px', cursor: 'pointer',
                    borderRadius: 4, fontSize: 12, transition: 'background 0.15s',
                    background: bm.id && flashedBmId === bm.id
                      ? 'rgba(34, 197, 94, 0.22)'
                      : (multiSelect && isSelected ? 'rgba(108,140,255,0.18)' : 'transparent'),
                  }}
                  onClick={() => {
                    if (multiSelect) {
                      if (bm.id) toggleSelected(bm.id);
                    } else {
                      handleBookmarkClick(bm);
                    }
                  }}
                  onContextMenu={(e) => { if (!multiSelect) handleContextMenu(e, bm); else e.preventDefault(); }}
                  onMouseEnter={(e) => {
                    if (!(multiSelect && isSelected) && !(bm.id && flashedBmId === bm.id)) (e.currentTarget as HTMLDivElement).style.background = '#3a3a3e';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = bm.id && flashedBmId === bm.id
                      ? 'rgba(34, 197, 94, 0.22)'
                      : (multiSelect && isSelected ? 'rgba(108,140,255,0.18)' : 'transparent');
                  }}
                >
                  {multiSelect && (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => { if (bm.id) toggleSelected(bm.id); }}
                      onClick={(e) => e.stopPropagation()}
                      style={{ margin: 0, flexShrink: 0 }}
                    />
                  )}
                  <div
                    style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: resolveColor(bm.category), flexShrink: 0,
                    }}
                    title={displayCat(bm.category)}
                  />
                  {bm.country_code && (
                    <img
                      src={`https://flagcdn.com/w20/${bm.country_code}.png`}
                      alt={bm.country_code.toUpperCase()}
                      title={bm.country_code.toUpperCase()}
                      width={14}
                      height={10}
                      style={{ borderRadius: 2, flexShrink: 0, boxShadow: '0 0 0 1px rgba(255,255,255,0.12)' }}
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                  )}
                  <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {bm.name}
                    </span>
                    <span style={{ fontSize: 10, opacity: 0.55, fontFamily: 'monospace' }}>
                      {displayCat(bm.category)} · {bm.lat.toFixed(5)}, {bm.lng.toFixed(5)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Bookmark groups — only when NOT searching */}
      {search.trim() === '' && Object.entries(bookmarksByCategory).map(([cat, bms]) => {
        const catIds = bms.map((b) => b.id).filter((x): x is string => !!x);
        const selectedInCat = catIds.filter((id) => selectedIds.has(id)).length;
        const allSelectedInCat = catIds.length > 0 && selectedInCat === catIds.length;
        const someSelectedInCat = selectedInCat > 0 && !allSelectedInCat;
        return (
        <div key={cat} className="bookmark-group" style={{ marginBottom: 4 }}>
          <div
            draggable={reorderAvailable && !!onCategoryReorder && cat !== 'Uncategorized'}
            onDragStart={(e) => {
              if (!reorderAvailable || !onCategoryReorder || cat === 'Uncategorized') return;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('application/x-locwarp-cat', cat);
              setDraggedCatName(cat);
            }}
            onDragOver={(e) => {
              if (!reorderAvailable || !draggedCatName || cat === 'Uncategorized') return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDragOverCatName(cat);
            }}
            onDragLeave={() => {
              if (dragOverCatName === cat) setDragOverCatName(null);
            }}
            onDrop={(e) => {
              if (!reorderAvailable || cat === 'Uncategorized') return;
              e.preventDefault();
              const src = draggedCatName || e.dataTransfer.getData('application/x-locwarp-cat');
              if (src) dropCategoryOn(src, cat);
              setDraggedCatName(null);
              setDragOverCatName(null);
            }}
            onDragEnd={() => { setDraggedCatName(null); setDragOverCatName(null); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 4px',
              cursor: reorderAvailable && cat !== 'Uncategorized' ? 'grab' : 'pointer',
              fontSize: 12,
              fontWeight: 600,
              opacity: draggedCatName === cat ? 0.4 : 0.8,
              borderTop: dragOverCatName === cat && draggedCatName && draggedCatName !== cat
                ? '2px solid #6c8cff' : '2px solid transparent',
              userSelect: reorderAvailable ? 'none' : undefined,
            }}
            onClick={() => toggleCategory(cat)}
          >
            {reorderAvailable && cat !== 'Uncategorized' && onCategoryReorder && (
              <span style={{ opacity: 0.55, flexShrink: 0, display: 'inline-flex', alignItems: 'center', cursor: 'grab' }} title={t('bm.reorder_drag_hint')}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="4" y1="8" x2="20" y2="8" />
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <line x1="4" y1="16" x2="20" y2="16" />
                </svg>
              </span>
            )}
            {multiSelect && (
              <input
                type="checkbox"
                checked={allSelectedInCat}
                ref={(el) => { if (el) el.indeterminate = someSelectedInCat; }}
                onChange={() => {
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (allSelectedInCat) {
                      catIds.forEach((id) => next.delete(id));
                    } else {
                      catIds.forEach((id) => next.add(id));
                    }
                    return next;
                  });
                }}
                onClick={(e) => e.stopPropagation()}
                style={{ margin: 0, flexShrink: 0, cursor: 'pointer' }}
                title={allSelectedInCat ? t('bm.deselect_category') : t('bm.select_category')}
              />
            )}
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              style={{
                transform: collapsed[cat] ? 'rotate(0deg)' : 'rotate(90deg)',
                transition: 'transform 0.2s',
              }}
            >
              <polyline points="9,18 15,12 9,6" />
            </svg>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: resolveColor(cat),
                flexShrink: 0,
              }}
            />
            <span>{displayCat(cat)}</span>
            <span style={{ marginLeft: 'auto', opacity: 0.4, fontWeight: 400, fontSize: 10 }}>
              {bms.length}
            </span>
          </div>

          {!collapsed[cat] && (
            <div style={{ paddingLeft: 20 }}>
              {bms.length === 0 && (
                <div style={{ fontSize: 11, opacity: 0.4, padding: '4px 0' }}>{t('bm.blank')}</div>
              )}
              {sortBookmarks(bms).map((bm) => {
                const isSelected = bm.id ? selectedIds.has(bm.id) : false;
                const canDragRow = reorderAvailable && !!onBookmarkReorder && !!bm.id && cat !== 'Uncategorized';
                return (
                  <div
                    key={bm.id ?? `${bm.lat}-${bm.lng}`}
                    className="bookmark-item"
                    draggable={canDragRow}
                    onDragStart={(e) => {
                      if (!canDragRow || !bm.id) return;
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('application/x-locwarp-bm', `${cat}::${bm.id}`);
                      setDraggedBmId(bm.id);
                      setDragCatName(cat);
                    }}
                    onDragOver={(e) => {
                      if (!canDragRow || !draggedBmId || dragCatName !== cat) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (bm.id) setDragOverBmId(bm.id);
                    }}
                    onDragLeave={() => {
                      if (dragOverBmId === bm.id) setDragOverBmId(null);
                    }}
                    onDrop={(e) => {
                      if (!canDragRow || !bm.id) return;
                      e.preventDefault();
                      const src = draggedBmId;
                      if (src && dragCatName === cat) dropBookmarkOn(cat, src, bm.id);
                      setDraggedBmId(null);
                      setDragOverBmId(null);
                      setDragCatName(null);
                    }}
                    onDragEnd={() => { setDraggedBmId(null); setDragOverBmId(null); setDragCatName(null); }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '5px 6px',
                      cursor: canDragRow ? 'grab' : 'pointer',
                      borderRadius: 4,
                      fontSize: 12,
                      transition: 'background 0.15s',
                      background: bm.id && flashedBmId === bm.id
                        ? 'rgba(34, 197, 94, 0.22)'
                        : (multiSelect && isSelected ? 'rgba(108,140,255,0.18)' : 'transparent'),
                      opacity: draggedBmId === bm.id ? 0.4 : 1,
                      borderTop: dragOverBmId === bm.id && draggedBmId && draggedBmId !== bm.id
                        ? '2px solid #6c8cff' : '2px solid transparent',
                      userSelect: canDragRow ? 'none' : undefined,
                    }}
                    onClick={() => {
                      if (multiSelect) {
                        if (bm.id) toggleSelected(bm.id);
                      } else if (!reorderAvailable) {
                        handleBookmarkClick(bm);
                      }
                    }}
                    onContextMenu={(e) => { if (!multiSelect && !reorderAvailable) handleContextMenu(e, bm); else e.preventDefault(); }}
                    onMouseEnter={(e) => {
                      if (!(multiSelect && isSelected) && !(bm.id && flashedBmId === bm.id)) (e.currentTarget as HTMLDivElement).style.background = '#3a3a3e';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.background = bm.id && flashedBmId === bm.id
                        ? 'rgba(34, 197, 94, 0.22)'
                        : (multiSelect && isSelected ? 'rgba(108,140,255,0.18)' : 'transparent');
                    }}
                  >
                    {canDragRow && (
                      <span style={{ opacity: 0.55, flexShrink: 0, display: 'inline-flex', alignItems: 'center', cursor: 'grab' }} title={t('bm.reorder_drag_hint')}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="4" y1="8" x2="20" y2="8" />
                          <line x1="4" y1="12" x2="20" y2="12" />
                          <line x1="4" y1="16" x2="20" y2="16" />
                        </svg>
                      </span>
                    )}
                    {multiSelect && (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => { if (bm.id) toggleSelected(bm.id); }}
                        onClick={(e) => e.stopPropagation()}
                        style={{ margin: 0, flexShrink: 0 }}
                      />
                    )}
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      style={{ opacity: 0.5, flexShrink: 0 }}
                    >
                      <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
                    </svg>
                    {bm.country_code && (
                      <img
                        src={`https://flagcdn.com/w20/${bm.country_code}.png`}
                        alt={bm.country_code.toUpperCase()}
                        title={bm.country_code.toUpperCase()}
                        width={14}
                        height={10}
                        style={{ borderRadius: 2, flexShrink: 0, boxShadow: '0 0 0 1px rgba(255,255,255,0.12)' }}
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                    )}
                    {editingId === bm.id ? (
                      <input
                        type="text"
                        className="search-input"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && bm.id) {
                            onBookmarkEdit(bm.id, { name: editName });
                            setEditingId(null);
                          }
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        onBlur={() => setEditingId(null)}
                        onClick={(e) => e.stopPropagation()}
                        style={{ flex: 1, padding: '2px 4px', fontSize: 11 }}
                        autoFocus
                      />
                    ) : (
                      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {bm.name}
                        </span>
                        <span style={{ fontSize: 10, opacity: 0.55, fontFamily: 'monospace' }}>
                          {bm.lat.toFixed(5)}, {bm.lng.toFixed(5)}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        );
      })}

      {bookmarks.length === 0 && (
        <div style={{ fontSize: 12, opacity: 0.5, padding: '8px 0', textAlign: 'center' }}>
          {t('bm.empty')}
        </div>
      )}

      {/* Multi-select toolbar — sticks to the bottom of the scroll area
          so the user can scroll through the list unchecking items to
          keep, then hit Delete without scrolling back up. */}
      {multiSelect && (
        <div
          style={{
            position: 'sticky',
            bottom: -12, zIndex: 10,
            marginLeft: -12, marginRight: -12,
            marginTop: 16,
            padding: '8px 12px',
            background: 'rgba(26, 29, 39, 0.98)',
            backdropFilter: 'blur(6px)',
            borderTop: '1px solid rgba(108,140,255,0.35)',
            boxShadow: '0 -6px 12px rgba(0,0,0,0.35)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <button
              className="action-btn"
              onClick={() => {
                const allIds = bookmarks.map((b) => b.id).filter((x): x is string => !!x);
                if (selectedIds.size === allIds.length) {
                  setSelectedIds(new Set());
                } else {
                  setSelectedIds(new Set(allIds));
                }
              }}
              style={{ padding: '3px 8px', fontSize: 11 }}
            >
              {selectedIds.size === bookmarks.length && bookmarks.length > 0
                ? t('bm.deselect_all')
                : t('bm.select_all')}
            </button>
            <span style={{ opacity: 0.7, marginLeft: 'auto' }}>
              {selectedIds.size} / {bookmarks.length}
            </span>
            <button
              className="action-btn"
              onClick={handleBulkDelete}
              disabled={selectedIds.size === 0}
              style={{
                padding: '3px 10px', fontSize: 11, fontWeight: 600,
                color: selectedIds.size === 0 ? '#888' : '#ff6b6b',
                borderColor: selectedIds.size === 0 ? undefined : 'rgba(255,107,107,0.4)',
                cursor: selectedIds.size === 0 ? 'not-allowed' : 'pointer',
              }}
            >
              {t('bm.delete_selected').replace('{n}', String(selectedIds.size))}
            </button>
          </div>
        </div>
      )}

      {/* Context menu (dismissed via document click listener — see useEffect) */}
      {contextMenu && createPortal(
        <>
          <div
            data-bookmark-context-menu
            style={{
              position: 'fixed',
              // Clamp to viewport so the menu never falls off-screen.
              left: Math.min(contextMenu.x, window.innerWidth - 160),
              top: Math.min(contextMenu.y, window.innerHeight - 200),
              zIndex: 9999,
              background: '#2a2a2e',
              border: '1px solid #444',
              borderRadius: 6,
              padding: '4px 0',
              boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              minWidth: 140,
            }}
          >
            <div
              style={ctxItemStyle}
              onMouseEnter={ctxHighlight}
              onMouseLeave={ctxUnhighlight}
              onClick={() => {
                const bm = contextMenu.bm;
                setEditDialog(bm);
                setEditDialogName(bm.name);
                setEditDialogLat(bm.lat.toString());
                setEditDialogLng(bm.lng.toString());
                setContextMenu(null);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6 }}>
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              {t('bm.edit')}
            </div>
            <div
              style={ctxItemStyle}
              onMouseEnter={ctxHighlight}
              onMouseLeave={ctxUnhighlight}
              onClick={async () => {
                const text = `${contextMenu.bm.name} ${contextMenu.bm.lat.toFixed(6)}, ${contextMenu.bm.lng.toFixed(6)}`;
                try {
                  await navigator.clipboard.writeText(text);
                } catch {
                  // Fallback for environments without clipboard API
                  const ta = document.createElement('textarea');
                  ta.value = text;
                  document.body.appendChild(ta);
                  ta.select();
                  try { document.execCommand('copy'); } catch { /* ignore */ }
                  document.body.removeChild(ta);
                }
                setContextMenu(null);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6 }}>
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
              {t('bm.copy')}
            </div>
            {contextMenu.bm.id && (
              <div
                style={ctxItemStyle}
                onMouseEnter={ctxHighlight}
                onMouseLeave={ctxUnhighlight}
                onClick={() => {
                  if (contextMenu.bm.id) window.open(bookmarkGpxExportUrl(contextMenu.bm.id), '_blank');
                  setContextMenu(null);
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6 }}>
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {t('bm.export_gpx')}
              </div>
            )}
            <div
              style={ctxItemStyle}
              onMouseEnter={ctxHighlight}
              onMouseLeave={ctxUnhighlight}
              onClick={() => {
                if (contextMenu.bm.id) onBookmarkDelete(contextMenu.bm.id);
                setContextMenu(null);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f44336" strokeWidth="2" style={{ marginRight: 6 }}>
                <polyline points="3,6 5,6 21,6" />
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
              <span style={{ color: '#f44336' }}>{t('generic.delete')}</span>
            </div>
            {categories.length > 1 && (
              <>
                <div style={{ height: 1, background: '#444', margin: '4px 0' }} />
                <div style={{ padding: '4px 12px', fontSize: 10, opacity: 0.5 }}>{t('bm.move_to')}</div>
                {categories
                  .filter((c) => c !== contextMenu.bm.category)
                  .map((cat) => (
                    <div
                      key={cat}
                      style={ctxItemStyle}
                      onMouseEnter={ctxHighlight}
                      onMouseLeave={ctxUnhighlight}
                      onClick={() => {
                        if (contextMenu.bm.id) {
                          onBookmarkEdit(contextMenu.bm.id, { category: cat });
                        }
                        setContextMenu(null);
                      }}
                    >
                      <div
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: resolveColor(cat),
                          marginRight: 6,
                        }}
                      />
                      {displayCat(cat)}
                    </div>
                  ))}
              </>
            )}
          </div>
        </>,
        document.body,
      )}

      {/* Edit dialog — name + lat + lng */}
      {editDialog && createPortal(
        <div
          onClick={() => setEditDialog(null)}
          className="anim-fade-in"
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(8, 10, 20, 0.55)',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            className="anim-scale-in"
            style={{
              background: 'rgba(26, 29, 39, 0.96)',
              backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
              border: '1px solid rgba(108, 140, 255, 0.2)',
              borderRadius: 12, padding: 18, width: 320, color: '#e0e0e0',
              boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05) inset',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
              {t('bm.edit')}
            </div>
            <input
              type="text"
              className="search-input"
              placeholder={t('bm.name_placeholder')}
              value={editDialogName}
              autoFocus
              onChange={(e) => setEditDialogName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditDialog(null);
              }}
              style={{ width: '100%', marginBottom: 8 }}
            />
            {/* Single 'lat, lng' field — paste or type the whole pair here.
                The trySplitLatLng helper also accepts tab/space separators. */}
            <input
              type="text"
              className="search-input"
              inputMode="decimal"
              placeholder={t('bm.latlng_single_placeholder')}
              value={
                editDialogLat && editDialogLng
                  ? `${editDialogLat}, ${editDialogLng}`
                  : editDialogLat || editDialogLng
              }
              onChange={(e) => {
                const v = e.target.value;
                const split = trySplitLatLng(v);
                if (split) { setEditDialogLat(split[0]); setEditDialogLng(split[1]); }
                else {
                  // User is still typing the lat part; keep raw text in lat
                  // and clear lng until a valid pair is detected.
                  setEditDialogLat(v);
                  setEditDialogLng('');
                }
              }}
              style={{ width: '100%', marginBottom: 12 }}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="action-btn primary"
                style={{ flex: 1 }}
                disabled={
                  !editDialogName.trim() ||
                  !Number.isFinite(parseFloat(editDialogLat)) ||
                  !Number.isFinite(parseFloat(editDialogLng))
                }
                onClick={() => {
                  const lat = parseFloat(editDialogLat);
                  const lng = parseFloat(editDialogLng);
                  if (!editDialog.id) { setEditDialog(null); return; }
                  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return;
                  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return;
                  // Backend PUT requires the full Bookmark shape, so merge
                  // the edits over the original to keep category + address.
                  onBookmarkEdit(editDialog.id, {
                    ...editDialog,
                    name: editDialogName.trim(),
                    lat, lng,
                  });
                  setEditDialog(null);
                }}
              >{t('generic.save')}</button>
              <button className="action-btn" onClick={() => setEditDialog(null)}>
                {t('generic.cancel')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {showCustomDialog && createPortal(
        <div
          onClick={() => setShowCustomDialog(false)}
          className="anim-fade-in"
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(8, 10, 20, 0.55)',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="anim-scale-in"
            style={{
              background: 'rgba(26, 29, 39, 0.96)',
              backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
              border: '1px solid rgba(108, 140, 255, 0.2)',
              borderRadius: 12, padding: 18, width: 320, color: '#e0e0e0',
              boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05) inset',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
              {t('bm.add_custom')}
            </div>
            <input
              type="text"
              className="search-input"
              placeholder={t('bm.name_placeholder')}
              value={customName}
              autoFocus
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddCustom();
                if (e.key === 'Escape') setShowCustomDialog(false);
              }}
              style={{ width: '100%', marginBottom: 8 }}
            />
            {/* Single 'lat, lng' field. Paste or type the whole pair. */}
            <input
              type="text"
              className="search-input"
              inputMode="decimal"
              placeholder={t('bm.latlng_single_placeholder')}
              value={
                customLat && customLng
                  ? `${customLat}, ${customLng}`
                  : customLat || customLng
              }
              onChange={(e) => {
                const v = e.target.value;
                const split = trySplitLatLng(v);
                if (split) { setCustomLat(split[0]); setCustomLng(split[1]); }
                else { setCustomLat(v); setCustomLng(''); }
              }}
              style={{ width: '100%', marginBottom: 8 }}
            />
            <select
              value={customCategory}
              onChange={(e) => setCustomCategory(e.target.value)}
              style={{
                width: '100%', marginBottom: 12, padding: '6px 8px',
                background: '#1e1e22', color: '#e0e0e0', border: '1px solid #444',
                borderRadius: 4, fontSize: 12,
              }}
            >
              {categories.map((c) => (
                <option key={c} value={c}>{displayCat(c)}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="action-btn primary"
                style={{ flex: 1 }}
                disabled={
                  !customName.trim() ||
                  !Number.isFinite(parseFloat(customLat)) ||
                  !Number.isFinite(parseFloat(customLng))
                }
                onClick={handleAddCustom}
              >{t('generic.add')}</button>
              <button className="action-btn" onClick={() => setShowCustomDialog(false)}>
                {t('generic.cancel')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

const ctxItemStyle: React.CSSProperties = {
  padding: '6px 12px',
  cursor: 'pointer',
  fontSize: 12,
  display: 'flex',
  alignItems: 'center',
  color: '#e0e0e0',
  transition: 'background 0.15s',
};

function ctxHighlight(e: React.MouseEvent<HTMLDivElement>) {
  (e.currentTarget as HTMLDivElement).style.background = '#3a3a3e';
}
function ctxUnhighlight(e: React.MouseEvent<HTMLDivElement>) {
  (e.currentTarget as HTMLDivElement).style.background = 'transparent';
}

export default BookmarkList;
