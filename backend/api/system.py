"""System utility endpoints — open files / folders for the user."""

import logging
import os
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/system", tags=["system"])

logger = logging.getLogger(__name__)


def _open_native(path: Path) -> None:
    """Open a file or folder with the OS default application.

    On Windows, when the calling process owns the foreground, a freshly
    spawned Explorer window opens *behind* it (Windows foreground lock).
    Call AllowSetForegroundWindow(ASFW_ANY) so the new Explorer process
    can claim foreground itself, then launch via Explorer directly so the
    window genuinely comes to front instead of just blinking in the
    taskbar.
    """
    if sys.platform == "win32":
        try:
            import ctypes
            ASFW_ANY = -1
            ctypes.windll.user32.AllowSetForegroundWindow(ASFW_ANY)
        except Exception:
            logger.debug("AllowSetForegroundWindow failed; explorer may open behind", exc_info=True)
        if path.is_dir():
            # explorer.exe with a folder path foregrounds the window reliably,
            # whereas os.startfile sometimes does not.
            subprocess.Popen(["explorer.exe", str(path)])
        else:
            os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


@router.post("/open-log")
async def open_log():
    """Open backend.log in the OS default text editor (Notepad on Windows)
    so the user can copy it for bug reports. Falls back to opening the
    log folder if the file is missing."""
    log_dir = Path.home() / ".locwarp" / "logs"
    log_file = log_dir / "backend.log"
    target = log_file if log_file.exists() else log_dir
    if not target.exists():
        log_dir.mkdir(parents=True, exist_ok=True)
        target = log_dir
    try:
        _open_native(target)
    except Exception as exc:
        logger.exception("Failed to open log path %s", target)
        raise HTTPException(status_code=500, detail={"code": "open_log_failed",
                                                     "message": f"無法開啟 log:{exc}"})
    return {"status": "opened", "path": str(target)}


@router.post("/open-log-folder")
async def open_log_folder():
    """Open the ~/.locwarp/logs folder in the file manager."""
    log_dir = Path.home() / ".locwarp" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    try:
        _open_native(log_dir)
    except Exception as exc:
        logger.exception("Failed to open log folder %s", log_dir)
        raise HTTPException(status_code=500, detail={"code": "open_log_failed",
                                                     "message": f"無法開啟資料夾:{exc}"})
    return {"status": "opened", "path": str(log_dir)}


@router.get("/locate-pc")
async def locate_pc():
    """IP-geolocation endpoint used when Electron IPC is unavailable (browser / dev mode).

    Tries three free services in order and returns the first success.
    Accuracy is city-level (~5 km) — good enough to pan the map to the
    approximate real-world location of the computer.
    """
    import httpx

    _SERVICES = [
        ("https://ipwho.is/",
         lambda d: (d.get("latitude"), d.get("longitude"), "ipwho.is")),
        ("https://ipapi.co/json/",
         lambda d: (d.get("latitude"), d.get("longitude"), "ipapi.co")),
        ("https://freeipapi.com/api/json/",
         lambda d: (d.get("latitude"), d.get("longitude"), "freeipapi.com")),
    ]

    errors: list[str] = []

    # In a PyInstaller bundle the certifi CA bundle may not be accessible,
    # causing SSL verification to fail for HTTPS requests.  Try with
    # verification first; if every attempt raises an SSL error, retry the
    # whole loop with verify=False (safe for public IP-geolocation services).
    for verify in (True, False):
        errors.clear()
        async with httpx.AsyncClient(
            timeout=6.0,
            headers={"User-Agent": "LocWarp/1.0"},
            follow_redirects=True,
            verify=verify,
        ) as client:
            for url, extract in _SERVICES:
                try:
                    resp = await client.get(url)
                    if resp.status_code == 200:
                        data = resp.json()
                        lat, lng, via = extract(data)
                        if lat is not None and lng is not None:
                            return {
                                "ok": True,
                                "lat": float(lat),
                                "lng": float(lng),
                                "accuracy": 5000,
                                "via": via,
                            }
                        errors.append(f"{via}: missing lat/lng in response")
                    else:
                        errors.append(f"{url}: HTTP {resp.status_code}")
                except Exception as exc:
                    errors.append(f"{url}: {exc}")

        # If all errors look like SSL failures, retry without verification.
        if not all("SSL" in e or "certificate" in e.lower() or "CERTIFICATE" in e for e in errors):
            break  # Non-SSL failure — no point retrying with verify=False

    raise HTTPException(
        status_code=503,
        detail={
            "code": "ALL_FAILED",
            "message": "IP geolocation: all services unreachable — " + "; ".join(errors),
        },
    )
