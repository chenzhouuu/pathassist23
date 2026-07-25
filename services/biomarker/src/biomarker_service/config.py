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
# Inc 3b: this service's own artifact cache, and the preprocess cache it reads tissue masks from.
_DEFAULT_CACHE = "/cache"
_DEFAULT_PCACHE = "/pcache"


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
    # GigaTIME-Flash consumes native-resolution tiles (the notebook does NO pre-resize); v1 always
    # reads native (scale 1.0) and does NOT resample. This is a VALIDATION knob only: when set, a
    # slide whose native µm/px deviates >20% from it triggers a "FOV may drift" warning (S1/H1).
    expected_input_mpp: float | None = None
    # Pooling disk radius (µm): a nucleus (~7–10 µm) plus a small peri-nuclear margin so membrane
    # markers (CD3/CD8/CD20/CD68/PD-L1) contribute. Converted to px per region via mpp.
    nucleus_radius_um: float = 4.0
    gpu_index: int = 0
    # ── Inc 3b (the marker/phenotype map job) ──────────────────────────────────────
    # Where this service writes its own pyramids + sidecars (own volume).
    cache_root: str = _DEFAULT_CACHE
    # The preprocess artifact cache, mounted READ-ONLY: the job reads a slide's tissue contours
    # from the segmentation stage rather than re-segmenting.
    preprocess_cache_root: str = _DEFAULT_PCACHE
    # Local slide root for the fast OpenSlide read tier (review S5). Empty ⇒ always via Girder.
    slides_root: str = ""
    # Batch CellViT instance, so a multi-hour job never blocks the interactive one (D12). Falls
    # back to the interactive URL when unset, which is correct for a single-GPU dev box.
    cellvit_batch_url: str = ""
    # Stored resolutions (µm/px). marker 1.0 is 4x the model's own 16-px token (~4 µm); pheno is
    # native so nucleus shape survives (D4).
    marker_mpp: float = 1.0
    pheno_mpp: float = 0.25

    @property
    def batch_cellvit_url(self) -> str:
        """CellViT for batch jobs — the isolated instance when configured, else the shared one."""
        return self.cellvit_batch_url or self.cellvit_url

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
        cache_root=os.getenv("BIOMARKER_ARTIFACT_CACHE", _DEFAULT_CACHE),
        preprocess_cache_root=os.getenv("BIOMARKER_PREPROCESS_CACHE", _DEFAULT_PCACHE),
        slides_root=os.getenv("BIOMARKER_SLIDES_ROOT", ""),
        cellvit_batch_url=os.getenv("BIOMARKER_CELLVIT_BATCH_URL", ""),
        marker_mpp=float(os.getenv("BIOMARKER_MARKER_MPP", "1.0")),
        pheno_mpp=float(os.getenv("BIOMARKER_PHENO_MPP", "0.25")),
    )


def _opt_float(v: str | None) -> float | None:
    return float(v) if v else None
