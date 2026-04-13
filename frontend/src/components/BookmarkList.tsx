import React, { useState, useEffect } from 'react';
import { useT } from '../i18n';

interface Bookmark {
  id?: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
}

interface Position {
  lat: number;
  lng: number;
}

interface BookmarkListProps {
  bookmarks: Bookmark[];
  categories: string[];
  currentPosition: Position | null;
  onBookmarkClick: (bm: Bookmark) => void;
  onBookmarkAdd: (bm: Bookmark) => void;
  onBookmarkDelete: (id: string) => void;
  onBookmarkEdit: (id: string, bm: Partial<Bookmark>) => void;
  onCategoryAdd: (name: string) => void;
  onCategoryDelete: (name: string) => void;
  onImport?: (file: File) => Promise<void>;
  exportUrl?: string;
}

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
  currentPosition,
  onBookmarkClick,
  onBookmarkAdd,
  onBookmarkDelete,
  onBookmarkEdit,
  onCategoryAdd,
  onCategoryDelete,
  onImport,
  exportUrl,
}) => {
  const t = useT();
  // Backend may store the built-in default category as the Chinese '預設'.
  // Translate at render time so EN users see "Default" without touching storage.
  const displayCat = (name: string) => (name === '預設' ? t('bm.default') : name);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState(categories[0] || 'Default');
  const [showCategoryMgr, setShowCategoryMgr] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [contextMenu, setContextMenu] = useState<{ bm: Bookmark; x: number; y: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  // Close the context menu on any document click outside of it.
  // Using a document-level listener (instead of a full-screen overlay div)
  // avoids the bug where a stuck overlay blocks all user interaction.
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target && target.closest?.('[data-bookmark-context-menu]')) return;
      setContextMenu(null);
    };
    // defer to next tick so the opening right-click doesn't close it instantly
    const id = setTimeout(() => {
      document.addEventListener('click', handler);
      document.addEventListener('contextmenu', handler);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('click', handler);
      document.removeEventListener('contextmenu', handler);
    };
  }, [contextMenu]);

  const toggleCategory = (cat: string) => {
    setCollapsed((prev) => ({ ...prev, [cat]: !prev[cat] }));
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

  return (
    <div>
      {/* Header with add / manage buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
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
        {exportUrl && (
          <a
            className="action-btn"
            href={exportUrl}
            download="bookmarks.json"
            style={{ padding: '3px 8px', fontSize: 12, marginLeft: 'auto', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 3 }}
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
            style={{ padding: '3px 8px', fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: exportUrl ? 0 : 'auto' }}
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
        <button
          className="action-btn"
          onClick={() => setShowCategoryMgr(!showCategoryMgr)}
          style={{ padding: '3px 8px', fontSize: 12, marginLeft: (exportUrl || onImport) ? 0 : 'auto' }}
          title={t('bm.manage_categories')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
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
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: getCategoryColor(cat),
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1 }}>{displayCat(cat)}</span>
              {cat !== 'Default' && (
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

      {/* Bookmark groups */}
      {Object.entries(bookmarksByCategory).map(([cat, bms]) => (
        <div key={cat} className="bookmark-group" style={{ marginBottom: 4 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 4px',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              opacity: 0.8,
            }}
            onClick={() => toggleCategory(cat)}
          >
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
                background: getCategoryColor(cat),
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
              {bms.map((bm) => (
                <div
                  key={bm.id ?? `${bm.lat}-${bm.lng}`}
                  className="bookmark-item"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 6px',
                    cursor: 'pointer',
                    borderRadius: 4,
                    fontSize: 12,
                    transition: 'background 0.15s',
                  }}
                  onClick={() => onBookmarkClick(bm)}
                  onContextMenu={(e) => handleContextMenu(e, bm)}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = '#3a3a3e';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                  }}
                >
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
              ))}
            </div>
          )}
        </div>
      ))}

      {bookmarks.length === 0 && (
        <div style={{ fontSize: 12, opacity: 0.5, padding: '8px 0', textAlign: 'center' }}>
          {t('bm.empty')}
        </div>
      )}

      {/* Context menu (dismissed via document click listener — see useEffect) */}
      {contextMenu && (
        <>
          <div
            data-bookmark-context-menu
            style={{
              position: 'fixed',
              left: contextMenu.x,
              top: contextMenu.y,
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
                if (contextMenu.bm.id) {
                  setEditingId(contextMenu.bm.id);
                  setEditName(contextMenu.bm.name);
                }
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
                          background: getCategoryColor(cat),
                          marginRight: 6,
                        }}
                      />
                      {displayCat(cat)}
                    </div>
                  ))}
              </>
            )}
          </div>
        </>
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
