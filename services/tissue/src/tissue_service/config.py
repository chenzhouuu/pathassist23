"""Tissue service config from TISSUE_* env vars.

No pydantic (mirrors cellvit/biomarker): the dense segmenter runs in-process behind the
``app.config["PREDICT"]`` seam, and torch/torchvision are imported lazily only on the real path,
so the base env stays GPU-free.

Two run modes:
- ``"real"``        — the backend's checkpoint is present ⇒ real inference (GPU image).
- ``"unavailable"`` — no weights ⇒ ``POST /tissue`` returns 503. There is deliberately **no dev
  stub**: a fabricated tissue map is indistinguishable from a real one at a glance, and unlike
  Inc 3b's phenotype stub it would produce area fractions that look quotable.
"""

import os
from dataclasses import dataclass
from functools import lru_cache

# Neutral local fallback only — deployment sets TISSUE_GIRDER_BASE. Keep the default on 9080.
_DEFAULT_GIRDER = "http://localhost:9080/api/v1"
# Backend checkpoints (the BCSS .pth and any future ones) live here, mounted read-only.
_DEFAULT_WEIGHTS = "/weights/tissue"
_DEFAULT_CACHE = "/cache"
_DEFAULT_PCACHE = "/pcache"


@dataclass(frozen=True)
class Settings:
    girder_base: str = _DEFAULT_GIRDER
    # Directory holding the backend checkpoints (Backend.weights_file resolves inside it).
    weights_dir: str = _DEFAULT_WEIGHTS
    # Where this service writes its own pyramids + sidecars (own volume).
    cache_root: str = _DEFAULT_CACHE
    # The preprocess artifact cache, mounted READ-ONLY: the job reads a slide's tissue contours
    # from the segmentation stage rather than re-segmenting.
    preprocess_cache_root: str = _DEFAULT_PCACHE
    # Local slide root for the fast OpenSlide read tier. Empty ⇒ always via Girder.
    slides_root: str = ""
    # Stored raster resolution (µm/px). 1.0 is 2 octaves coarser than a 0.25 µm/px slide, which is
    # ample for boundaries that are tens of µm wide, and matches Inc 3b's marker layer offset.
    store_mpp: float = 1.0
    # Sliding-window overlap in model-input px. 0 by default: the network already discards 256 px
    # of context per side (1024 in → 512 out), so butt-jointed outputs may already be seamless.
    # Raised only if the measured seam gradient says so (design §5).
    overlap: int = 0
    gpu_index: int = 0
    # Whole-slide jobs refuse below this much free space on the cache volume (GB).
    min_free_gb: float = 3.0

    def weights_path(self, filename: str) -> str:
        return os.path.join(self.weights_dir, filename)

    def has_weights(self, filename: str) -> bool:
        return os.path.isfile(self.weights_path(filename))


@lru_cache
def get_settings() -> Settings:
    return Settings(
        girder_base=os.getenv("TISSUE_GIRDER_BASE", _DEFAULT_GIRDER),
        weights_dir=os.getenv("TISSUE_WEIGHTS", _DEFAULT_WEIGHTS),
        cache_root=os.getenv("TISSUE_ARTIFACT_CACHE", _DEFAULT_CACHE),
        preprocess_cache_root=os.getenv("TISSUE_PREPROCESS_CACHE", _DEFAULT_PCACHE),
        slides_root=os.getenv("TISSUE_SLIDES_ROOT", ""),
        store_mpp=float(os.getenv("TISSUE_STORE_MPP", "1.0")),
        overlap=int(os.getenv("TISSUE_OVERLAP", "0")),
        gpu_index=int(os.getenv("TISSUE_GPU_INDEX", "0")),
        min_free_gb=float(os.getenv("TISSUE_MIN_FREE_GB", "3.0")),
    )
