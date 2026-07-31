import json

import numpy as np
import pytest

from preprocess_service.artifacts import (
    feat_hash,
    feat_paths,
    patch_hash,
    patch_paths,
    read_coords_h5,
    read_features_h5,
    seg_hash,
    seg_paths,
    write_coords_h5,
)
from preprocess_service.stages import run_features, run_patching, run_segmentation

# ── DAG hashing ─────────────────────────────────────────────────────────────────────


def _seg_h():
    return seg_hash("hest", 0.5, False, False, False, "v1")


def test_seg_hash_deterministic_and_16_chars():
    assert _seg_h() == _seg_h() and len(_seg_h()) == 16


def test_seg_hash_varies_with_every_seg_param():
    base = _seg_h()
    assert base != seg_hash("otsu", 0.5, False, False, False, "v1")   # segmenter
    assert base != seg_hash("hest", 0.4, False, False, False, "v1")   # conf
    assert base != seg_hash("hest", 0.5, True, False, False, "v1")    # remove_artifacts
    assert base != seg_hash("hest", 0.5, False, True, False, "v1")    # remove_holes
    assert base != seg_hash("hest", 0.5, False, False, True, "v1")    # remove_penmarks
    assert base != seg_hash("hest", 0.5, False, False, False, "v2")   # version


def test_patch_hash_composes_over_parent_and_tile_params():
    sh = _seg_h()
    base = patch_hash(sh, 20, 256, 0, "v1")
    assert base == patch_hash(sh, 20, 256, 0, "v1")
    assert base != patch_hash("otherseg", 20, 256, 0, "v1")  # parent seg
    assert base != patch_hash(sh, 40, 256, 0, "v1")          # mag
    assert base != patch_hash(sh, 20, 512, 0, "v1")          # patch_size
    assert base != patch_hash(sh, 20, 256, 128, "v1")        # overlap


def test_feat_hash_composes_over_parent_and_encoder():
    ph = patch_hash(_seg_h(), 20, 256, 0, "v1")
    base = feat_hash(ph, "conch_v1", "v1")
    assert base != feat_hash(ph, "uni_v2", "v1")          # encoder
    assert base != feat_hash("otherpatch", "conch_v1", "v1")  # parent patch


def test_reuse_one_patch_grid_feeds_many_encoders():
    # Same tissue + same tiling → same patch_hash → two encoders differ only at the feat layer.
    ph = patch_hash(_seg_h(), 20, 256, 0, "v1")
    assert feat_hash(ph, "conch_v1", "v1") != feat_hash(ph, "uni_v2", "v1")


def test_dag_cache_paths_layout(tmp_path):
    base = tmp_path / "it"
    assert seg_paths(tmp_path, "it", "abc")["contours"] == base / "seg" / "abc" / "contours.geojson"
    assert patch_paths(tmp_path, "it", "abc")["coords"] == base / "patch" / "abc" / "coords.h5"
    assert feat_paths(tmp_path, "it", "abc")["features"] == base / "feat" / "abc" / "features.h5"


def test_dag_cache_paths_reject_injection(tmp_path):
    with pytest.raises(ValueError):
        seg_paths(tmp_path, "../escape", "h")


# ── coords h5 round-trip ────────────────────────────────────────────────────────────


def test_coords_h5_round_trip(tmp_path):
    coords = np.array([[0, 0], [512, 0], [0, 512]], dtype=np.int64)
    attrs = {"patch_size_level0": 512, "target_magnification": 20, "overlap": 0}
    out = tmp_path / "coords.h5"
    write_coords_h5(out, coords, attrs)
    rc, ra = read_coords_h5(out)
    assert np.array_equal(rc, coords)
    assert ra["patch_size_level0"] == 512 and ra["overlap"] == 0


# ── stub DAG chain ──────────────────────────────────────────────────────────────────


def _run_chain(tmp_path, item="it", encoder="conch_v1", mag=20, patch_size=256):
    seg_sink = seg_paths(tmp_path, item, "sh")
    patch_sink = patch_paths(tmp_path, item, "ph")
    feat_sink = feat_paths(tmp_path, item, f"fh_{encoder}")
    stages = []

    def on_stage(name, prog):
        stages.append(name)

    slide = tmp_path / "fake.svs"
    seg = run_segmentation(slide, {"segmenter": "hest"}, seg_sink, on_stage=on_stage)
    patch = run_patching(
        slide, {"mag": mag, "patch_size": patch_size, "overlap": 0},
        seg_sink, patch_sink, on_stage=on_stage,
    )
    feat = run_features(
        slide, {"encoder": encoder}, patch_sink, feat_sink, on_stage=on_stage,
    )
    return seg, patch, feat, seg_sink, patch_sink, feat_sink, stages


def test_stub_segmentation_writes_tissue_geojson(tmp_path):
    seg, *_rest, seg_sink, _, _, _ = _run_chain(tmp_path)
    gj = json.loads(seg_sink["contours"].read_text())
    assert gj["type"] == "FeatureCollection"
    assert gj["features"][0]["geometry"]["type"] == "Polygon"
    assert seg.n_contours == 1


def test_stub_patching_tiles_the_segmented_tissue(tmp_path):
    _seg, patch, _feat, _s, patch_sink, _f, _st = _run_chain(tmp_path)
    coords, attrs = read_coords_h5(patch_sink["coords"])
    # 4096-px tissue square, ps0 = 256 * (40//20) = 512 → an 8×8 grid.
    assert patch.n_patches == 64 and coords.shape == (64, 2)
    assert attrs["patch_size_level0"] == 512 and attrs["target_magnification"] == 20


def test_stub_features_are_index_aligned_unit_norm_deterministic(tmp_path):
    _seg, patch, feat, _s, _p, feat_sink, stages = _run_chain(tmp_path)
    feats, coords, attrs = read_features_h5(feat_sink["features"])
    assert feats.shape == (patch.n_patches, 16) and coords.shape == (patch.n_patches, 2)
    assert feat.dim == 16 and feat.encoder == "conch_v1" and attrs["encoder"] == "conch_v1"
    assert np.allclose(np.linalg.norm(feats, axis=1), 1.0, atol=1e-5)  # cosine-ready
    assert stages == ["segmentation", "patching", "features"]  # reported in order


def test_stub_patch_count_scales_with_magnification(tmp_path):
    _s, p20, *_ = _run_chain(tmp_path, mag=20)      # ps0 512 → 8×8
    _s2, p40, *_ = _run_chain(tmp_path, item="it2", mag=40)  # ps0 256 → 16×16
    assert p20.n_patches == 64 and p40.n_patches == 256


def test_stub_reuse_same_patch_grid_two_encoders_share_coords(tmp_path):
    # One segmentation + one patching, two feature encoders → identical coords, different feats key.
    _s, _p, f_a, _sk, patch_sink, feat_a, _st = _run_chain(tmp_path, encoder="conch_v1")
    feat_b = feat_paths(tmp_path, "it", "fh_uni_v2")
    run_features(tmp_path / "fake.svs", {"encoder": "uni_v2"}, patch_sink, feat_b)
    _fa, ca, _aa = read_features_h5(feat_a["features"])
    _fb, cb, _ab = read_features_h5(feat_b["features"])
    assert np.array_equal(ca, cb)  # same patch grid reused across encoders
