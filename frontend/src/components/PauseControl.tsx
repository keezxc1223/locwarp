import React from 'react';
import { useT } from '../i18n';
import type { StringKey } from '../i18n';

interface PauseSetting {
  enabled: boolean;
  min: number;
  max: number;
}

interface PauseControlProps {
  labelKey: StringKey;
  value: PauseSetting;
  onChange: (next: PauseSetting) => void;
}

const PauseControl: React.FC<PauseControlProps> = ({ labelKey, value, onChange }) => {
  const t = useT();
  const update = (patch: Partial<PauseSetting>) => onChange({ ...value, ...patch });

  return (
    <div style={{
      marginBottom: 8,
      padding: '8px 10px',
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(var(--accent-rgb), 0.10)',
      borderRadius: 6,
    }}>
      <label className="lw-checkbox">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        <span className="lw-checkbox-box"></span>
        <span className="lw-checkbox-label">{t(labelKey)}</span>
      </label>
      {value.enabled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 11, opacity: 0.95 }}>
          <span style={{ opacity: 0.7, minWidth: 28 }}>{t('pause.min')}</span>
          <input
            type="number"
            className="lw-input"
            min={0}
            max={300}
            step={1}
            value={value.min}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (!isNaN(n) && n >= 0) update({ min: n });
            }}
            style={{ width: 56 }}
          />
          <span style={{ opacity: 0.5 }}>~</span>
          <span style={{ opacity: 0.7, minWidth: 28 }}>{t('pause.max')}</span>
          <input
            type="number"
            className="lw-input"
            min={0}
            max={300}
            step={1}
            value={value.max}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (!isNaN(n) && n >= 0) update({ max: n });
            }}
            style={{ width: 56 }}
          />
          <span style={{ opacity: 0.55, marginLeft: 2 }}>{t('pause.seconds')}</span>
        </div>
      )}
    </div>
  );
};

export default PauseControl;
