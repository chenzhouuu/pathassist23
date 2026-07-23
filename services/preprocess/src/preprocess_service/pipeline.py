"""The Trident preprocessing pipeline, behind a stub/real seam (like cellvit R8→R11 / MedGemma).

`run_pipeline` drives segment → patch → feature-extract and writes an index-aligned features h5
(features [N, dim] + level-0 coords [N, 2] with geometry attrs) plus a tissue-contours GeoJSON into
the artifact sink. The GPU-free stub synthesizes a deterministic tissue grid so the whole path
(resolve→segment→patch→encode→sink→status) is CI-testable with no GPU/Trident; the real
`_trident_pipeline` (WSI-object recipe: load_wsi → segment_tissue → extract_tissue_coords →
extract_patch_features) imports torch/trident lazily and lands behind `use_trident`.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .artifacts import write_contours_geojson, write_features_h5

logger = logging.getLogger(__name__)

# Stages reported through on_stage(name, progress) — the panel's progress bar reads these.
STAGES = ("segmentation", "patching", "features")

_STUB_DIM = 16       # stub embedding width
_STUB_GRID = 4       # 4×4 = 16 synthetic tissue patches
_STUB_NATIVE_MAG = 40

OnStage = Callable[[str, float], None]


@dataclass
class PipelineResult:
    n_patches: int
    dim: int
    encoder: str
    features_ref: str            # path to features.h5 (features + index-aligned level-0 coords)
    contours_ref: str            # path to contours.geojson
    stage_log: list[str] = field(default_factory=list)


def run_pipeline(
    slide_path: Path,
    params: dict,
    sink: dict[str, Path],
    *,
    use_trident: bool = False,
    on_stage: OnStage | None = None,
    batch_limit: int = 128,
) -> PipelineResult:
    """Segment → patch → extract features for ``slide_path``; write artifacts into ``sink``."""
    cb: OnStage = on_stage or (lambda *_: None)
    if use_trident:
        return _trident_pipeline(slide_path, params, sink, cb, batch_limit)
    return _stub_pipeline(slide_path, params, sink, cb)


def _stub_vec(x: int, y: int, dim: int) -> np.ndarray:
    """A deterministic unit-norm feature for a patch at level-0 (x, y)."""
    rng = np.random.default_rng(seed=(int(x) * 73856093) ^ (int(y) * 19349663))
    v = rng.standard_normal(dim).astype(np.float32)
    return v / (np.linalg.norm(v) + 1e-8)


def _stub_pipeline(
    slide_path: Path, params: dict, sink: dict[str, Path], on_stage: OnStage
) -> PipelineResult:
    mag = int(params["mag"])
    patch_size = int(params["patch_size"])
    encoder = str(params["encoder"])
    ps0 = patch_size * max(1, _STUB_NATIVE_MAG // mag)  # level-0 side length

    on_stage("segmentation", 0.33)
    coords = np.array(
        [[i * ps0, j * ps0] for j in range(_STUB_GRID) for i in range(_STUB_GRID)],
        dtype=np.int64,
    )
    on_stage("patching", 0.66)
    feats = np.stack([_stub_vec(x, y, _STUB_DIM) for x, y in coords]).astype(np.float32)
    on_stage("features", 1.0)

    attrs = {
        "patch_size_level0": ps0,
        "target_magnification": mag,
        "level0_magnification": _STUB_NATIVE_MAG,
        "encoder": encoder,
    }
    write_features_h5(sink["features"], feats, coords, attrs)
    write_contours_geojson(sink["contours"], _grid_contour(coords, ps0))
    return PipelineResult(
        n_patches=len(coords), dim=_STUB_DIM, encoder=encoder,
        features_ref=str(sink["features"]), contours_ref=str(sink["contours"]),
        stage_log=list(STAGES),
    )


def _grid_contour(coords: np.ndarray, ps0: int) -> dict:
    """A single polygon bounding the synthetic patch grid (level-0 px)."""
    x0, y0 = coords.min(axis=0).tolist()
    x1, y1 = (coords.max(axis=0) + ps0).tolist()
    ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
    return {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {"kind": "tissue"},
                      "geometry": {"type": "Polygon", "coordinates": [ring]}}],
    }


def _trident_pipeline(
    slide_path: Path, params: dict, sink: dict[str, Path], on_stage: OnStage,
    batch_limit: int = 128,
) -> PipelineResult:
    """Real Trident recipe (WSI-object). Not exercised in CI (manual GPU smoke)."""
    import h5py  # noqa: F401 — ensure h5 stack present
    from trident import load_wsi
    from trident.patch_encoder_models import encoder_factory
    from trident.segmentation_models import segmentation_model_factory

    mag = int(params["mag"])
    patch_size = int(params["patch_size"])
    encoder_name = str(params["encoder"])
    segmenter = str(params["segmenter"])
    job_dir = sink["dir"]
    job_dir.mkdir(parents=True, exist_ok=True)

    # Text-search encoders must live in the shared contrastive space (F1): conch_v1 needs projection
    enc_kwargs = {"with_proj": True, "normalize": True} if encoder_name == "conch_v1" else {}
    encoder = encoder_factory(encoder_name, **enc_kwargs)
    seg_model = segmentation_model_factory(segmenter)

    with load_wsi(slide_path=str(slide_path), lazy_init=False) as slide:
        on_stage("segmentation", 0.2)
        slide.segment_tissue(
            segmentation_model=seg_model, target_mag=seg_model.target_mag, job_dir=str(job_dir),
        )
        on_stage("patching", 0.5)
        coords_path = slide.extract_tissue_coords(
            target_mag=mag, patch_size=patch_size, save_coords=str(job_dir),
        )
        on_stage("features", 0.7)
        feat_path = slide.extract_patch_features(
            patch_encoder=encoder, coords_path=coords_path, save_features=str(job_dir),
            batch_limit=batch_limit,
        )
    features, coords, attrs = _read_trident_features(feat_path)
    write_features_h5(sink["features"], features, coords, attrs)
    _copy_contours(job_dir, slide_path, sink["contours"])
    on_stage("features", 1.0)
    return PipelineResult(
        n_patches=len(coords), dim=int(features.shape[1]), encoder=encoder_name,
        features_ref=str(sink["features"]), contours_ref=str(sink["contours"]),
        stage_log=list(STAGES),
    )


def _read_trident_features(feat_path: str):
    import h5py

    with h5py.File(feat_path, "r") as f:
        features = f["features"][:]
        coords = f["coords"][:]
        attrs = dict(f["coords"].attrs)
    return features, coords, attrs


def _copy_contours(job_dir: Path, slide_path: Path, dest: Path) -> None:
    import json

    src = job_dir / "contours_geojson" / (Path(slide_path).stem + ".geojson")
    if src.is_file():
        write_contours_geojson(dest, json.loads(src.read_text()))
