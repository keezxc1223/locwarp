import React from 'react';
import { useI18n } from '../i18n';

const LangToggle: React.FC = () => {
  const { lang, setLang } = useI18n();

  const btnStyle = (active: boolean): React.CSSProperties => ({
    padding: '2px 8px',
    fontSize: 11,
    border: 'none',
    background: 'transparent',
    color: active ? '#6c8cff' : 'rgba(255,255,255,0.45)',
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
    borderBottom: active ? '1px solid #6c8cff' : '1px solid transparent',
  });

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: 0,
      }}
      title="Language / 語言"
    >
      <button onClick={() => setLang('zh')} style={btnStyle(lang === 'zh')}>中文</button>
      <span style={{ color: 'rgba(255,255,255,0.15)' }}>|</span>
      <button onClick={() => setLang('en')} style={btnStyle(lang === 'en')}>EN</button>
    </div>
  );
};

export default LangToggle;
