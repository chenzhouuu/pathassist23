"""CellViT service config from CELLVIT_* env vars.

No pydantic here on purpose: cellvit is built for pydantic v1, so the service stays
pydantic-free (plain os.getenv) and can host cellvit in-process.
"""

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

# Neutral local fallback only — deployment sets CELLVIT_GIRDER_BASE (compose injects
# http://host.docker.internal:9080/api/v1). Keep the default on port 9080.
_DEFAULT_GIRDER = "http://localhost:9080/api/v1"


@dataclass(frozen=True)
class Settings:
    # The Girder whose large_image region endpoint we read WSI pixels from.
    girder_base: str = _DEFAULT_GIRDER
    # Which segmentation model /segment uses: "stub" (GPU-free grid) or "cellvit" (real GPU).
    model: str = "stub"
    # Real-model (model == "cellvit") runtime settings; ignored by the stub.
    gpu_index: int = 0
    batch_size: int = 8
    # Where nuclei artifacts live (Inc 5). Its own volume, like every other service's — named
    # CELLVIT_ARTIFACT_CACHE to match its siblings and, more to the point, to stay clearly
    # distinct from CELLVIT_CACHE, which is where the 2.7 GB SAM-H checkpoint lives.
    artifact_cache: Path = Path("/cache")
    # The preprocess DAG's artifacts, mounted read-only. A whole-slide run reads this slide's
    # tissue contours from there to decide which cores are worth the GPU (Inc 5, ticket 07).
    preprocess_cache: Path = Path("/pcache")
    # Refuse to *start* a whole-slide run below this. Nuclei store at 0.25 µm/px — 16x the tissue
    # map's pixel density — so filling the volume mid-job is a real risk, and a half-written
    # pyramid renders as holes rather than as an error.
    min_free_gb: float = 20.0


@lru_cache
def get_settings() -> Settings:
    return Settings(
        girder_base=os.getenv("CELLVIT_GIRDER_BASE", _DEFAULT_GIRDER),
        model=os.getenv("CELLVIT_MODEL", "stub"),
        gpu_index=int(os.getenv("CELLVIT_GPU_INDEX", "0")),
        batch_size=int(os.getenv("CELLVIT_BATCH_SIZE", "8")),
        artifact_cache=Path(os.getenv("CELLVIT_ARTIFACT_CACHE", "/cache")),
        preprocess_cache=Path(os.getenv("CELLVIT_PREPROCESS_CACHE", "/pcache")),
        min_free_gb=float(os.getenv("CELLVIT_MIN_FREE_GB", "20.0")),
    )
