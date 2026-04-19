"""Bookmark and category management with JSON file persistence."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path

from config import BOOKMARKS_FILE
from models.schemas import Bookmark, BookmarkCategory, BookmarkStore

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


class BookmarkManager:
    """CRUD manager for bookmarks and categories.

    State is persisted to :data:`BOOKMARKS_FILE` (JSON) on every write
    operation.
    """

    def __init__(self) -> None:
        self.store = BookmarkStore(
            categories=[
                BookmarkCategory(
                    id="default",
                    name="預設",
                    color="#6c8cff",
                    sort_order=0,
                    created_at=_now_iso(),
                )
            ],
            bookmarks=[],
        )
        self._load()

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _load(self) -> None:
        """Load bookmarks from the JSON file, if it exists."""
        path = Path(BOOKMARKS_FILE)
        if not path.exists():
            logger.info("No bookmark file found; using defaults")
            return

        try:
            raw = path.read_text(encoding="utf-8")
            data = json.loads(raw)
            self.store = BookmarkStore(**data)
            logger.info(
                "Loaded %d bookmarks in %d categories",
                len(self.store.bookmarks),
                len(self.store.categories),
            )
        except Exception as exc:
            logger.warning("Failed to load bookmarks: %s", exc)

    def _save(self) -> None:
        """Persist the current store to disk."""
        path = Path(BOOKMARKS_FILE)
        path.parent.mkdir(parents=True, exist_ok=True)

        try:
            raw = self.store.model_dump_json(indent=2)
            path.write_text(raw, encoding="utf-8")
        except Exception as exc:
            logger.error("Failed to save bookmarks: %s", exc)

    # ------------------------------------------------------------------
    # Categories
    # ------------------------------------------------------------------

    def create_category(
        self,
        name: str,
        color: str = "#6c8cff",
    ) -> BookmarkCategory:
        """Create and return a new category."""
        max_order = max((c.sort_order for c in self.store.categories), default=-1)
        cat = BookmarkCategory(
            id=str(uuid.uuid4()),
            name=name,
            color=color,
            sort_order=max_order + 1,
            created_at=_now_iso(),
        )
        self.store.categories.append(cat)
        self._save()
        return cat

    def update_category(
        self,
        cat_id: str,
        name: str | None = None,
        color: str | None = None,
    ) -> BookmarkCategory | None:
        """Update a category's name or colour. Returns ``None`` if not found."""
        cat = self._find_category(cat_id)
        if cat is None:
            return None
        if name is not None:
            cat.name = name
        if color is not None:
            cat.color = color
        self._save()
        return cat

    def delete_category(self, cat_id: str) -> bool:
        """Delete a category and move its bookmarks to *default*.

        The *default* category cannot be deleted.
        """
        if cat_id == "default":
            logger.warning("Cannot delete the default category")
            return False

        cat = self._find_category(cat_id)
        if cat is None:
            return False

        # Move orphaned bookmarks
        for bm in self.store.bookmarks:
            if bm.category_id == cat_id:
                bm.category_id = "default"

        self.store.categories = [c for c in self.store.categories if c.id != cat_id]
        self._save()
        return True

    def list_categories(self) -> list[BookmarkCategory]:
        return sorted(self.store.categories, key=lambda c: c.sort_order)

    def _find_category(self, cat_id: str) -> BookmarkCategory | None:
        return next((c for c in self.store.categories if c.id == cat_id), None)

    # ------------------------------------------------------------------
    # Bookmarks
    # ------------------------------------------------------------------

    def create_bookmark(
        self,
        name: str,
        lat: float,
        lng: float,
        address: str = "",
        category_id: str = "default",
    ) -> Bookmark:
        """Create a new bookmark."""
        # Validate category
        if self._find_category(category_id) is None:
            category_id = "default"

        now = _now_iso()
        bm = Bookmark(
            id=str(uuid.uuid4()),
            name=name,
            lat=lat,
            lng=lng,
            address=address,
            category_id=category_id,
            created_at=now,
            last_used_at=now,
        )
        self.store.bookmarks.append(bm)
        self._save()
        return bm

    def update_bookmark(self, bm_id: str, **kwargs: object) -> Bookmark | None:
        """Update a bookmark's fields. Returns ``None`` if not found."""
        bm = self._find_bookmark(bm_id)
        if bm is None:
            return None

        allowed = {"name", "lat", "lng", "address", "category_id", "last_used_at"}
        for key, value in kwargs.items():
            if key in allowed and value is not None:
                setattr(bm, key, value)

        self._save()
        return bm

    def delete_bookmark(self, bm_id: str) -> bool:
        """Delete a bookmark by ID."""
        before = len(self.store.bookmarks)
        self.store.bookmarks = [b for b in self.store.bookmarks if b.id != bm_id]
        if len(self.store.bookmarks) < before:
            self._save()
            return True
        return False

    def list_bookmarks(self) -> list[Bookmark]:
        return list(self.store.bookmarks)

    def move_bookmarks(
        self,
        bookmark_ids: list[str],
        target_category_id: str,
    ) -> int:
        """Move multiple bookmarks to *target_category_id*.

        Returns the number of bookmarks actually moved.
        """
        if self._find_category(target_category_id) is None:
            logger.warning("Target category %s does not exist", target_category_id)
            return 0

        moved = 0
        ids_set = set(bookmark_ids)
        for bm in self.store.bookmarks:
            if bm.id in ids_set and bm.category_id != target_category_id:
                bm.category_id = target_category_id
                moved += 1

        if moved:
            self._save()
        return moved

    def _find_bookmark(self, bm_id: str) -> Bookmark | None:
        return next((b for b in self.store.bookmarks if b.id == bm_id), None)

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    def export_json(self) -> str:
        """Serialise the entire store to a JSON string."""
        return self.store.model_dump_json(indent=2)

    def import_json(self, data: str) -> int:
        """Import bookmarks (and optionally categories) from a JSON string.

        Merges into the existing store -- duplicates by ID are skipped.

        Returns the number of bookmarks imported.
        """
        try:
            incoming = BookmarkStore(**json.loads(data))
        except Exception as exc:
            logger.error("Invalid bookmark JSON: %s", exc)
            return 0

        existing_cat_ids = {c.id for c in self.store.categories}
        for cat in incoming.categories:
            if cat.id not in existing_cat_ids:
                self.store.categories.append(cat)
                existing_cat_ids.add(cat.id)

        existing_bm_ids = {b.id for b in self.store.bookmarks}
        imported = 0
        for bm in incoming.bookmarks:
            if bm.id not in existing_bm_ids:
                # Ensure the bookmark's category exists
                if bm.category_id not in existing_cat_ids:
                    bm.category_id = "default"
                self.store.bookmarks.append(bm)
                existing_bm_ids.add(bm.id)
                imported += 1

        if imported:
            self._save()
        logger.info("Imported %d bookmarks", imported)
        return imported
