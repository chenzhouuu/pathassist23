"""The preprocess DAG as three independently-runnable stages (Inc 2b-3).

    segment(slide)               → contours.geojson   (tissue vs background)
      └─ patch(seg, mag, ps)     → coords.h5          (level-0 patch grid on that tissue)
          └─ features(patch, enc)→ features.h5        (encoder embeddings, index-aligned)

Each stage reads its parent's artifact off the content-addressed cache (the worker stays
DB-stateless) and writes its own. The GPU-free stub chains deterministically so the whole DAG is
CI-testable with no GPU/Trident; the real Trident recipe imports torch/trident lazily behind
`use_trident` and is exercised only by manual GPU smoke (like cellvit/pathvlm).
"""

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .artifacts import (
    read_coords_h5,
    write_contours_geojson,
    write_coords_h5,
    write_features_h5,
)
from .gpu import cuda_cache_released

logger = logging.getLogger(__name__)

OnStage = Callable[[str, float], None]

# Stub constants — a deterministic synthetic slide with one square of "tissue".
_STUB_DIM = 16
_STUB_NATIVE_MAG = 40
_STUB_TISSUE_SIDE = 4096  # level-0 px side of the synthetic tissue square


@dataclass
class SegResult:
    n_contours: int
    contours_ref: str


@dataclass
class PatchResult:
    n_patches: int
    coords_ref: str


@dataclass
class FeatureResult:
    n_patches: int
    dim: int
    encoder: str
    features_ref: str


# ── Public stage entry points (stub/real dispatch) ──────────────────────────────────


def run_segmentation(
    slide_path: Path, params: dict, seg_sink: dict[str, Path], *,
    use_trident: bool = False, on_stage: OnStage | None = None,
) -> SegResult:
    """Segment tissue vs background; write contours.geojson into ``seg_sink``."""
    cb: OnStage = on_stage or (lambda *_: None)
    if use_trident:
        with cuda_cache_released():
            return _trident_segment(slide_path, params, seg_sink, cb)
    return _stub_segment(params, seg_sink, cb)


def run_patching(
    slide_path: Path, params: dict, seg_sink: dict[str, Path], patch_sink: dict[str, Path], *,
    use_trident: bool = False, on_stage: OnStage | None = None,
) -> PatchResult:
    """Tile the segmented tissue at (mag, patch_size, overlap); write coords.h5."""
    cb: OnStage = on_stage or (lambda *_: None)
    if use_trident:
        with cuda_cache_released():
            return _trident_patch(slide_path, params, seg_sink, patch_sink, cb)
    return _stub_patch(params, seg_sink, patch_sink, cb)


def run_features(
    slide_path: Path, params: dict, patch_sink: dict[str, Path], feat_sink: dict[str, Path], *,
    use_trident: bool = False, on_stage: OnStage | None = None, batch_limit: int = 128,
) -> FeatureResult:
    """Encode each patch with ``encoder``; write index-aligned features.h5."""
    cb: OnStage = on_stage or (lambda *_: None)
    if use_trident:
        with cuda_cache_released():
            return _trident_features(slide_path, params, patch_sink, feat_sink, cb, batch_limit)
    return _stub_features(params, patch_sink, feat_sink, cb)


# ── Stub chain (GPU-free, deterministic, CI) ────────────────────────────────────────


def _stub_segment(params: dict, seg_sink: dict[str, Path], on_stage: OnStage) -> SegResult:
    on_stage("segmentation", 1.0)
    s = _STUB_TISSUE_SIDE
    ring = [[0, 0], [s, 0], [s, s], [0, s], [0, 0]]
    gj = {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {"kind": "tissue"},
                      "geometry": {"type": "Polygon", "coordinates": [ring]}}],
    }
    write_contours_geojson(seg_sink["contours"], gj)
    return SegResult(n_contours=1, contours_ref=str(seg_sink["contours"]))


def _stub_patch(
    params: dict, seg_sink: dict[str, Path], patch_sink: dict[str, Path], on_stage: OnStage,
) -> PatchResult:
    on_stage("patching", 1.0)
    x0, y0, x1, y1 = _bbox_of(seg_sink["contours"])
    mag, patch_size = int(params["mag"]), int(params["patch_size"])
    overlap = int(params.get("overlap", 0))
    ps0 = patch_size * max(1, _STUB_NATIVE_MAG // mag)  # level-0 side length
    step = max(1, ps0 - overlap * max(1, _STUB_NATIVE_MAG // mag))
    xs = range(int(x0), max(int(x0) + 1, int(x1) - ps0 + 1), step)
    ys = range(int(y0), max(int(y0) + 1, int(y1) - ps0 + 1), step)
    coords = np.array([[x, y] for y in ys for x in xs], dtype=np.int64)
    attrs = {
        "patch_size_level0": ps0, "target_magnification": mag,
        "level0_magnification": _STUB_NATIVE_MAG, "overlap": overlap,
    }
    write_coords_h5(patch_sink["coords"], coords, attrs)
    return PatchResult(n_patches=len(coords), coords_ref=str(patch_sink["coords"]))


def _stub_features(
    params: dict, patch_sink: dict[str, Path], feat_sink: dict[str, Path], on_stage: OnStage,
) -> FeatureResult:
    on_stage("features", 1.0)
    encoder = str(params["encoder"])
    coords, attrs = read_coords_h5(patch_sink["coords"])
    feats = (
        np.stack([_stub_vec(x, y, _STUB_DIM) for x, y in coords]).astype(np.float32)
        if len(coords) else np.zeros((0, _STUB_DIM), dtype=np.float32)
    )
    write_features_h5(feat_sink["features"], feats, coords, {**attrs, "encoder": encoder})
    return FeatureResult(
        n_patches=len(coords), dim=_STUB_DIM, encoder=encoder,
        features_ref=str(feat_sink["features"]),
    )


def _stub_vec(x: int, y: int, dim: int) -> np.ndarray:
    """A deterministic unit-norm feature for a patch at level-0 (x, y)."""
    rng = np.random.default_rng(seed=(int(x) * 73856093) ^ (int(y) * 19349663))
    v = rng.standard_normal(dim).astype(np.float32)
    return v / (np.linalg.norm(v) + 1e-8)


def _bbox_of(contours_path: Path) -> tuple[int, int, int, int]:
    """(x0, y0, x1, y1) bounding all tissue polygons in a contours geojson."""
    gj = json.loads(Path(contours_path).read_text())
    pts = [
        pt
        for feat in gj.get("features", [])
        for ring in feat.get("geometry", {}).get("coordinates", [])
        for pt in ring
    ]
    if not pts:
        return (0, 0, _STUB_TISSUE_SIDE, _STUB_TISSUE_SIDE)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys)))


# ── Real Trident recipe (lazy import; manual GPU smoke, never CI) ────────────────────


def _trident_segment(
    slide_path: Path, params: dict, seg_sink: dict[str, Path], on_stage: OnStage,
) -> SegResult:
    from trident import load_wsi
    from trident.segmentation_models import segmentation_model_factory

    job_dir = seg_sink["dir"]
    job_dir.mkdir(parents=True, exist_ok=True)
    seg_model = segmentation_model_factory(
        params["segmenter"], confidence_thresh=float(params.get("seg_conf_thresh", 0.5)),
    )
    on_stage("segmentation", 0.2)
    with load_wsi(slide_path=str(slide_path), lazy_init=False) as slide:
        slide.segment_tissue(
            segmentation_model=seg_model, target_mag=seg_model.target_mag,
            job_dir=str(job_dir), holes_are_tissue=not bool(params.get("remove_holes", False)),
        )
    gj = _copy_contours(job_dir, slide_path, seg_sink["contours"])
    on_stage("segmentation", 1.0)
    n = len(gj.get("features", [])) if gj else 0
    return SegResult(n_contours=n, contours_ref=str(seg_sink["contours"]))


def _trident_patch(
    slide_path: Path, params: dict, seg_sink: dict[str, Path], patch_sink: dict[str, Path],
    on_stage: OnStage,
) -> PatchResult:
    import shutil

    import h5py
    from trident import load_wsi

    patch_sink["dir"].mkdir(parents=True, exist_ok=True)
    on_stage("patching", 0.3)
    with load_wsi(
        slide_path=str(slide_path), lazy_init=False,
        tissue_seg_path=str(seg_sink["contours"]),
    ) as slide:
        coords_path = slide.extract_tissue_coords(
            target_mag=int(params["mag"]), patch_size=int(params["patch_size"]),
            save_coords=str(patch_sink["dir"]), overlap=int(params.get("overlap", 0)),
        )
    # Preserve Trident's coords h5 verbatim (keeps every geometry attr the encoder needs).
    if Path(coords_path) != patch_sink["coords"]:
        shutil.copy(coords_path, patch_sink["coords"])
    with h5py.File(patch_sink["coords"], "r") as f:
        n = int(f["coords"].shape[0])
    on_stage("patching", 1.0)
    return PatchResult(n_patches=n, coords_ref=str(patch_sink["coords"]))


def _trident_features(
    slide_path: Path, params: dict, patch_sink: dict[str, Path], feat_sink: dict[str, Path],
    on_stage: OnStage, batch_limit: int,
) -> FeatureResult:
    from trident import load_wsi
    from trident.patch_encoder_models import encoder_factory

    feat_sink["dir"].mkdir(parents=True, exist_ok=True)
    encoder_name = str(params["encoder"])
    # The encoder ID carries its embedding space: `conch_v1` is Trident's default vision tower
    # (what MIL models train on), `conch_v1_text` adds the contrastive projection find_regions
    # searches. Same checkpoint, near-orthogonal outputs — see config.ENCODER_KWARGS.
    from .config import encoder_kwargs, encoder_model

    encoder = encoder_factory(encoder_model(encoder_name), **encoder_kwargs(encoder_name))
    on_stage("features", 0.2)
    with load_wsi(slide_path=str(slide_path), lazy_init=False) as slide:
        feat_path = slide.extract_patch_features(
            patch_encoder=encoder, coords_path=str(patch_sink["coords"]),
            save_features=str(feat_sink["dir"]), batch_limit=batch_limit,
        )
    features, coords, attrs = _read_trident_features(feat_path)
    write_features_h5(feat_sink["features"], features, coords, {**attrs, "encoder": encoder_name})
    on_stage("features", 1.0)
    return FeatureResult(
        n_patches=len(coords), dim=int(features.shape[1]), encoder=encoder_name,
        features_ref=str(feat_sink["features"]),
    )


def _read_trident_features(feat_path: str):
    import h5py

    with h5py.File(feat_path, "r") as f:
        features = f["features"][:]
        coords = f["coords"][:]
        attrs = dict(f["coords"].attrs)
    return features, coords, attrs


def _copy_contours(job_dir: Path, slide_path: Path, dest: Path) -> dict | None:
    src = job_dir / "contours_geojson" / (Path(slide_path).stem + ".geojson")
    if src.is_file():
        gj = json.loads(src.read_text())
        write_contours_geojson(dest, gj)
        return gj
    return None
