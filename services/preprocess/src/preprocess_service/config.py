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

# Trident defaults (F1/F5). Default encoder is conch_v1 — the vision-language checkpoint whose
# patch features share the text space (re-projected), so a default build enables find_regions text
# search. (conch_v15 is the stronger image-only encoder but is gated to an HF allow-list this
# deployment's token isn't on; UNI v1/v2 are the seeded image-only alternatives.) patch/mag/
# segmenter mirror run_single_slide.py.
_DEFAULT_IMAGE_ENCODER = "conch_v1"
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
    # Patch-encoder batch size for extract_patch_features. Trident defaults to 512, which peaks a
    # few GB per batch and OOMs on the shared A6000 (coresident with CellViT + MedGemma + other
    # users). 128 keeps peak GPU memory in bounds; raise it on a dedicated card (cf. cellvit).
    batch_limit: int = 128
    # Where model weights are cached (all under /home/chen/data2 in this deploy). HF_HOME governs
    # the CONCH encoders (MahmoodLab/conch, conchv1_5, …); TRIDENT_HOME governs the tissue
    # segmenter (deeplabv3_seg_v4.ckpt). None ⇒ leave the process env as-is (Docker ENV / defaults).
    hf_home: Path | None = None
    trident_home: Path | None = None

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
        batch_limit=int(os.getenv("PREPROCESS_BATCH_LIMIT", "128")),
        hf_home=_optpath(os.getenv("PREPROCESS_HF_HOME")),
        trident_home=_optpath(os.getenv("PREPROCESS_TRIDENT_HOME")),
    )


def _optpath(raw: str | None) -> Path | None:
    raw = (raw or "").strip()
    return Path(raw) if raw else None


def apply_model_cache_env(settings: Settings) -> None:
    """Point HuggingFace / Trident at their weight caches (data2) before either is imported.

    Trident and CONCH read HF_HOME / TRIDENT_HOME straight from the process env, and there is no
    in-code redirect hook, so we set them here. Idempotent; a None setting leaves the env untouched
    (so a Docker ENV / an existing value still wins). Call this before the worker imports trident.
    """
    if settings.hf_home is not None:
        os.environ["HF_HOME"] = str(settings.hf_home)
    if settings.trident_home is not None:
        os.environ["TRIDENT_HOME"] = str(settings.trident_home)
