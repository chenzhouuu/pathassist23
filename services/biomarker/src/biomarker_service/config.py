"""Biomarker service config from BIOMARKER_* env vars.

No pydantic (mirrors cellvit): the real GigaTIME-Flash model runs in-process behind the
`infer.predict_mif` seam, and torch/timm are imported lazily only on the real path — plain
os.getenv keeps the base env GPU-free.

Three run modes, decided by :meth:`Settings.mode`:
- ``"real"``   — weights present ⇒ real GigaTIME-Flash (needs the trident/GPU image).
- ``"stub"``   — ``BIOMARKER_DEV_STUB=1`` and no weights ⇒ a deterministic dev stub so the whole
                 phenotype path (tool → fusion → overlay) is browser-E2E-able with no GPU. Off by
                 default: production without weights must NOT fabricate phenotypes.
- ``"unavailable"`` — neither ⇒ ``/phenotype`` returns 503 (an honest "GPU worker needed").
"""

import os
from dataclasses import dataclass
from functools import lru_cache

# Neutral local fallback only — deployment sets BIOMARKER_GIRDER_BASE. Keep the default on 9080.
_DEFAULT_GIRDER = "http://localhost:9080/api/v1"
# The CellViT service the fusion fetches nuclei centroids from (service→service; centroids are
# small, so this stays cheap and the dense mIF never leaves this process — design decision 5).
_DEFAULT_CELLVIT = "http://cellvit:8020"
# GigaTIME-Flash weights dir (the user's offline `hf download` target, mounted at /weights).
_DEFAULT_WEIGHTS = "/weights/gigatime"
# The HF repo ships the checkpoint as `model.pth`.
_WEIGHTS_FILE = "model.pth"


@dataclass(frozen=True)
class Settings:
    # The Girder whose large_image region endpoint we read WSI pixels from.
    girder_base: str = _DEFAULT_GIRDER
    # Directory holding the GigaTIME-Flash checkpoint (model.pth).
    weights_dir: str = _DEFAULT_WEIGHTS
    # The CellViT service base URL (nuclei centroids for the fusion).
    cellvit_url: str = _DEFAULT_CELLVIT
    # Dev-only deterministic stub, gated ON explicitly (never in production).
    dev_stub: bool = False
    # GigaTIME-Flash consumes native-resolution tiles (the notebook does NO pre-resize). None ⇒
    # read at the slide's native magnification (scale 1.0); set a value to pin a target µm/px (S1).
    expected_input_mpp: float | None = None
    # Pooling disk radius (µm): a nucleus (~7–10 µm) plus a small peri-nuclear margin so membrane
    # markers (CD3/CD8/CD20/CD68/PD-L1) contribute. Converted to px per region via mpp.
    nucleus_radius_um: float = 4.0
    gpu_index: int = 0

    @property
    def weights_file(self) -> str:
        return os.path.join(self.weights_dir, _WEIGHTS_FILE)

    @property
    def has_weights(self) -> bool:
        return os.path.isfile(self.weights_file)

    @property
    def mode(self) -> str:
        if self.has_weights:
            return "real"
        if self.dev_stub:
            return "stub"
        return "unavailable"


@lru_cache
def get_settings() -> Settings:
    return Settings(
        girder_base=os.getenv("BIOMARKER_GIRDER_BASE", _DEFAULT_GIRDER),
        weights_dir=os.getenv("BIOMARKER_WEIGHTS", _DEFAULT_WEIGHTS),
        cellvit_url=os.getenv("BIOMARKER_CELLVIT_URL", _DEFAULT_CELLVIT),
        dev_stub=os.getenv("BIOMARKER_DEV_STUB", "").lower() in {"1", "true", "yes"},
        expected_input_mpp=_opt_float(os.getenv("BIOMARKER_INPUT_MPP")),
        nucleus_radius_um=float(os.getenv("BIOMARKER_NUCLEUS_RADIUS_UM", "4.0")),
        gpu_index=int(os.getenv("BIOMARKER_GPU_INDEX", "0")),
    )


def _opt_float(v: str | None) -> float | None:
    return float(v) if v else None
