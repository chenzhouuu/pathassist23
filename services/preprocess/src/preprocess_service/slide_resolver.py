"""Resolve a Girder item_id to a local .svs path Trident/OpenSlide can open.

Re-ported from the v1 pathagent worker (git 75d5523^). Three tiers, in order:
  1. local match by raw item_id under a configured slides_root (glob, injection-validated);
  2. local match by the Girder file's name + byte size (identity guard against same-named slides);
  3. stream-download via /file/{id}/download.
Dev points slides_root at /home/chen/data2 (BRACS + TCGA .svs on disk) → tiers 1-2 hit; prod leaves
it unset → tier 3. All Girder access is token-authed.
"""

import glob
import logging
from pathlib import Path

import httpx

from .config import Settings
from .girder_download import (
    WSI_EXTS,
    _validate_segment,
    download_item_slide,
    find_item_slide_file,
)

logger = logging.getLogger(__name__)

_LOOKUP_ERRORS = (httpx.HTTPError, OSError, ValueError, KeyError, AttributeError, TypeError)
_GLOB_METACHARS = ("*", "?", "[", "]")


def _local_candidate(item_id: str, slides_root: Path) -> Path | None:
    """Tier 1: a file named exactly item_id (with or without a WSI extension) under slides_root."""
    _validate_segment(item_id)
    if any(ch in item_id for ch in _GLOB_METACHARS):
        raise ValueError(f"unsafe path segment: {item_id!r}")
    direct = slides_root / item_id
    if direct.is_file():
        return direct
    escaped = glob.escape(item_id)
    for ext in ("",) + WSI_EXTS:
        for hit in slides_root.glob(f"**/{escaped}{ext}"):
            if hit.is_file():
                return hit
    return None


def _girder_slide_file(
    item_id: str, girder_base: str, girder_token: str | None = None,
    *, transport: httpx.BaseTransport | None = None,
) -> dict | None:
    try:
        return find_item_slide_file(item_id, girder_base, girder_token, transport=transport)
    except _LOOKUP_ERRORS as exc:
        logger.warning("girder slide lookup failed for %s: %s", item_id, exc)
        return None


def _local_by_girder_file(file_doc: dict, slides_root: Path) -> Path | None:
    """Tier 2: a local file whose name AND byte size match the Girder file doc."""
    name = file_doc.get("name")
    if not isinstance(name, str) or not name:
        return None
    _validate_segment(name)
    if any(ch in name for ch in _GLOB_METACHARS):
        raise ValueError(f"unsafe slide name: {name!r}")
    size = file_doc.get("size")
    if not isinstance(size, int):
        return None  # cannot verify identity without a size → fall through to download
    candidates: list[Path] = []
    direct = slides_root / name
    if direct.is_file():
        candidates.append(direct)
    escaped = glob.escape(name)
    for hit in sorted(slides_root.glob(f"**/{escaped}")):
        if hit.is_file() and hit not in candidates:
            candidates.append(hit)
    matches = [c for c in candidates if c.stat().st_size == size]  # name AND size
    return matches[0] if matches else None


def resolve_slide(
    item_id: str,
    dest_dir: Path,
    settings: Settings,
    girder_token: str | None = None,
    *,
    transport: httpx.BaseTransport | None = None,
) -> Path:
    """Return a local path to the item's WSI, trying local tiers before downloading."""
    target: dict | None = None
    if settings.slides_root is not None:
        hit = _local_candidate(item_id, settings.slides_root)
        if hit is not None:
            return hit  # tier 1
        target = _girder_slide_file(
            item_id, settings.girder_base, girder_token, transport=transport
        )
        if target is not None:
            try:
                hit = _local_by_girder_file(target, settings.slides_root)
            except ValueError:
                hit = None
            if hit is not None:
                return hit  # tier 2 (name + size)
    return download_item_slide(  # tier 3
        item_id, dest_dir, settings.girder_base, girder_token,
        file_doc=target, transport=transport,
    )
