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

# Idle policy. MedGemma shares one GPU with cellvit, tissue and biomarker, so the Perceptor holds
# no weights until something asks for a description and lets them go once it goes quiet. 0 restores
# the old always-resident behaviour for a machine that has a card to spare.
_IDLE_TTL_SEC = 900.0


def _flag(name: str) -> bool:
    """Env flag. Anything that is not an explicit yes reads as no — a typo must not pin a GPU."""
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _seconds(name: str, default: float) -> float:
    try:
        return max(0.0, float(os.getenv(name, "")))
    except ValueError:
        return default


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
    # Release the weights after this many idle seconds; 0 keeps them resident forever.
    idle_ttl: float = _IDLE_TTL_SEC
    # Load at worker startup instead of on the first request. Costs a card from boot.
    warm_start: bool = False

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
        idle_ttl=_seconds("PATHVLM_IDLE_TTL", _IDLE_TTL_SEC),
        warm_start=_flag("PATHVLM_WARM_START"),
    )
