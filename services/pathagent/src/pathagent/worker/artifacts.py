import logging
import shutil
from pathlib import Path

import h5py

from ..common.cache_keys import PIPELINE_VERSION, CachePaths
from ..common.schemas import FeatureSpec, Manifest

logger = logging.getLogger(__name__)


def _trident_subdir(job_dir: Path, spec: FeatureSpec, overlap: int) -> Path:
    return job_dir / f"{spec.mag}x_{spec.patch_size}px_{overlap}px_overlap"


def normalize_and_manifest(job_dir: Path, slide_stem: str, item_id: str, cache_key: str,
                           spec: FeatureSpec, overlap: int, paths: CachePaths) -> Manifest:
    """Locate Trident outputs, copy into flat CachePaths, read attrs, write + return manifest."""
    sub = _trident_subdir(job_dir, spec, overlap)
    feat_src = sub / f"features_{spec.patch_encoder}" / f"{slide_stem}.h5"
    coords_src = sub / "patches" / f"{slide_stem}_patches.h5"
    if not feat_src.is_file():
        raise FileNotFoundError(f"trident features missing: {feat_src}")

    paths.root.mkdir(parents=True, exist_ok=True)
    with h5py.File(feat_src, "r") as f:
        feats = f["features"]
        patch_count, feature_dim = int(feats.shape[0]), int(feats.shape[1])
        a = dict(f["coords"].attrs)

    shutil.copy2(feat_src, paths.features(spec.patch_encoder))
    artifacts = {"features": paths.features(spec.patch_encoder).name}
    if coords_src.is_file():
        shutil.copy2(coords_src, paths.coords)
        artifacts["coords"] = paths.coords.name
    thumb_src = job_dir / "thumbnails" / f"{slide_stem}.jpg"
    if thumb_src.is_file():
        shutil.copy2(thumb_src, paths.thumbnail)
        artifacts["thumbnail"] = paths.thumbnail.name
    geo_src = job_dir / "contours_geojson" / f"{slide_stem}.geojson"
    if geo_src.is_file():
        shutil.copy2(geo_src, paths.root / "tissue.geojson")
        artifacts["tissue"] = "tissue.geojson"

    manifest = Manifest(
        cache_key=cache_key, item_id=item_id, slide_name=slide_stem, backbone=spec,
        patch_count=patch_count, feature_dim=feature_dim,
        level0_width=int(a["level0_width"]), level0_height=int(a["level0_height"]),
        level0_magnification=float(a["level0_magnification"]),
        target_magnification=float(a["target_magnification"]),
        patch_size_level0=int(a["patch_size_level0"]), overlap=int(a["overlap"]),
        pipeline_version=PIPELINE_VERSION, artifacts=artifacts,
    )
    paths.manifest.write_text(manifest.model_dump_json(by_alias=True, indent=2))
    return manifest
