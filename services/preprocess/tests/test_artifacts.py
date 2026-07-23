import numpy as np
import pytest

from preprocess_service.artifacts import (
    cache_paths,
    params_hash,
    read_features_h5,
    write_features_h5,
)


def test_params_hash_is_deterministic_and_order_stable():
    a = params_hash("conch_v1", 20, 256, "hest", "v1")
    b = params_hash("conch_v1", 20, 256, "hest", "v1")
    assert a == b and len(a) == 16


def test_params_hash_varies_with_every_param():
    base = params_hash("conch_v1", 20, 256, "hest", "v1")
    assert base != params_hash("conch_v15", 20, 256, "hest", "v1")  # encoder
    assert base != params_hash("conch_v1", 40, 256, "hest", "v1")   # mag
    assert base != params_hash("conch_v1", 20, 512, "hest", "v1")   # patch_size
    assert base != params_hash("conch_v1", 20, 256, "otsu", "v1")   # segmenter
    assert base != params_hash("conch_v1", 20, 256, "hest", "v2")   # version


def test_cache_paths_layout(tmp_path):
    p = cache_paths(tmp_path, "item9", "deadbeef")
    assert p["features"] == tmp_path / "item9" / "deadbeef" / "features.h5"
    assert p["coords"].name == "coords.h5" and p["contours"].suffix == ".geojson"


def test_cache_paths_reject_injection(tmp_path):
    with pytest.raises(ValueError):
        cache_paths(tmp_path, "../escape", "hash")


def test_features_h5_round_trip(tmp_path):
    feats = np.random.rand(5, 8).astype(np.float32)
    coords = np.array([[0, 0], [256, 0], [0, 256], [256, 256], [512, 0]], dtype=np.int64)
    attrs = {"patch_size_level0": 256, "target_magnification": 20}
    out = tmp_path / "features.h5"
    write_features_h5(out, feats, coords, attrs)
    rf, rc, ra = read_features_h5(out)
    assert rf.shape == (5, 8) and rf.dtype == np.float32
    assert rc.shape == (5, 2) and np.array_equal(rc, coords)
    assert ra["patch_size_level0"] == 256 and ra["target_magnification"] == 20
