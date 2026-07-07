import logging
from pathlib import Path

from ..common.config import Settings
from .girder_download import WSI_EXTS, download_item_slide

logger = logging.getLogger(__name__)


def _local_candidate(item_id: str, slides_root: Path) -> Path | None:
    direct = slides_root / item_id
    if direct.is_file():
        return direct
    for ext in ("",) + WSI_EXTS:
        for hit in slides_root.glob(f"**/{item_id}{ext}"):
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
