import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from .config import get_settings
from .schemas import PreprocessRequest

# Bump when the preprocessing pipeline changes in a way that invalidates cached artifacts.
PIPELINE_VERSION = "2"


def _validate_segment(name: str) -> None:
    """Reject values unsafe to use as a filesystem path segment (traversal guard)."""
    if not name or "/" in name or "\\" in name or ".." in name:
        raise ValueError(f"unsafe path segment: {name!r}")


def compute_cache_key(item_id: str, request: PreprocessRequest) -> str:
    """Compute a deterministic cache key from an item id and preprocessing params."""
    _validate_segment(item_id)
    payload = {
        "v": PIPELINE_VERSION,
        "item": item_id,
        "backbone": request.backbone.model_dump(),
        "consensus": request.consensus.model_dump() if request.consensus else None,
        "slidechat": request.slidechat,
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(blob.encode()).hexdigest()[:12]
    return f"{item_id}-{digest}"


@dataclass(frozen=True)
class CachePaths:
    root: Path
    manifest: Path
    coords: Path
    thumbnail: Path
    classifier: Path

    def features(self, encoder: str) -> Path:
        """Path to the patch-feature h5 for a given encoder."""
        _validate_segment(encoder)
        return self.root / f"features_{encoder}.h5"

    def heatmap(self, task_id: str) -> Path:
        """Path to the rendered importance heatmap PNG for a given task."""
        _validate_segment(task_id)
        return self.root / "heatmaps" / f"{task_id}.png"

    def heatmap_meta(self, task_id: str) -> Path:
        """Path to the heatmap metadata JSON for a given task."""
        _validate_segment(task_id)
        return self.root / "heatmaps" / f"{task_id}.json"


def cache_paths(cache_key: str) -> CachePaths:
    """Resolve the on-disk artifact paths for a cache key under the configured cache dir."""
    _validate_segment(cache_key)
    root = get_settings().cache_dir / cache_key
    return CachePaths(
        root=root,
        manifest=root / "manifest.json",
        coords=root / "coords.h5",
        thumbnail=root / "thumbnail.jpg",
        classifier=root / "classifier.json",
    )
