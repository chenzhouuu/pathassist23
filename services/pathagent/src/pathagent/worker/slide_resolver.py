import glob
import logging
from pathlib import Path

from ..common.cache_keys import _validate_segment
from ..common.config import Settings
from .girder_download import WSI_EXTS, download_item_slide

logger = logging.getLogger(__name__)

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


def resolve_slide(item_id: str, dest_dir: Path, settings: Settings,
                  girder_token: str | None = None) -> Path:
    """Resolve a slide file for item_id: local slides_root first, else Girder download."""
    if settings.slides_root is not None:
        hit = _local_candidate(item_id, settings.slides_root)
        if hit is not None:
            logger.info("resolved %s -> local %s", item_id, hit)
            return hit
    logger.info("resolving %s via Girder download", item_id)
    return download_item_slide(item_id, dest_dir, settings.girder_base, girder_token)
