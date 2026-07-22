"""pathvlm service config from PATHVLM_* env vars.

The Perceptor (MedGemma) — and later the Navigator (PLIP) — run in-process behind a stub seam.
Plain os.getenv (no pydantic), mirroring the cellvit service, so torch/transformers stay out of
the base env.
"""

import os
from dataclasses import dataclass
from functools import lru_cache

# Neutral local fallback only — deployment sets PATHVLM_GIRDER_BASE (compose injects
# http://host.docker.internal:9080/api/v1). Keep the default on port 9080.
_DEFAULT_GIRDER = "http://localhost:9080/api/v1"

# Perceptor input contract: what the MedGemma VLM is fed. Mirrors the frontend's wsiAnalysis
# convention (512 px @ 10x); 20x is the default drill magnification for cell morphology.
_PERCEPTOR_OUT_PX = 512
_PERCEPTOR_DEFAULT_MAG = 20


@dataclass(frozen=True)
class Settings:
    # The Girder whose large_image region endpoint we read WSI pixels from.
    girder_base: str = _DEFAULT_GIRDER
    # MedGemma checkpoint path (e.g. google/medgemma-4b-it); empty => GPU-free stub Perceptor.
    medgemma_ckpt: str = ""
    # Perceptor input contract (objective power + output px handed to the VLM).
    perceptor_out_px: int = _PERCEPTOR_OUT_PX
    perceptor_default_mag: int = _PERCEPTOR_DEFAULT_MAG
    gpu_index: int = 0

    @property
    def use_model(self) -> bool:
        """Real MedGemma runs only when a checkpoint is configured; otherwise the stub."""
        return bool(self.medgemma_ckpt)


@lru_cache
def get_settings() -> Settings:
    return Settings(
        girder_base=os.getenv("PATHVLM_GIRDER_BASE", _DEFAULT_GIRDER),
        medgemma_ckpt=os.getenv("PATHVLM_MEDGEMMA_CKPT", ""),
        perceptor_out_px=int(os.getenv("PATHVLM_PERCEPTOR_OUT_PX", str(_PERCEPTOR_OUT_PX))),
        perceptor_default_mag=int(
            os.getenv("PATHVLM_PERCEPTOR_DEFAULT_MAG", str(_PERCEPTOR_DEFAULT_MAG))
        ),
        gpu_index=int(os.getenv("PATHVLM_GPU_INDEX", "0")),
    )
