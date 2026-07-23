import json

import numpy as np

from preprocess_service.artifacts import cache_paths, read_features_h5
from preprocess_service.pipeline import run_pipeline


def _params():
    return {"encoder": "conch_v1", "mag": 20, "patch_size": 256, "segmenter": "hest"}


def test_stub_pipeline_writes_index_aligned_features(tmp_path):
    sink = cache_paths(tmp_path, "item1", "hash1")
    stages = []
    res = run_pipeline(
        tmp_path / "fake.svs", _params(), sink,
        use_trident=False, on_stage=lambda s, p: stages.append((s, p)),
    )
    assert res.n_patches == 16 and res.encoder == "conch_v1" and res.dim == 16
    feats, coords, attrs = read_features_h5(sink["features"])
    assert feats.shape == (16, 16) and coords.shape == (16, 2)  # index-aligned
    # level-0 geometry attrs (F5 names); mag 20 on a native-40 stub → patch_size_level0 = 512
    assert attrs["patch_size_level0"] == 512 and attrs["target_magnification"] == 20
    # stages reported in order for the progress bar
    assert [s for s, _ in stages] == ["segmentation", "patching", "features"]


def test_stub_features_are_unit_norm_and_deterministic(tmp_path):
    sink = cache_paths(tmp_path, "i", "h")
    run_pipeline(tmp_path / "a.svs", _params(), sink, use_trident=False)
    feats, coords, _ = read_features_h5(sink["features"])
    norms = np.linalg.norm(feats, axis=1)
    assert np.allclose(norms, 1.0, atol=1e-5)  # normalized → cosine-ready
    # re-run into a fresh sink → identical (deterministic)
    sink2 = cache_paths(tmp_path, "i", "h2")
    run_pipeline(tmp_path / "a.svs", _params(), sink2, use_trident=False)
    feats2, _, _ = read_features_h5(sink2["features"])
    assert np.array_equal(feats, feats2)


def test_stub_writes_tissue_contour_geojson(tmp_path):
    sink = cache_paths(tmp_path, "i", "h")
    run_pipeline(tmp_path / "a.svs", _params(), sink, use_trident=False)
    gj = json.loads(sink["contours"].read_text())
    assert gj["type"] == "FeatureCollection"
    assert gj["features"][0]["geometry"]["type"] == "Polygon"
