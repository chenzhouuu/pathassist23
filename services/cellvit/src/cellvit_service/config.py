"""CellViT service config from CELLVIT_* env vars.

No pydantic here on purpose: cellvit is built for pydantic v1, so the service stays
pydantic-free (plain os.getenv) and can host cellvit in-process.
"""

import os
from dataclasses import dataclass
from functools import lru_cache

_DEFAULT_GIRDER = "https://lymphoma.dev.pathassist.health/api/v1"


@dataclass(frozen=True)
class Settings:
    # The Girder whose large_image region endpoint we read WSI pixels from.
    girder_base: str = _DEFAULT_GIRDER
    # Which segmentation model /segment uses: "stub" (GPU-free grid) or "cellvit" (real GPU).
    model: str = "stub"
    # Real-model (model == "cellvit") runtime settings; ignored by the stub.
    gpu_index: int = 0
    batch_size: int = 8


@lru_cache
def get_settings() -> Settings:
    return Settings(
        girder_base=os.getenv("CELLVIT_GIRDER_BASE", _DEFAULT_GIRDER),
        model=os.getenv("CELLVIT_MODEL", "stub"),
        gpu_index=int(os.getenv("CELLVIT_GPU_INDEX", "0")),
        batch_size=int(os.getenv("CELLVIT_BATCH_SIZE", "8")),
    )
