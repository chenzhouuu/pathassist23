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

# Trident defaults (F1/F5). patch/mag/segmenter mirror run_single_slide.py.
#
# CONCH v1 is TWO encoders, and conflating them cost us a silent failure (Inc 2c):
#   conch_v1       — Trident's own defaults (with_proj=False, normalize=False): the vision tower
#                    embedding, ‖v‖ ≈ 22.6. This is what every MIL model in hgmil trained on.
#   conch_v1_text  — with_proj=True, normalize=True: the CONCH text–image contrastive space, unit
#                    norm. This is what find_regions searches.
# They are NOT the same vectors at a different scale — measured per-patch cosine between them
# (after L2) is ~0.005, i.e. near-orthogonal. Keeping them as separate encoder ids is what makes
# feat_hash able to tell an index built for search from one built for a model.
#
# The default build target stays the text variant so a default index still powers Copilot search;
# a downstream task declares the vision variant in its own feature_spec and offers to build it.
_DEFAULT_IMAGE_ENCODER = "conch_v1_text"
_DEFAULT_TEXT_ENCODER = "conch_v1_text"
_DEFAULT_MAG = 20
_DEFAULT_PATCH_SIZE = 256
_DEFAULT_SEGMENTER = "hest"
_INDEX_VERSION = "v1"  # bump to invalidate every cached index (part of the params hash)
# Features-only invalidation, so a change in what an encoder *means* doesn't force a re-segmentation
# and re-tiling. Bumped to v2 when conch_v1 was split into the vision/text variants above: artifacts
# built before that carry `encoder: "conch_v1"` but hold text-space vectors, and must never be
# handed to a task as if they were the vision embedding.
_FEAT_VERSION = "v2"

_DEFAULT_CACHE = Path("/data/preprocess-cache")
_DEFAULT_MIL_WEIGHTS = Path("/weights/mil")

# Encoders whose patch features share the text embedding space, so find_regions text search works
# (F1). conch_v15 is image-only despite the name; keep it off this set. Plain `conch_v1` is the
# vision variant and is deliberately NOT here — its vectors never entered the text space.
TEXT_CAPABLE_ENCODERS = frozenset({"conch_v1_text", "musk"})

# encoder id → kwargs for trident's encoder_factory. An id absent here takes Trident's defaults.
ENCODER_KWARGS: dict[str, dict] = {
    "conch_v1_text": {"with_proj": True, "normalize": True},
}


def encoder_kwargs(encoder: str) -> dict:
    """The encoder_factory kwargs that define this encoder id's embedding space."""
    return dict(ENCODER_KWARGS.get(encoder, {}))


def encoder_model(encoder: str) -> str:
    """The Trident model name behind an id (the text variant is the same checkpoint)."""
    return "conch_v1" if encoder == "conch_v1_text" else encoder


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
    feat_version: str = _FEAT_VERSION
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
    # Root of the downstream-task MIL checkpoints (Inc 2c). Small (< 1 MB each) and CPU-loadable,
    # but they live beside the encoders on data2, mounted at /weights in the trident compose.
    mil_weights: Path = _DEFAULT_MIL_WEIGHTS

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
        feat_version=os.getenv("PREPROCESS_FEAT_VERSION", _FEAT_VERSION),
        trident_enabled=_envbool("PREPROCESS_USE_TRIDENT", False),
        gpu_index=int(os.getenv("PREPROCESS_GPU_INDEX", "0")),
        batch_limit=int(os.getenv("PREPROCESS_BATCH_LIMIT", "128")),
        hf_home=_optpath(os.getenv("PREPROCESS_HF_HOME")),
        trident_home=_optpath(os.getenv("PREPROCESS_TRIDENT_HOME")),
        mil_weights=Path(os.getenv("PREPROCESS_MIL_WEIGHTS", str(_DEFAULT_MIL_WEIGHTS))),
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
