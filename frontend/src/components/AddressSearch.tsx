import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { searchAddress, setGeocodeProviderPref } from '../services/api';
import { useT, type StringKey } from '../i18n';

interface SearchResult {
  name: string;
  lat: number;
  lng: number;
  address?: string;
}

interface AddressSearchProps {
  onSelect: (lat: number, lng: number, name: string) => void;
}

type Provider = 'arcgis' | 'nominatim' | 'photon' | 'google';

const AddressSearch: React.FC<AddressSearchProps> = ({ onSelect }) => {
  const t = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Provider state — persisted in localStorage so it survives launches.
  // Auto-fallback to 'arcgis' if user previously picked 'google' but
  // never saved a key (or cleared it via DevTools).
  const [provider, setProvider] = useState<Provider>(() => {
    try {
      const saved = localStorage.getItem('locwarp.geocode_provider');
      const key = localStorage.getItem('locwarp.google_geocode_key') || '';
      if (saved === 'google' && key) return 'google';
      if (saved === 'photon' || saved === 'nominatim') return saved;
    } catch { /* ignore */ }
    return 'arcgis';
  });
  const [googleKey, setGoogleKey] = useState<string>(() => {
    try { return localStorage.getItem('locwarp.google_geocode_key') || ''; }
    catch { return ''; }
  });
  const [arcgisKey, setArcgisKey] = useState<string>(() => {
    try { return localStorage.getItem('locwarp.arcgis_geocode_key') || ''; }
    catch { return ''; }
  });
  const [arcgisKeyInput, setArcgisKeyInput] = useState<string>(arcgisKey);
  const [showArcgisSetup, setShowArcgisSetup] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Google's quota warning + key form only open on demand, they took up
  // most of the modal for users who never use Google.
  const [showGoogleSetup, setShowGoogleSetup] = useState(false);
  const [keyInput, setKeyInput] = useState<string>(googleKey);

  // Mirror to backend so /api/phone/geocode can honour the same choice.
  // Fire-and-forget: the desktop's localStorage is still the source of
  // truth for its own search calls, this only matters for the phone.
  const syncToBackend = useCallback((p: Provider, key: string, aKey: string) => {
    setGeocodeProviderPref(p, p === 'google' ? key : '', aKey).catch(() => {
      /* backend offline / older build — desktop search keeps working */
    });
  }, []);

  const persistProvider = useCallback((p: Provider) => {
    setProvider(p);
    try { localStorage.setItem('locwarp.geocode_provider', p); }
    catch { /* ignore */ }
    syncToBackend(p, googleKey, arcgisKey);
  }, [googleKey, arcgisKey, syncToBackend]);

  const saveGoogleKey = useCallback(() => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setGoogleKey(trimmed);
    try { localStorage.setItem('locwarp.google_geocode_key', trimmed); }
    catch { /* ignore */ }
    setProvider('google');
    try { localStorage.setItem('locwarp.geocode_provider', 'google'); }
    catch { /* ignore */ }
    syncToBackend('google', trimmed, arcgisKey);
    setShowSettings(false);
  }, [keyInput, arcgisKey, syncToBackend]);

  const saveArcgisKey = useCallback(() => {
    const trimmed = arcgisKeyInput.trim();
    if (!trimmed) return;
    setArcgisKey(trimmed);
    try {
      localStorage.setItem('locwarp.arcgis_geocode_key', trimmed);
      localStorage.setItem('locwarp.geocode_provider', 'arcgis');
    } catch { /* ignore */ }
    setProvider('arcgis');
    syncToBackend('arcgis', googleKey, trimmed);
    setShowSettings(false);
  }, [arcgisKeyInput, googleKey, syncToBackend]);

  const clearArcgisKey = useCallback(() => {
    setArcgisKey('');
    setArcgisKeyInput('');
    try { localStorage.removeItem('locwarp.arcgis_geocode_key'); }
    catch { /* ignore */ }
    syncToBackend(provider, googleKey, '');
  }, [provider, googleKey, syncToBackend]);

  const clearGoogleKey = useCallback(() => {
    setGoogleKey('');
    setKeyInput('');
    try { localStorage.removeItem('locwarp.google_geocode_key'); }
    catch { /* ignore */ }
    persistProvider('arcgis');
  }, [persistProvider]);

  // On mount, push the currently-saved choice to the backend in case the
  // user previously picked Google/Photon before this sync existed (or the
  // backend's settings.json got reset).
  useEffect(() => {
    syncToBackend(provider, googleKey, arcgisKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      setShowResults(false);
      setSearchError(null);
      return;
    }

    setIsLoading(true);
    setSearchError(null);
    try {
      const raw = await searchAddress(q);
      const mapped = (Array.isArray(raw) ? raw : []).map((r: any) => ({
        name: r.display_name || r.name || '',
        lat: r.lat,
        lng: r.lng,
        address: r.address || '',
      }));
      setResults(mapped);
      setShowResults(true);
    } catch (err: any) {
      console.error('Search failed:', err);
      setResults([]);
      const msg = err?.message || String(err);
      setSearchError(msg.length > 200 ? msg.slice(0, 200) + '…' : msg);
      setShowResults(true);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Search only on Enter or the magnifier button. Searching while typing
  // sent a request per pause, which public services treat as abuse
  // (Nominatim bans auto-complete) and burns Google quota.
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    if (!value.trim()) {
      setResults([]);
      setShowResults(false);
      setSearchError(null);
    }
  };

  const handleSelect = (result: SearchResult) => {
    setQuery(result.name);
    setShowResults(false);
    onSelect(result.lat, result.lng, result.name);
  };

  // Close result dropdown on outside click (settings is a modal — its own
  // backdrop handles dismissal so we don't need to do it here).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current && !containerRef.current.contains(target)) {
        setShowResults(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const isGoogleActive = provider === 'google' && !!googleKey;
  // Pill style + label for the active provider. Free ones share a muted
  // look; Google uses its brand blue to make the "paid key in use" state
  // visible at a glance.
  const activeProvider: Provider = provider === 'google' && !googleKey ? 'arcgis' : provider;
  const pillLabel = { arcgis: 'ArcGIS', nominatim: 'Nominatim', photon: 'Photon', google: 'Google' }[activeProvider];
  const pillTitleKey: StringKey = ({
    arcgis: 'search.settings_btn_arcgis',
    nominatim: 'search.settings_btn_free',
    photon: 'search.settings_btn_photon',
    google: 'search.settings_btn_google',
  } as const)[activeProvider];

  const renderKeyForm = (opts: {
    value: string;
    onChange: (v: string) => void;
    onSave: () => void;
    savedKey: string;
    onClear: () => void;
    placeholder: string;
  }) => (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 11, color: '#9499ac', marginBottom: 6, fontWeight: 600 }}>
        {t('search.api_key_label')}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="password"
          value={opts.value}
          onChange={(e) => opts.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); opts.onSave(); }
          }}
          placeholder={opts.placeholder}
          spellCheck={false}
          autoComplete="off"
          style={{
            flex: 1,
            padding: '8px 10px',
            fontSize: 13,
            fontFamily: 'monospace',
            background: 'rgba(12, 15, 26, 0.85)',
            color: '#e8eaf0',
            border: '1px solid rgba(var(--accent-rgb), 0.35)',
            borderRadius: 6,
            outline: 'none',
          }}
        />
        <button
          onClick={opts.onSave}
          disabled={!opts.value.trim()}
          className="action-btn primary"
          style={{ fontSize: 12, padding: '0 16px' }}
        >
          {t('search.save_key')}
        </button>
      </div>
      {opts.savedKey && (
        <div style={{
          marginTop: 8, display: 'flex',
          justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontSize: 11, opacity: 0.55 }}>
            {t('search.key_saved_hint', { tail: opts.savedKey.slice(-4) })}
          </span>
          <button
            onClick={opts.onClear}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#ff8a8a',
              cursor: 'pointer',
              fontSize: 11,
              padding: 0,
              textDecoration: 'underline',
            }}
          >
            {t('search.clear_key')}
          </button>
        </div>
      )}
    </div>
  );

  const privacyHint = (
    <div style={{
      fontSize: 11, color: 'var(--accent-green)',
      marginTop: 6, display: 'flex', alignItems: 'center', gap: 6,
    }}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
        <path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" />
      </svg>
      {t('search.privacy_hint')}
    </div>
  );

  const renderFreeOption = (p: Provider, labelKey: StringKey, descKey: StringKey) => (
    <label
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '12px 14px',
        borderRadius: 8,
        cursor: 'pointer',
        background: provider === p ? 'rgba(var(--accent-rgb), 0.10)' : 'rgba(255, 255, 255, 0.02)',
        border: `1px solid ${provider === p ? 'rgba(var(--accent-rgb), 0.32)' : 'rgba(255, 255, 255, 0.06)'}`,
        marginBottom: 10,
        transition: 'all 0.16s',
      }}
      onClick={() => persistProvider(p)}
    >
      <input
        type="radio"
        name="geocode-provider-modal"
        checked={provider === p}
        onChange={() => persistProvider(p)}
        style={{ marginTop: 3, accentColor: 'var(--accent-blue)' }}
      />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5 }}>
          {t(labelKey)}
        </div>
        <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4, lineHeight: 1.55 }}>
          {t(descKey)}
        </div>
      </div>
    </label>
  );

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <div style={{ position: 'relative', display: 'flex', gap: 4 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <input
            type="text"
            className="search-input"
            placeholder={t('search.placeholder')}
            value={query}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); doSearch(query); }
            }}
            onFocus={() => { if (results.length > 0) setShowResults(true); }}
            style={{ width: '100%', paddingLeft: 10, paddingRight: 30 }}
          />
          <button
            type="button"
            onClick={() => doSearch(query)}
            title={t('search.search_btn')}
            aria-label={t('search.search_btn')}
            style={{
              position: 'absolute', right: 2, top: '50%',
              transform: 'translateY(-50%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 26, height: 26, padding: 0,
              background: 'transparent', border: 'none',
              color: 'inherit', opacity: 0.6, cursor: 'pointer',
            }}
          >
            <svg
              width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </div>
        <button
          onClick={() => {
            setKeyInput(googleKey);
            setArcgisKeyInput(arcgisKey);
            setShowGoogleSetup(false);
            setShowArcgisSetup(false);
            setShowSettings(true);
          }}
          title={t(pillTitleKey)}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '0 10px',
            background: isGoogleActive ? 'rgba(66, 133, 244, 0.18)' : 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${isGoogleActive ? 'rgba(66, 133, 244, 0.55)' : 'rgba(255, 255, 255, 0.16)'}`,
            borderRadius: 4,
            color: isGoogleActive ? 'var(--accent-soft)' : '#c8cad2',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            height: 28,
          }}
        >
          <span
            style={{
              width: 6, height: 6, borderRadius: '50%',
              background: isGoogleActive ? '#4285f4' : '#9499ac',
              boxShadow: isGoogleActive ? '0 0 6px rgba(66, 133, 244, 0.8)' : 'none',
            }}
          />
          {pillLabel}
        </button>
      </div>

      {/* Settings modal — rendered via portal to avoid being clipped by the
          search container's narrow width. The user complained the inline
          dropdown squeezed the text; this gives it a comfortable 480px
          width with proper line-height and dedicated sections. */}
      {showSettings && createPortal(
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setShowSettings(false); }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9000,
            background: 'rgba(8, 11, 22, 0.6)',
            backdropFilter: 'blur(4px)', animation: 'var(--anim-scrim)',
            WebkitBackdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            className="anim-fade-slide-up"
            style={{
              width: 480,
              maxWidth: '100%',
              maxHeight: 'calc(100vh - 60px)',
              overflowY: 'auto',
              background: 'var(--glass-pop)',
              backdropFilter: 'var(--glass-blur)',
              WebkitBackdropFilter: 'var(--glass-blur)',
              border: '1px solid rgba(var(--accent-rgb), 0.32)',
              borderRadius: 12,
              padding: '20px 22px',
              color: '#e8eaf0',
              boxShadow: '0 24px 60px rgba(8, 11, 22, 0.7)',
            }}
          >
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: 14,
            }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--accent-soft)' }}>
                {t('search.settings_title')}
              </div>
              <button
                onClick={() => setShowSettings(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#9499ac',
                  fontSize: 20,
                  lineHeight: 1,
                  padding: '4px 8px',
                  cursor: 'pointer',
                  borderRadius: 4,
                }}
                aria-label="close"
              >×</button>
            </div>

            <div
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                background: provider === 'arcgis' ? 'rgba(var(--accent-rgb), 0.10)' : 'rgba(255, 255, 255, 0.02)',
                border: `1px solid ${provider === 'arcgis' ? 'rgba(var(--accent-rgb), 0.32)' : 'rgba(255, 255, 255, 0.06)'}`,
                marginBottom: 10,
                transition: 'all 0.16s',
              }}
            >
              <label
                style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}
                onClick={() => persistProvider('arcgis')}
              >
                <input
                  type="radio"
                  name="geocode-provider-modal"
                  checked={provider === 'arcgis'}
                  onChange={() => persistProvider('arcgis')}
                  style={{ marginTop: 3, accentColor: 'var(--accent-blue)' }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                    {t('search.provider_arcgis_label')}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4, lineHeight: 1.55 }}>
                    {t('search.provider_arcgis_desc')}
                  </div>
                  {arcgisKey && (
                    <div style={{ fontSize: 11, color: 'var(--accent-green)', marginTop: 6 }}>
                      {t('search.arcgis_key_in_use')}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowArcgisSetup((v) => !v); }}
                  className="action-btn"
                  style={{ fontSize: 11, padding: '4px 10px', whiteSpace: 'nowrap', alignSelf: 'center' }}
                >
                  {showArcgisSetup ? t('search.google_setup_hide') : t('search.google_setup_show')}
                </button>
              </label>

              {showArcgisSetup && (<>
                <div style={{
                  fontSize: 12, color: '#ffba6b',
                  marginTop: 12, padding: '10px 12px',
                  background: 'rgba(255, 186, 107, 0.08)',
                  border: '1px solid rgba(255, 186, 107, 0.24)',
                  borderRadius: 6,
                  lineHeight: 1.6,
                }}>
                  {t('search.arcgis_key_desc')}
                </div>
                <div style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <a
                    href="https://location.arcgis.com/sign-up/"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--accent-soft)', textDecoration: 'underline' }}
                  >
                    {t('search.arcgis_signup_label')}
                  </a>
                  <a
                    href="https://developers.arcgis.com/documentation/security-and-authentication/api-key-authentication/tutorials/create-an-api-key/"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--accent-soft)', textDecoration: 'underline' }}
                  >
                    {t('search.arcgis_key_howto_label')}
                  </a>
                </div>
                {privacyHint}
                {renderKeyForm({
                  value: arcgisKeyInput,
                  onChange: setArcgisKeyInput,
                  onSave: saveArcgisKey,
                  savedKey: arcgisKey,
                  onClear: clearArcgisKey,
                  placeholder: 'AAPT...',
                })}
              </>)}
            </div>
            {renderFreeOption('photon', 'search.provider_photon_label', 'search.provider_photon_desc')}
            {renderFreeOption('nominatim', 'search.provider_free_label', 'search.provider_free_desc')}

            {/* Google option */}
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                background: provider === 'google' ? 'rgba(66, 133, 244, 0.10)' : 'rgba(255, 255, 255, 0.02)',
                border: `1px solid ${provider === 'google' ? 'rgba(66, 133, 244, 0.36)' : 'rgba(255, 255, 255, 0.06)'}`,
                transition: 'all 0.16s',
              }}
            >
              <label
                style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: googleKey ? 'pointer' : 'default' }}
                onClick={() => { if (googleKey) persistProvider('google'); else setShowGoogleSetup(true); }}
              >
                <input
                  type="radio"
                  name="geocode-provider-modal"
                  checked={provider === 'google'}
                  onChange={() => { if (googleKey) persistProvider('google'); }}
                  disabled={!googleKey}
                  style={{ marginTop: 3, accentColor: 'var(--accent-blue)' }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                    {t('search.provider_google_label')}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4, lineHeight: 1.55 }}>
                    {t('search.provider_google_desc')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowGoogleSetup((v) => !v); }}
                  className="action-btn"
                  style={{ fontSize: 11, padding: '4px 10px', whiteSpace: 'nowrap', alignSelf: 'center' }}
                >
                  {showGoogleSetup ? t('search.google_setup_hide') : t('search.google_setup_show')}
                </button>
              </label>

              {showGoogleSetup && (<>
                <div style={{ fontSize: 12, marginTop: 12, lineHeight: 1.55 }}>
                  <a
                    href="https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--accent-soft)', textDecoration: 'underline' }}
                  >
                    {t('search.signup_label')}
                  </a>
                </div>
                {privacyHint}

              {/* Quota warning — proper line height, lots of room */}
              <div style={{
                fontSize: 12, color: '#ffba6b',
                marginTop: 12, padding: '10px 12px',
                background: 'rgba(255, 186, 107, 0.08)',
                border: '1px solid rgba(255, 186, 107, 0.24)',
                borderRadius: 6,
                lineHeight: 1.6,
                display: 'flex', alignItems: 'flex-start', gap: 8,
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ flexShrink: 0, marginTop: 2 }}>
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/>
                  <line x1="12" y1="17" x2="12" y2="17"/>
                </svg>
                <span>{t('search.provider_google_quota_hint')}</span>
              </div>

              {renderKeyForm({
                value: keyInput,
                onChange: setKeyInput,
                onSave: saveGoogleKey,
                savedKey: googleKey,
                onClear: clearGoogleKey,
                placeholder: 'AIza...',
              })}
              </>)}
            </div>

            <div style={{ marginTop: 18, textAlign: 'right' }}>
              <button
                onClick={() => setShowSettings(false)}
                className="action-btn"
                style={{ fontSize: 12, padding: '6px 18px' }}
              >
                {t('generic.confirm')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {isLoading && (
        <div style={{ fontSize: 11, opacity: 0.5, padding: '4px 0' }}>{t('search.searching')}</div>
      )}

      {showResults && results.length > 0 && (
        <div
          className="search-results"
          style={{
            position: 'absolute',
            top: '100%', left: 0, right: 0,
            background: '#2a2a2e', color: '#e8eaf0',
            border: '1px solid #444', borderRadius: 4,
            marginTop: 4, maxHeight: 240, overflowY: 'auto',
            zIndex: 200, boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}
        >
          {results.map((result, idx) => (
            <div
              key={idx}
              className="search-result-item"
              style={{
                padding: '8px 12px', cursor: 'pointer',
                borderBottom: idx < results.length - 1 ? '1px solid #333' : 'none',
                fontSize: 13, transition: 'background 0.15s',
              }}
              onClick={() => handleSelect(result)}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#3a3a3e'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <svg
                  width="12" height="12" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" strokeWidth="2"
                  style={{ flexShrink: 0, opacity: 0.5 }}
                >
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
                <div style={{ minWidth: 0 }}>
                  <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {result.name}
                  </div>
                  {result.address && (
                    <div style={{ fontSize: 10, opacity: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {result.address}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showResults && !isLoading && results.length === 0 && query.trim().length >= 2 && (
        <div
          style={{
            position: 'absolute',
            top: '100%', left: 0, right: 0,
            background: '#2a2a2e',
            border: '1px solid #444', borderRadius: 4,
            marginTop: 4, padding: '12px',
            fontSize: 12, opacity: searchError ? 0.85 : 0.6,
            textAlign: 'center', zIndex: 200,
            color: searchError ? '#ff8a8a' : '#e8eaf0',
          }}
        >
          {searchError || t('search.no_results')}
        </div>
      )}
    </div>
  );
};

export default AddressSearch;
