import h5py
import numpy as np
import pytest

STEM = "BRACS_1648"
ENCODER = "conch_v1"
MAG = 20
PATCH = 256
OVERLAP = 0

ATTRS = {
    "level0_width": 83664,
    "level0_height": 64892,
    "level0_magnification": 40,
    "target_magnification": 20,
    "patch_size": 256,
    "patch_size_level0": 512,
    "overlap": 0,
    "name": STEM,
}


def _write_h5_with_coords(path, *, features=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    with h5py.File(path, "w") as f:
        if features:
            f.create_dataset("features", data=np.random.rand(7, 512).astype("float32"))
        coords = f.create_dataset("coords", data=np.zeros((7, 2), dtype="int64"))
        for k, v in ATTRS.items():
            coords.attrs[k] = v


def build_trident_tree(job_dir, *, stem=STEM, encoder=ENCODER, mag=MAG,
                       patch=PATCH, overlap=OVERLAP):
    """Create a synthetic Trident output tree under job_dir for the given params."""
    sub = job_dir / f"{mag}x_{patch}px_{overlap}px_overlap"
    _write_h5_with_coords(sub / f"features_{encoder}" / f"{stem}.h5", features=True)
    _write_h5_with_coords(sub / "patches" / f"{stem}_patches.h5")
    thumb = job_dir / "thumbnails" / f"{stem}.jpg"
    thumb.parent.mkdir(parents=True, exist_ok=True)
    thumb.write_bytes(b"\xff\xd8jpegbytes")
    geo = job_dir / "contours_geojson" / f"{stem}.geojson"
    geo.parent.mkdir(parents=True, exist_ok=True)
    geo.write_bytes(b'{"type":"FeatureCollection"}')
    return job_dir


def test_normalize_and_manifest_happy_path(tmp_cache, tmp_path):
    from pathagent.common.cache_keys import PIPELINE_VERSION, cache_paths
    from pathagent.common.schemas import FeatureSpec
    from pathagent.worker.artifacts import normalize_and_manifest

    job_dir = build_trident_tree(tmp_path / "trident")
    paths = cache_paths("case-x")
    spec = FeatureSpec(patch_encoder=ENCODER)

    manifest = normalize_and_manifest(
        job_dir, STEM, "item-1", "case-x", spec, OVERLAP, paths
    )

    assert manifest.patch_count == 7
    assert manifest.feature_dim == 512
    assert manifest.level0_width == 83664
    assert manifest.target_magnification == 20.0
    assert manifest.patch_size_level0 == 512
    assert manifest.pipeline_version == PIPELINE_VERSION
    assert manifest.slide_name == STEM
    assert manifest.item_id == "item-1"

    assert paths.features(ENCODER).is_file()
    assert paths.coords.is_file()
    assert paths.thumbnail.is_file()
    assert (paths.root / "tissue.geojson").is_file()
    assert paths.manifest.is_file()

    assert set(manifest.artifacts) == {"features", "coords", "thumbnail", "tissue"}
    assert manifest.artifacts["features"] == paths.features(ENCODER).name
    assert manifest.artifacts["tissue"] == "tissue.geojson"


def test_normalize_and_manifest_missing_features_raises(tmp_cache, tmp_path):
    from pathagent.common.cache_keys import cache_paths
    from pathagent.common.schemas import FeatureSpec
    from pathagent.worker.artifacts import normalize_and_manifest

    job_dir = tmp_path / "trident"
    job_dir.mkdir()
    paths = cache_paths("case-x")
    spec = FeatureSpec(patch_encoder=ENCODER)

    with pytest.raises(FileNotFoundError):
        normalize_and_manifest(job_dir, STEM, "item-1", "case-x", spec, OVERLAP, paths)


def test_normalize_and_manifest_missing_features_dataset_raises(tmp_cache, tmp_path):
    """A features h5 that exists but has no `features` dataset must fail with a named error."""
    from pathagent.common.cache_keys import cache_paths
    from pathagent.common.schemas import FeatureSpec
    from pathagent.worker.artifacts import normalize_and_manifest

    job_dir = tmp_path / "trident"
    sub = job_dir / f"{MAG}x_{PATCH}px_{OVERLAP}px_overlap"
    feat_path = sub / f"features_{ENCODER}" / f"{STEM}.h5"
    _write_h5_with_coords(feat_path, features=False)  # no `features` dataset
    paths = cache_paths("case-x")
    spec = FeatureSpec(patch_encoder=ENCODER)

    with pytest.raises(KeyError) as exc:
        normalize_and_manifest(job_dir, STEM, "item-1", "case-x", spec, OVERLAP, paths)
    assert str(feat_path) in str(exc.value)


def test_normalize_and_manifest_missing_coords_attr_raises(tmp_cache, tmp_path):
    """A features h5 missing a required coords attr must fail with a clear, named error."""
    from pathagent.common.cache_keys import cache_paths
    from pathagent.common.schemas import FeatureSpec
    from pathagent.worker.artifacts import normalize_and_manifest

    job_dir = tmp_path / "trident"
    sub = job_dir / f"{MAG}x_{PATCH}px_{OVERLAP}px_overlap"
    feat_path = sub / f"features_{ENCODER}" / f"{STEM}.h5"
    feat_path.parent.mkdir(parents=True, exist_ok=True)
    with h5py.File(feat_path, "w") as f:
        f.create_dataset("features", data=np.random.rand(7, 512).astype("float32"))
        coords = f.create_dataset("coords", data=np.zeros((7, 2), dtype="int64"))
        for k, v in ATTRS.items():
            if k == "level0_width":  # omit a required attr
                continue
            coords.attrs[k] = v
    paths = cache_paths("case-x")
    spec = FeatureSpec(patch_encoder=ENCODER)

    with pytest.raises(KeyError) as exc:
        normalize_and_manifest(job_dir, STEM, "item-1", "case-x", spec, OVERLAP, paths)
    msg = str(exc.value)
    assert str(feat_path) in msg
    assert "level0_width" in msg
