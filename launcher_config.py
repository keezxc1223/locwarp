"""
Shared constants for all LocWarp launcher scripts.
Import from here instead of hardcoding in start.py / locwarp_menubar.py.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# ── Port configuration ──────────────────────────────────────────────────
BACKEND_PORT  = 8777
FRONTEND_PORT = 5173

# ── Log size limit ──────────────────────────────────────────────────────
LOG_MAX_BYTES = 10 * 1024 * 1024   # 10 MB — rotate when exceeded

# ── Path helpers ────────────────────────────────────────────────────────
def project_root() -> Path:
    """Return the root directory of the LocWarp project.

    When running as a normal script, this is the directory containing
    launcher_config.py.  When bundled with py2app the file lives inside
    LocWarp.app/Contents/Resources/, so we walk upward until we find a
    directory that contains both 'backend/' and 'frontend/' sub-dirs.
    """
    here = Path(__file__).resolve().parent

    # Fast path: running directly from the project root
    if (here / "backend").is_dir() and (here / "frontend").is_dir():
        return here

    # py2app bundle: __file__ is inside .app/Contents/Resources/
    # Walk up the tree looking for the real project root
    for candidate in here.parents:
        if (candidate / "backend").is_dir() and (candidate / "frontend").is_dir():
            return candidate

    # Last resort: fall back to the directory next to the .app bundle
    # e.g. .app is at  /some/path/dist/LocWarp.app  → project = /some/path
    try:
        import sys
        app_path = Path(sys.executable).resolve()
        # sys.executable is  …/LocWarp.app/Contents/MacOS/python
        bundle_root = app_path.parent.parent.parent   # LocWarp.app
        # Try the folder containing the .app
        for candidate in [bundle_root.parent, bundle_root.parent.parent]:
            if (candidate / "backend").is_dir() and (candidate / "frontend").is_dir():
                return candidate
    except Exception:
        pass

    return here  # absolute fallback (may be wrong, but won't crash)


def backend_dir() -> Path:
    return project_root() / "backend"


def frontend_dir() -> Path:
    return project_root() / "frontend"


def log_dir() -> Path:
    d = Path.home() / ".locwarp" / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def resolve_python(version_prefix: str = "3.12") -> str:
    """
    Return the path to a Python interpreter matching *version_prefix*.
    Search order: project .venv → /opt/homebrew → /usr/local → $PATH.
    Falls back to sys.executable if nothing else matches.
    """
    root = project_root()
    venv_py = root / ".venv" / "bin" / "python3"
    if venv_py.is_file():
        import subprocess
        ver = subprocess.run(
            [str(venv_py), "-c",
             "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
            capture_output=True, text=True,
        ).stdout.strip()
        if ver.startswith(version_prefix):
            return str(venv_py)

    candidates = [
        f"/opt/homebrew/opt/python@{version_prefix}/bin/python{version_prefix}",
        f"/usr/local/opt/python@{version_prefix}/bin/python{version_prefix}",
        f"python{version_prefix}",
        "python3",
    ]
    import subprocess
    for c in candidates:
        try:
            ver = subprocess.run(
                [c, "-c",
                 "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
                capture_output=True, text=True, timeout=3,
            ).stdout.strip()
            if ver.startswith(version_prefix):
                return c
        except Exception:
            continue

    return sys.executable


def rotate_log_if_needed(log_path: Path) -> None:
    """Rotate *log_path* if it exceeds LOG_MAX_BYTES."""
    try:
        if log_path.is_file() and log_path.stat().st_size > LOG_MAX_BYTES:
            bak = log_path.with_suffix(".log.1")
            bak.unlink(missing_ok=True)
            log_path.rename(bak)
    except OSError:
        pass


def tail_log(log_path: Path, lines: int = 3) -> str:
    """Return the last *lines* lines of *log_path* for error notifications."""
    try:
        text = log_path.read_text(errors="replace")
        return "\n".join(text.splitlines()[-lines:]) if text.strip() else "(log empty)"
    except OSError:
        return "(log unreadable)"
