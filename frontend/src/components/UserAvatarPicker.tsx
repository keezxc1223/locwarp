import React, { useEffect, useRef, useState } from 'react';
import {
  UserAvatar,
  PRESETS,
  DEFAULT_AVATAR_HTML,
  pngFileToDataUrl,
} from '../userAvatars';
import { useT, type StringKey } from '../i18n';

// Map preset id -> i18n key so character names translate with the UI.
const PRESET_LABEL_KEY: Record<string, StringKey> = {
  hare: 'avatar.preset_rabbit',
  dog:  'avatar.preset_dog',
  cat:  'avatar.preset_cat',
  fox:  'avatar.preset_fox',
  boy:  'avatar.preset_boy',
  girl: 'avatar.preset_girl',
};

interface Props {
  avatar: UserAvatar;
  customPng: string | null;
  onSave: (next: UserAvatar, customPng: string | null) => void;
  onClose: () => void;
  onShowToast?: (msg: string) => void;
}

/**
 * Popover panel for picking the map "current position" avatar.
 *
 * Flow is staged: click a preset / upload a PNG stages the change, nothing
 * is applied until the user hits 儲存. Custom PNG is kept in localStorage
 * in a separate slot from the active selection, so switching to a preset
 * never wipes the user's uploaded image (next upload overwrites it).
 */
const UserAvatarPicker: React.FC<Props> = ({ avatar, customPng, onSave, onClose, onShowToast }) => {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  // Staged values; both committed on 儲存.
  const [pending, setPending] = useState<UserAvatar>(avatar);
  const [pendingCustom, setPendingCustom] = useState<string | null>(customPng);
  useEffect(() => { setPending(avatar); setPendingCustom(customPng); }, [avatar, customPng]);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.type !== 'image/png') {
      onShowToast?.(t('avatar.only_png'));
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await pngFileToDataUrl(file, 88);
      setPendingCustom(dataUrl);
      // Auto-select custom when uploading so the save button lights up.
      setPending({ type: 'custom' });
    } catch {
      onShowToast?.(t('avatar.read_failed'));
    } finally {
      setUploading(false);
    }
  };

  const isPending = (a: UserAvatar): boolean => {
    if (pending.type !== a.type) return false;
    if (pending.type === 'preset' && a.type === 'preset') return pending.presetId === a.presetId;
    return true;
  };

  const pendingDiffers = (() => {
    if (pendingCustom !== customPng) return true;
    if (pending.type !== avatar.type) return true;
    if (pending.type === 'preset' && avatar.type === 'preset') return pending.presetId !== avatar.presetId;
    return false;
  })();

  const thumbStyle = (selected: boolean): React.CSSProperties => ({
    width: 56, height: 56,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: selected ? 'rgba(var(--accent-rgb),0.2)' : 'rgba(255,255,255,0.04)',
    border: selected ? '2px solid var(--accent-blue)' : '2px solid rgba(255,255,255,0.08)',
    borderRadius: 10,
    cursor: 'pointer',
    padding: 4,
    transition: 'all 0.15s',
  });

  const handleSave = () => {
    if (!pendingDiffers) { onClose(); return; }
    onSave(pending, pendingCustom);
    onClose();
  };

  const handleCancel = () => {
    setPending(avatar);
    setPendingCustom(customPng);
    onClose();
  };

  // Drag support: clicking the title bar lets the user park this panel
  // anywhere on the map so it doesn't cover the coord / pin they're
  // trying to see. Offset persists for the panel's lifetime. Use
  // document capture-phase listeners so Leaflet / other overlays can't
  // swallow mousemove / mouseup during the drag.
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const beginDrag = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    const baseX = dragOffset.x;
    const baseY = dragOffset.y;
    const startX = e.clientX;
    const startY = e.clientY;
    const onMove = (ev: MouseEvent) => {
      ev.preventDefault();
      setDragOffset({
        x: baseX + (ev.clientX - startX),
        y: baseY + (ev.clientY - startY),
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 120,
        right: 56,
        width: 280,
        background: 'var(--glass-pop)',
        backdropFilter: 'var(--glass-blur)',
        WebkitBackdropFilter: 'var(--glass-blur)',
        border: '1px solid rgba(var(--accent-rgb), 0.25)',
        borderRadius: 12,
        boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
        padding: 14,
        zIndex: 900,
        color: '#e8ebf1',
        fontSize: 12,
        transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div
        onMouseDown={beginDrag}
        style={{
          display: 'flex', alignItems: 'center', marginBottom: 10,
          cursor: 'move', userSelect: 'none',
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 13 }}>{t('avatar.title')}</div>
        <button
          onClick={handleCancel}
          style={{
            marginLeft: 'auto',
            background: 'transparent', border: 'none',
            color: '#9ba3b4', cursor: 'pointer',
            fontSize: 18, lineHeight: 1, padding: '0 4px',
          }}
          title={t('avatar.close_no_save')}
        >×</button>
      </div>

      <div style={{ fontSize: 11, color: '#9ba3b4', marginBottom: 6 }}>{t('avatar.section_default')}</div>
      <div
        style={{ ...thumbStyle(isPending({ type: 'default' })), width: '100%', height: 64, marginBottom: 12 }}
        onClick={() => setPending({ type: 'default' })}
      >
        <div
          style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          dangerouslySetInnerHTML={{ __html: DEFAULT_AVATAR_HTML }}
        />
        <span style={{ marginLeft: 12, fontSize: 12, color: '#c8d0e0' }}>{t('avatar.default_label')}</span>
      </div>

      <div style={{ fontSize: 11, color: '#9ba3b4', marginBottom: 6 }}>{t('avatar.section_presets')}</div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 8,
          marginBottom: 14,
        }}
      >
        {PRESETS.map((p) => {
          const labelKey = PRESET_LABEL_KEY[p.id];
          const label = labelKey ? t(labelKey) : p.label;
          return (
            <div
              key={p.id}
              onClick={() => setPending({ type: 'preset', presetId: p.id })}
              style={thumbStyle(isPending({ type: 'preset', presetId: p.id }))}
              title={label}
            >
              <img
                src={p.url}
                alt={label}
                style={{ width: 44, height: 44, objectFit: 'contain', display: 'block' }}
              />
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 11, color: '#9ba3b4', marginBottom: 6 }}>{t('avatar.section_custom')}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        {pendingCustom ? (
          <div
            onClick={() => setPending({ type: 'custom' })}
            style={thumbStyle(isPending({ type: 'custom' }))}
            title={t('avatar.use_custom')}
          >
            <img
              src={pendingCustom}
              alt=""
              style={{ width: 44, height: 44, objectFit: 'contain', display: 'block' }}
            />
          </div>
        ) : (
          <div style={{ ...thumbStyle(false), color: '#6b7384', cursor: 'default' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <circle cx="9" cy="9" r="2"/>
              <path d="M21 15l-5-5L5 21"/>
            </svg>
          </div>
        )}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="action-btn"
          style={{ flex: 1, fontSize: 12, padding: '6px 10px', opacity: uploading ? 0.6 : 1 }}
        >
          {uploading ? t('avatar.processing') : (pendingCustom ? t('avatar.replace_image') : t('avatar.choose_png'))}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,.png"
          style={{ display: 'none' }}
          onChange={handleFile}
        />
      </div>

      <ul
        style={{
          fontSize: 10.5, color: '#9ba3b4', lineHeight: 1.6,
          paddingLeft: 16, margin: '0 0 12px 0',
        }}
      >
        <li>{t('avatar.rule_format')}</li>
        <li>{t('avatar.rule_trim')}</li>
        <li>{t('avatar.rule_size')}</li>
        <li>{t('avatar.rule_persist')}</li>
      </ul>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={handleSave}
          disabled={!pendingDiffers}
          className="action-btn primary"
          style={{
            flex: 1, fontSize: 12, padding: '7px 10px',
            opacity: pendingDiffers ? 1 : 0.4,
            cursor: pendingDiffers ? 'pointer' : 'default',
          }}
        >
          {t('avatar.save')}
        </button>
        <button
          onClick={handleCancel}
          className="action-btn"
          style={{ fontSize: 12, padding: '7px 10px' }}
        >
          {t('avatar.cancel')}
        </button>
      </div>
    </div>
  );
};

export default UserAvatarPicker;
