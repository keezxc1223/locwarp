// LocWarp 蘑菇地圖 Cookie 同步
//
// Pushes this Chrome profile's pipimushroom.com login cookie to the local
// LocWarp backend, so its mushroom-map layer works without copying the
// cookie by hand. Only ever talks to https://pipimushroom.com/ and
// http://127.0.0.1:8777.
//
// How the cookie is read: chrome.cookies.getAll() leaves out cookies Chrome
// does send to the site (on pipimushroom.com: the non-Secure ones, which
// include the logged-in session), so it handed LocWarp a stale logged-out
// set. Instead the extension requests ApiSession.ashx itself and captures
// the Cookie header Chrome attaches (webRequest + extraHeaders): the same
// line you would copy from DevTools. That response also says whether this
// profile is logged in. chrome.cookies is only used to notice changes.
//
// When it syncs:
//   * on install / update / browser start, and when the toolbar icon is clicked
//   * after a pipimushroom.com cookie changes (debounced, at most once a minute)
//   * on the minute alarm, only if the last attempt failed or LocWarp lost its
//     cookie. The site is not contacted while everything is in sync, while
//     LocWarp isn't running, or while this profile is logged out.

const SITE_URL = 'https://pipimushroom.com/';
const PROBE_URL = `${SITE_URL}ApiSession.ashx`;
const SITE_DOMAIN = 'pipimushroom.com';
const LOCWARP = 'http://127.0.0.1:8777';
const ALARM = 'pipi-cookie-check';
const DEBOUNCE_MS = 3000;
const MIN_CHANGE_GAP_MS = 60000;
// The probe's own response may set cookies; that isn't a change to react to.
const SELF_CHANGE_MS = 5000;
const CAPTURE_WAIT_MS = 2000;
// Google Analytics / Ads / consent cookies change on every page view but
// the site's server never reads them. They are still sent (exactly as the
// browser sends them) but don't count as a change.
const NOISE = /^(_ga|_gid|_gat|_gcl|__gads|__gpi|__eoi|FCNIL|FCCDCF|FCNEC|FCOEC)/;
const OWN_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
const GREEN = '#27ae60';
const ORANGE = '#e67e22';
const GREY = '#7f8c8d';
const BLUE = '#3498db';

let debounceTimer = null;
let inFlight = null;
let lastChangeSync = 0;
let ignoreChangesUntil = 0;
let captureResolve = null;

// Registered synchronously at top level so it survives service-worker restarts.
chrome.webRequest.onBeforeSendHeaders.addListener((d) => {
  if (!captureResolve || d.initiator !== OWN_ORIGIN) return;
  const h = (d.requestHeaders || []).find((x) => x.name.toLowerCase() === 'cookie');
  const resolve = captureResolve;
  captureResolve = null;
  resolve(h && h.value ? h.value : '');
}, { urls: [`${PROBE_URL}*`] }, ['requestHeaders', 'extraHeaders']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function now() {
  return new Date().toLocaleTimeString();
}

function significant(header) {
  return header.split(';').map((s) => s.trim())
    .filter((p) => p.includes('=') && !NOISE.test(p.split('=', 1)[0]))
    .sort().join('; ');
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function show(text, color, message) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title: `LocWarp 蘑菇地圖 Cookie 同步\n${message}\n(點一下立即同步)` });
}

async function locwarpHasCookie() {
  const r = await fetch(`${LOCWARP}/api/pipi/status`, { cache: 'no-store' });
  const j = await r.json();
  return !!j.configured;
}

// Ask the site who we are, and capture the Cookie header Chrome sent with it.
async function probeSite() {
  let resolveHeader;
  const header = new Promise((r) => { resolveHeader = r; });
  captureResolve = resolveHeader;
  ignoreChangesUntil = Date.now() + 15000;
  try {
    const r = await fetch(PROBE_URL, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const j = await r.json().catch(() => null);
    // The listener fires before the request goes out; the wait is a guard.
    const cookie = await Promise.race([header, sleep(CAPTURE_WAIT_MS).then(() => null)]);
    return { status: r.status, loggedIn: !!(j && j.authExpiresUtc), cookie };
  } finally {
    if (captureResolve === resolveHeader) captureResolve = null;
    ignoreChangesUntil = Date.now() + SELF_CHANGE_MS;
  }
}

async function retryLater(text, color, message) {
  await chrome.storage.local.remove('state');
  await show(text, color, message);
}

// reason: 'force' (install / click), 'change' (cookie changed / startup), 'alarm'
async function doSync(reason) {
  let locwarpHas;
  try {
    locwarpHas = await locwarpHasCookie();
  } catch {
    await retryLater('×', GREY, `LocWarp 沒有在執行，啟動後一分鐘內會自動同步 (${now()})`);
    return;
  }
  const { state, lastHash, dirty } = await chrome.storage.local.get(['state', 'lastHash', 'dirty']);
  if (reason === 'alarm' && !dirty) {
    if (state === 'logged_out' || state === 'rejected') return; // wait for a cookie change
    if (state === 'synced' && locwarpHas) return;
  }

  await show('…', BLUE, '同步中…');
  await chrome.storage.local.remove('dirty');
  let probe;
  try {
    probe = await probeSite();
  } catch {
    await retryLater('?', ORANGE, `連不到 pipimushroom.com，一分鐘後重試 (${now()})`);
    return;
  }
  if (probe.status === 429) {
    await retryLater('?', ORANGE, `pipimushroom.com 暫時限流，一分鐘後重試 (${now()})`);
    return;
  }
  if (probe.cookie === null) {
    await retryLater('?', ORANGE, `沒有擷取到 Chrome 送出的 Cookie，一分鐘後重試 (${now()})`);
    return;
  }
  if (!probe.loggedIn) {
    await chrome.storage.local.set({ state: 'logged_out' });
    await show('!', ORANGE,
      `Chrome 目前沒有登入 pipimushroom.com (或登入已過期)。\n`
      + `請打開網站用 Google 登入，登入後會自動同步 (${now()})`);
    return;
  }

  const hash = await sha256(significant(probe.cookie));
  if (reason !== 'force' && state === 'synced' && hash === lastHash && locwarpHas) {
    await show('✓', GREEN, `已同步，網站確認已登入 (${now()})`);
    return;
  }

  try {
    const r = await fetch(`${LOCWARP}/api/pipi/cookie`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: probe.cookie, source: 'extension' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j && j.detail && j.detail.code) || `HTTP ${r.status}`);
    if (j.logged_in) {
      await chrome.storage.local.set({ state: 'synced', lastHash: hash });
      await show('✓', GREEN, `已同步，網站確認已登入 (${now()})`);
    } else if (j.error === 'pipi_login_required') {
      // Chrome is logged in but LocWarp's check of the same cookie failed.
      // Don't resend it; the next cookie change (or a click) tries again.
      await chrome.storage.local.set({ state: 'rejected', lastHash: hash });
      await show('!', ORANGE,
        `Chrome 已登入，但 LocWarp 用這組 Cookie 向網站驗證失敗。\n`
        + `請重新整理 pipimushroom.com 後再點一下圖示 (${now()})`);
    } else {
      await retryLater('?', ORANGE, `LocWarp 暫時無法向網站確認登入狀態 (${j.error || 'unknown'})，一分鐘後重試 (${now()})`);
    }
  } catch {
    await retryLater('×', GREY, `連不到 LocWarp (127.0.0.1:8777)，啟動後一分鐘內會自動同步 (${now()})`);
  }
}

function sync(reason) {
  // Serialise: a cookie-change burst or an alarm firing mid-sync just waits.
  inFlight = (inFlight || Promise.resolve()).then(() => doSync(reason)).catch(() => {});
  return inFlight;
}

function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); sync('force'); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); sync('change'); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) sync('alarm'); });
chrome.action.onClicked.addListener(() => { sync('force'); });

chrome.cookies.onChanged.addListener(({ cookie }) => {
  const domain = cookie.domain.replace(/^\./, '');
  if (domain !== SITE_DOMAIN && !domain.endsWith(`.${SITE_DOMAIN}`)) return;
  if (NOISE.test(cookie.name) || Date.now() < ignoreChangesUntil) return;
  // Persisted so the alarm still picks it up if the worker is suspended
  // before the debounce timer fires.
  chrome.storage.local.set({ dirty: true });
  clearTimeout(debounceTimer);
  const wait = Math.max(DEBOUNCE_MS, lastChangeSync + MIN_CHANGE_GAP_MS - Date.now());
  debounceTimer = setTimeout(() => { lastChangeSync = Date.now(); sync('change'); }, wait);
});
