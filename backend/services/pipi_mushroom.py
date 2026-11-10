"""Client for the Pipi Mushroom (pipimushroom.com) 蘑菇地圖 data API.

The site's map page talks to ``Handlers/MfMapData.ashx`` through an
encrypted envelope implemented in its ``Scripts/dist/api-security.min.js``:

1. ``GET /ApiSession.ashx`` (with the site's cookies) returns
   ``{a: token, b: AES key (b64), c: HMAC key (b64), d: expiresUtc,
   authExpiresUtc}``. ``authExpiresUtc`` is null for anonymous sessions,
   and the data endpoints answer 401 unless the cookies belong to a
   Google-logged-in browser session.
2. Each request POSTs ``{a: token, b: Date.now(), c: nonce, d: iv,
   e: AES-CBC(json payload), f: HMAC-SHA256(c-key, "a.b.c.d.e")}``.
3. A ``secure`` response carries ``{d: iv, e: ciphertext,
   f: HMAC(token.d.e)}``; anything else is plain JSON (errors).

The Cookie header comes from the user's own logged-in browser (pasted by
hand, or pushed by the extensions/pipi-cookie-sync Chrome extension); we
never see their Google credentials. It is sent verbatim and the site's
Set-Cookie renewals are applied to it (the login lasts ~15 minutes and is
extended on use). Background: docs/pipi-mushroom.md. Upstream calls are serialised,
spaced at least ``MIN_INTERVAL`` seconds apart, cached briefly, and a
429 ``Retry-After`` is honoured, so a panning user can't hammer the site.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import httpx
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

logger = logging.getLogger("locwarp")

BASE_URL = "https://pipimushroom.com/"
MAP_DATA_ENDPOINT = "Handlers/MfMapData.ashx"
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
_TIMEOUT = httpx.Timeout(12.0, connect=5.0)
# Item queries below this zoom are refused here rather than sent upstream.
# At zoom 14 the site's items API only returns mushrooms and smoke ending
# within 5 minutes (no flowers); 15 is the first zoom it answers in full
# (measured 2026-11-05, docs/pipi-mushroom.md). The frontend's PIPI_MIN_ZOOM
# is a separate copy of the same number.
MIN_ITEMS_ZOOM = 15
# Minimum spacing between upstream POSTs, and how long an identical
# viewport query is served from memory.
MIN_INTERVAL = 1.0
CACHE_TTL = 30.0
_CACHE_MAX = 32
# Refresh the API session this long before the server-side expiry.
_SESSION_MARGIN = 60.0

# Fields forwarded to the frontend; everything else the site returns is
# dropped so the UI only ever renders known, typed values.
_ITEM_FIELDS = (
    "id", "itemKind", "key", "displayName", "title", "sizeName", "state",
    "bloomedMs", "wiltingMs", "finishMs", "smokeEndMs",
)


class PipiError(Exception):
    """Upstream failure mapped to an HTTP status + frontend i18n code."""

    def __init__(self, code: str, status: int, message: str = "", retry_after: float | None = None):
        super().__init__(message or code)
        self.code = code
        self.status = status
        self.message = message
        self.retry_after = retry_after


def _cookie_pairs(raw: str) -> list[tuple[str, str]]:
    text = (raw or "").strip()
    if text.lower().startswith("cookie:"):
        text = text[7:]
    pairs: list[tuple[str, str]] = []
    for part in re.split(r"[;\r\n]+", text):
        name, sep, value = part.strip().partition("=")
        name = name.strip()
        if sep and name:
            pairs.append((name, value.strip()))
    return pairs


def parse_cookie_header(raw: str) -> dict[str, str]:
    """Parse ``name=value; name2=value2`` (optionally prefixed with
    ``Cookie:``, possibly spread over several lines) into a dict."""
    return dict(_cookie_pairs(raw))


def _join_pairs(pairs: list[tuple[str, str]]) -> str:
    return "; ".join(f"{n}={v}" for n, v in pairs)


def normalize_cookie_header(raw: str) -> str:
    """The same cookies as one ``Cookie`` header line, keeping the
    browser's order and any repeated names: a browser can hold two cookies
    with one name (different flags) and sends both, and which one the
    site's server picks depends on that order."""
    return _join_pairs(_cookie_pairs(raw))


def _set_cookie_updates(r: httpx.Response) -> list[tuple[str, str | None]]:
    """``(name, new value)`` per Set-Cookie header; value None = deleted."""
    out: list[tuple[str, str | None]] = []
    for line in r.headers.get_list("set-cookie"):
        first, _, rest = line.partition(";")
        name, sep, value = first.strip().partition("=")
        name, value = name.strip(), value.strip()
        if not sep or not name:
            continue
        attrs: dict[str, str] = {}
        for a in rest.split(";"):
            k, _, v = a.strip().partition("=")
            attrs[k.strip().lower()] = v.strip()
        dead = value == ""
        try:
            if "max-age" in attrs:
                dead = dead or int(attrs["max-age"]) <= 0
            elif "expires" in attrs:
                dead = dead or parsedate_to_datetime(attrs["expires"]).timestamp() <= time.time()
        except (TypeError, ValueError):
            pass
        out.append((name, None if dead else value))
    return out


def region_for(lat: float, lng: float) -> str | None:
    """Same region boxes as the site's mfmap.min.js (TW / HK / MA)."""
    if 22.136718 <= lat <= 22.568331 and 113.817228 <= lng <= 114.502469:
        return "HK"
    if 21.75 <= lat <= 25.4 and 119.2 <= lng <= 122.1:
        return "TW"
    if 0.85 <= lat <= 7.4 and 99.5 <= lng <= 119.3:
        return "MA"
    return None


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _parse_utc(value: object) -> float | None:
    """Parse .NET ISO timestamps (7 fractional digits, trailing Z) to epoch secs."""
    if not isinstance(value, str) or not value:
        return None
    m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$", value.strip())
    if not m:
        return None
    frac = (m.group(2) or "")[:7]  # "." + at most 6 digits (microseconds)
    tz = m.group(3) or "Z"
    try:
        dt = datetime.fromisoformat(m.group(1) + frac + ("+00:00" if tz == "Z" else tz))
    except ValueError:
        return None
    return dt.astimezone(timezone.utc).timestamp()


@dataclass
class _ApiSession:
    token: str
    enc_key: bytes
    sig_key: bytes
    expires_at: float
    auth_expires_at: float | None

    def usable(self) -> bool:
        now = time.time()
        if self.expires_at - now <= _SESSION_MARGIN:
            return False
        return self.auth_expires_at is None or self.auth_expires_at - now > _SESSION_MARGIN

    def sign(self, message: str) -> str:
        return _b64(hmac.new(self.sig_key, message.encode("utf-8"), hashlib.sha256).digest())

    def encrypt(self, payload: dict) -> tuple[str, str]:
        iv = os.urandom(16)
        padder = padding.PKCS7(128).padder()
        data = padder.update(json.dumps(payload, separators=(",", ":")).encode("utf-8")) + padder.finalize()
        enc = Cipher(algorithms.AES(self.enc_key), modes.CBC(iv)).encryptor()
        return _b64(iv), _b64(enc.update(data) + enc.finalize())

    def decrypt(self, iv_b64: str, ct_b64: str) -> dict:
        dec = Cipher(algorithms.AES(self.enc_key), modes.CBC(base64.b64decode(iv_b64))).decryptor()
        padded = dec.update(base64.b64decode(ct_b64)) + dec.finalize()
        unpadder = padding.PKCS7(128).unpadder()
        return json.loads((unpadder.update(padded) + unpadder.finalize()).decode("utf-8"))


class PipiMushroomClient:
    def __init__(self, on_cookie_renewed: Callable[[str], None] | None = None) -> None:
        # Called with the new Cookie header when the site renews the login
        # via Set-Cookie (it lasts ~15 min and is extended on use), so the
        # caller can persist it.
        self._on_cookie_renewed = on_cookie_renewed
        self._cookies: dict[str, str] = {}
        self._cookie_header = ""
        self._client: httpx.AsyncClient | None = None
        self._session: _ApiSession | None = None
        self._lock = asyncio.Lock()
        self._last_call = 0.0
        self._blocked_until = 0.0
        self._cache: dict[tuple, tuple[float, dict]] = {}

    # ── configuration ────────────────────────────────────────────────
    @property
    def configured(self) -> bool:
        return bool(self._cookies)

    @property
    def cookie_header(self) -> str:
        """Current Cookie header, including renewals the site has sent."""
        return self._cookie_header

    def set_cookie(self, raw: str) -> None:
        """Replace the cookie jar. Drops the HTTP client, API session and
        cache so nothing from the previous login leaks into the new one."""
        self._cookies = parse_cookie_header(raw)
        self._cookie_header = normalize_cookie_header(raw)
        self._session = None
        self._cache.clear()
        self._blocked_until = 0.0
        old, self._client = self._client, None
        if old is not None:
            try:
                asyncio.get_running_loop().create_task(old.aclose())
            except RuntimeError:
                pass  # no loop yet (settings load at import time)

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            # Sent verbatim, exactly as the browser sent it (see
            # normalize_cookie_header), rather than rebuilt from a dict.
            self._client = httpx.AsyncClient(
                base_url=BASE_URL,
                timeout=_TIMEOUT,
                headers={
                    "User-Agent": _USER_AGENT,
                    "Referer": BASE_URL + "mfmap.aspx",
                    "Cookie": self._cookie_header,
                },
            )
        return self._client

    def _absorb_set_cookies(self, r: httpx.Response) -> None:
        """Apply the site's Set-Cookie headers to our Cookie header, like a
        browser would: the login cookie gets renewed on use, and keeping
        the old value would log us out ~15 minutes later. Every occurrence
        of a repeated name gets the new value."""
        updates = _set_cookie_updates(r)
        if not updates:
            return
        pairs = _cookie_pairs(self._cookie_header)
        for name, value in updates:
            if value is None:
                pairs = [p for p in pairs if p[0] != name]
            elif any(n == name for n, _ in pairs):
                pairs = [(n, value if n == name else v) for n, v in pairs]
            else:
                pairs.append((name, value))
        header = _join_pairs(pairs)
        if header == self._cookie_header:
            return
        self._cookie_header = header
        self._cookies = dict(pairs)
        if self._client is not None:
            self._client.headers["Cookie"] = header
        if self._on_cookie_renewed is not None:
            try:
                self._on_cookie_renewed(header)
            except Exception:
                logger.warning("Saving the renewed Pipi Mushroom cookie failed", exc_info=True)

    # ── protocol ─────────────────────────────────────────────────────
    async def _ensure_session(self) -> _ApiSession:
        if self._session is not None and self._session.usable():
            return self._session
        try:
            r = await self._http().get(
                "ApiSession.ashx",
                headers={"Accept": "application/json", "Cache-Control": "no-store"},
            )
        except httpx.HTTPError as e:
            raise PipiError("pipi_unavailable", 502, f"ApiSession: {e}") from e
        self._absorb_set_cookies(r)
        self._raise_for_rate_limit(r)
        try:
            j = r.json()
        except ValueError:
            j = {}
        if r.status_code != 200 or not j.get("ok"):
            raise PipiError("pipi_unavailable", 502, f"ApiSession HTTP {r.status_code}")
        try:
            sess = _ApiSession(
                token=str(j["a"]),
                enc_key=base64.b64decode(j["b"]),
                sig_key=base64.b64decode(j["c"]),
                expires_at=_parse_utc(j.get("d")) or (time.time() + 600),
                auth_expires_at=_parse_utc(j.get("authExpiresUtc")),
            )
        except (KeyError, ValueError, TypeError) as e:
            raise PipiError("pipi_unavailable", 502, "ApiSession payload changed") from e
        self._session = sess
        return sess

    def _raise_for_rate_limit(self, r: httpx.Response) -> None:
        if r.status_code != 429:
            return
        try:
            wait = float(r.headers.get("Retry-After") or 60)
        except ValueError:
            wait = 60.0
        wait = max(5.0, min(wait, 900.0))
        self._blocked_until = time.time() + wait
        raise PipiError("pipi_rate_limited", 429, retry_after=wait)

    async def _post(self, sess: _ApiSession, endpoint: str, payload: dict) -> tuple[int, dict]:
        ts = str(int(time.time() * 1000))
        nonce = _b64(os.urandom(18))
        iv, ct = sess.encrypt(payload)
        body = {"a": sess.token, "b": ts, "c": nonce, "d": iv, "e": ct,
                "f": sess.sign(".".join((sess.token, ts, nonce, iv, ct)))}
        try:
            r = await self._http().post(
                endpoint,
                json=body,
                headers={"Origin": BASE_URL.rstrip("/"), "Accept": "application/json"},
            )
        except httpx.HTTPError as e:
            raise PipiError("pipi_unavailable", 502, str(e)) from e
        self._absorb_set_cookies(r)
        self._raise_for_rate_limit(r)
        try:
            j = r.json()
        except ValueError:
            raise PipiError("pipi_unavailable", 502, f"HTTP {r.status_code}, non-JSON body")
        if isinstance(j, dict) and j.get("secure"):
            if sess.sign(f"{sess.token}.{j.get('d')}.{j.get('e')}") != j.get("f"):
                raise PipiError("pipi_unavailable", 502, "response signature mismatch")
            try:
                j = sess.decrypt(j["d"], j["e"])
            except (KeyError, ValueError) as e:
                raise PipiError("pipi_unavailable", 502, "response decrypt failed") from e
        return r.status_code, j if isinstance(j, dict) else {}

    async def request(self, endpoint: str, payload: dict) -> dict:
        """Send one encrypted request. Serialised + rate limited; retries
        once with a fresh API session on 401 (expired token)."""
        if not self.configured:
            raise PipiError("pipi_no_cookie", 400)
        async with self._lock:
            remaining = self._blocked_until - time.time()
            if remaining > 0:
                raise PipiError("pipi_rate_limited", 429, retry_after=remaining)
            for attempt in range(2):
                gap = self._last_call + MIN_INTERVAL - time.monotonic()
                if gap > 0:
                    await asyncio.sleep(gap)
                sess = await self._ensure_session()
                self._last_call = time.monotonic()
                status, j = await self._post(sess, endpoint, payload)
                if status == 401 and attempt == 0 and sess.auth_expires_at is not None:
                    # Logged-in session whose token went stale: retry once.
                    self._session = None
                    continue
                if status == 401:
                    raise PipiError("pipi_login_required", 401, str(j.get("error") or ""))
                if status != 200 or not j.get("ok", True):
                    raise PipiError("pipi_unavailable", 502, str(j.get("error") or f"HTTP {status}"))
                return j
        raise PipiError("pipi_login_required", 401)

    # ── public helpers ───────────────────────────────────────────────
    async def check_login(self) -> None:
        """Cheap authenticated call; raises PipiError when not logged in."""
        await self.request(MAP_DATA_ENDPOINT, {"mode": "filters"})

    async def items(self, north: float, south: float, east: float, west: float, zoom: int) -> dict:
        if zoom < MIN_ITEMS_ZOOM:
            raise PipiError("pipi_zoom_too_low", 400)
        region = region_for((north + south) / 2, (east + west) / 2)
        if region is None:
            return {"region": None, "items": [], "now_ms": int(time.time() * 1000), "truncated": False}
        key = (region, zoom, round(north, 4), round(south, 4), round(east, 4), round(west, 4))
        hit = self._cache.get(key)
        if hit:
            cached_at, cached = hit
            age = time.monotonic() - cached_at
            if age < CACHE_TTL:
                # now_ms is "server time at response", so age it by how long
                # the entry has been cached. Return a copy: adding in place
                # would accumulate across repeated hits on the same entry.
                return {**cached, "now_ms": cached["now_ms"] + int(age * 1000)}
        j = await self.request(MAP_DATA_ENDPOINT, {
            "mode": "items", "regionCode": region, "zoom": zoom,
            "north": north, "south": south, "east": east, "west": west,
        })
        result = {
            "region": region,
            "items": [it for it in (self._normalize(x) for x in j.get("items") or []) if it],
            "now_ms": int(j.get("nowMs") or time.time() * 1000),
            "truncated": bool(j.get("truncated") or j.get("mushroomTruncated") or j.get("flowerTruncated")),
        }
        if len(self._cache) >= _CACHE_MAX:
            self._cache.clear()
        self._cache[key] = (time.monotonic(), result)
        return result

    @staticmethod
    def _normalize(raw: object) -> dict | None:
        if not isinstance(raw, dict):
            return None
        try:
            lat, lng = float(raw["lat"]), float(raw["lng"])
        except (KeyError, TypeError, ValueError):
            return None
        out: dict = {k: raw[k] for k in _ITEM_FIELDS if raw.get(k) is not None}
        out["lat"], out["lng"] = lat, lng
        img = raw.get("image")
        # Only same-site relative asset paths; never pass through absolute URLs.
        if isinstance(img, str) and re.match(r"^Content/[\w\-./]+(\?[\w\-.=&]*)?$", img):
            out["image"] = BASE_URL + img
        return out
