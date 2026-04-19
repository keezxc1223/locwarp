"""Shared pytest fixtures.

Run from backend/ as:  python -m pytest -v
Adds backend/ to sys.path so `from models...` etc. resolve when pytest is
invoked from the repo root.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Make backend/ importable regardless of where pytest is launched from.
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))


@pytest.fixture
def isolated_data_dir(tmp_path, monkeypatch):
    """Redirect ~/.locwarp file writes to a tmp dir for test isolation.

    Use in any test that touches BookmarkManager / settings persistence.
    """
    monkeypatch.setattr("config.DATA_DIR", tmp_path)
    monkeypatch.setattr("config.SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr("config.BOOKMARKS_FILE", tmp_path / "bookmarks.json")
    return tmp_path
