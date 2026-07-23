"""preprocess service config from PREPROCESS_* env vars.

Trident (segmentation + encoders) runs in-process behind a stub seam. Plain os.getenv (no
pydantic), mirroring the cellvit / pathvlm services, so torch / trident stay out of the base env.
"""

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

# Neutral local fallback only — deployment sets PREPROCESS_GIRDER_BASE (compose injects
# http://host.docker.internal:9080/api/v1). Keep the default on port 9080.
_DEFAULT_GIRDER = "http://localhost:9080/api/v1"

# Trident defaults (F1/F5). Image default is conch_v15; text search needs conch_v1 (re-projected)
# or musk — conch_v15 has no text tower. patch/mag/segmenter mirror run_single_slide.py.
_DEFAULT_IMAGE_ENCODER = "conch_v15"
_DEFAULT_TEXT_ENCODER = "conch_v1"
_DEFAULT_MAG = 20
_DEFAULT_PATCH_SIZE = 256
_DEFAULT_SEGMENTER = "hest"
_INDEX_VERSION = "v1"  # bump to invalidate every cached index (part of the params hash)

_DEFAULT_CACHE = Path("/data/preprocess-cache")

# Encoders whose patch features share the text embedding space, so find_regions text search works
# (F1). conch_v15 is image-only despite the name; keep it off this set.
TEXT_CAPABLE_ENCODERS = frozenset({"conch_v1", "musk"})


def _envbool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    # The Girder whose file API we resolve/download the source .svs from.
    girder_base: str = _DEFAULT_GIRDER
    # Local root of original-named slides for the resolver's fast tiers (dev: /home/chen/data2).
    # None => resolver goes straight to the Girder download tier.
    slides_root: Path | None = None
    # Where Trident h5 artifacts (features/coords/contours) are cached, keyed by params hash.
    artifact_cache: Path = _DEFAULT_CACHE
    # Encoders.
    image_encoder: str = _DEFAULT_IMAGE_ENCODER
    text_encoder: str = _DEFAULT_TEXT_ENCODER
    default_mag: int = _DEFAULT_MAG
    default_patch_size: int = _DEFAULT_PATCH_SIZE
    default_segmenter: str = _DEFAULT_SEGMENTER
    index_version: str = _INDEX_VERSION
    # Real Trident+CONCH runs only when explicitly enabled; otherwise the GPU-free stub.
    trident_enabled: bool = False
    gpu_index: int = 0

    @property
    def use_trident(self) -> bool:
        """Real Trident runs only when enabled; otherwise the deterministic stub pipeline."""
        return self.trident_enabled

    @property
    def download_dir(self) -> Path:
        """Scratch dir for the resolver's download tier (§3.3)."""
        return self.artifact_cache / "_download"

    def is_text_capable(self, encoder: str) -> bool:
        return encoder in TEXT_CAPABLE_ENCODERS


@lru_cache
def get_settings() -> Settings:
    root = os.getenv("PREPROCESS_SLIDES_ROOT", "").strip()
    return Settings(
        girder_base=os.getenv("PREPROCESS_GIRDER_BASE", _DEFAULT_GIRDER),
        slides_root=Path(root) if root else None,
        artifact_cache=Path(os.getenv("PREPROCESS_ARTIFACT_CACHE", str(_DEFAULT_CACHE))),
        image_encoder=os.getenv("PREPROCESS_IMAGE_ENCODER", _DEFAULT_IMAGE_ENCODER),
        text_encoder=os.getenv("PREPROCESS_TEXT_ENCODER", _DEFAULT_TEXT_ENCODER),
        default_mag=int(os.getenv("PREPROCESS_DEFAULT_MAG", str(_DEFAULT_MAG))),
        default_patch_size=int(
            os.getenv("PREPROCESS_DEFAULT_PATCH_SIZE", str(_DEFAULT_PATCH_SIZE))
        ),
        default_segmenter=os.getenv("PREPROCESS_DEFAULT_SEGMENTER", _DEFAULT_SEGMENTER),
        index_version=os.getenv("PREPROCESS_INDEX_VERSION", _INDEX_VERSION),
        trident_enabled=_envbool("PREPROCESS_USE_TRIDENT", False),
        gpu_index=int(os.getenv("PREPROCESS_GPU_INDEX", "0")),
    )
