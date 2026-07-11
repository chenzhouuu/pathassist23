import glob
import logging
from pathlib import Path

import httpx

from ..common.cache_keys import _validate_segment
from ..common.config import Settings
from .girder_download import WSI_EXTS, download_item_slide, find_item_slide_file

logger = logging.getLogger(__name__)

# find_item_slide_file is best-effort here; a failure must degrade to a download,
# never crash the RQ job — so we catch the full range a bad/absent listing can raise.
_LOOKUP_ERRORS = (httpx.HTTPError, OSError, ValueError, KeyError, AttributeError, TypeError)

# Glob wildcards must never appear in an item_id: an unescaped "*"/"?"/"[" would
# match unrelated slides (cross-case disclosure). A legitimate slide id/stem has none.
_GLOB_METACHARS = ("*", "?", "[", "]")


def _local_candidate(item_id: str, slides_root: Path) -> Path | None:
    # Reject path traversal / absolute ids and glob wildcards before touching the FS.
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


def _girder_slide_file(item_id: str, girder_base: str,
                       girder_token: str | None = None) -> dict | None:
    """Best-effort Girder file doc (name + size + _id) for the item's WSI, or None.

    Returns None on any failure so the caller can fall back to a full download
    instead of crashing preprocessing.
    """
    try:
        return find_item_slide_file(item_id, girder_base, girder_token)
    except _LOOKUP_ERRORS as exc:
        logger.warning("girder slide lookup failed for %s: %s", item_id, exc)
        return None


def _local_by_girder_file(file_doc: dict, slides_root: Path) -> Path | None:
    """Match a Girder file doc to a local slide by exact name AND byte size.

    Filenames — unlike Girder item ids — are not unique across cases, so a name-only
    match over a recursive glob could silently select a different patient's same-named
    slide. Requiring the on-disk size to equal the Girder file's size makes a wrong
    match effectively impossible short of a full content hash. Returns None (→ download)
    when the size is unknown or nothing matches. Raises ValueError on a hostile name.
    """
    name = file_doc.get("name")
    if not isinstance(name, str) or not name:
        return None
    # Reject traversal / absolute / glob names before touching the FS (mirrors
    # _local_candidate); a hostile name raises, and resolve_slide downloads instead.
    _validate_segment(name)
    if any(ch in name for ch in _GLOB_METACHARS):
        raise ValueError(f"unsafe slide name: {name!r}")
    size = file_doc.get("size")
    if not isinstance(size, int):
        return None  # cannot verify identity without a size → download to be safe

    candidates: list[Path] = []
    direct = slides_root / name
    if direct.is_file():
        candidates.append(direct)
    escaped = glob.escape(name)
    for hit in sorted(slides_root.glob(f"**/{escaped}")):
        if hit.is_file() and hit not in candidates:
            candidates.append(hit)

    matches = [c for c in candidates if c.stat().st_size == size]
    if not matches:
        if candidates:
            logger.warning("local slide %r found (%d candidate(s)) but none match "
                           "girder size %d — downloading", name, len(candidates), size)
        return None
    if len(matches) > 1:
        logger.warning("multiple size-matching local slides for %r: %s — using %s",
                       name, matches, matches[0])
    return matches[0]


def resolve_slide(item_id: str, dest_dir: Path, settings: Settings,
                  girder_token: str | None = None) -> Path:
    """Resolve a slide file for item_id: local slides_root first, else Girder download.

    Local matching is tried twice: by the raw item_id (for deployments that name
    slides by id), then by the item's Girder file name + size (the common case where
    on-disk files keep their original name, e.g. BRACS_1648.svs). Only if neither
    matches locally is the multi-GB file streamed out of Girder — and the already
    fetched file doc is reused for that download, so no extra metadata round-trip.
    """
    target: dict | None = None
    if settings.slides_root is not None:
        hit = _local_candidate(item_id, settings.slides_root)
        if hit is not None:
            logger.info("resolved %s -> local %s", item_id, hit)
            return hit
        target = _girder_slide_file(item_id, settings.girder_base, girder_token)
        if target is not None:
            try:
                hit = _local_by_girder_file(target, settings.slides_root)
            except ValueError:
                # A hostile Girder filename — let the download path reject it consistently.
                hit = None
            if hit is not None:
                logger.info("resolved %s -> local %s (girder name %r, size-matched)",
                            item_id, hit, target.get("name"))
                return hit
    logger.info("resolving %s via Girder download", item_id)
    return download_item_slide(item_id, dest_dir, settings.girder_base, girder_token,
                               file_doc=target)
