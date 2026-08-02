import numpy as np
import pytest
from support import segmented

from cellvit_service import infer
from cellvit_service.artifacts import TOKEN_DIM
from cellvit_service.config import get_settings
from cellvit_service.infer import (
    _clip_to_region,
    _load_cells,
    _min_native_side,
    _pad_to_min,
    segment_array,
    warm_up,
)


@pytest.fixture(autouse=True)
def _isolate_settings_cache():
    """CELLVIT_MODEL is read through an lru_cache; clear it around each test."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_stub_segment_array_returns_aligned_points_classes_and_contours():
    # 128x128 at stride 32 → 4x4 = 16 grid points, each with a deterministic PanNuke class.
    seg = segment_array(np.zeros((128, 128, 3), dtype=np.uint8), mpp=None)
    points, classes, contours = seg.points, seg.classes, seg.contours
    assert len(points) == 16
    assert points[0] == [0.0, 0.0]
    assert len(classes) == len(points)     # three parallel, index-aligned arrays
    assert len(contours) == len(points)
    assert all(1 <= c <= 5 for c in classes)
    assert all(len(p) == 2 for p in points)   # xy stays 2-D
    # Each contour is a closed-ish ring of [x, y] vertices around its own centroid (Inc 3b).
    assert all(len(ring) >= 3 and all(len(v) == 2 for v in ring) for ring in contours)
    cx, cy = points[5]
    ring = contours[5]
    assert min(v[0] for v in ring) < cx < max(v[0] for v in ring)
    assert min(v[1] for v in ring) < cy < max(v[1] for v in ring)
    # Inc 7: the stub has no encoder, so its tokens are zeros — the right shape and not a claim.
    assert seg.tokens.shape == (16, TOKEN_DIM)
    assert seg.tokens.dtype == np.float16
    assert not seg.tokens.any()
    assert len(seg.probs) == 16


def test_clip_to_region_drops_point_class_contour_and_token_together():
    pts = [[1.0, 1.0], [50.0, 1.0], [2.0, 2.0]]
    cnt = [[[0.0, 0.0]], [[49.0, 0.0]], [[1.0, 1.0]]]
    tokens = np.zeros((3, TOKEN_DIM), dtype=np.float16)
    tokens[:, 0] = [10.0, 20.0, 30.0]          # a marker per nucleus, to catch a shifted filter
    kept = _clip_to_region(
        segmented(pts, [1, 2, 3], cnt, tokens=tokens, probs=[0.1, 0.2, 0.3]), 10, 10,
    )
    # the out-of-region point takes its class, its contour AND its embedding with it. A partial
    # filter here would label every survivor from its neighbour's token.
    assert kept.points == [[1.0, 1.0], [2.0, 2.0]]
    assert kept.classes == [1, 3]
    assert kept.contours == [[[0.0, 0.0]], [[1.0, 1.0]]]
    assert kept.tokens[:, 0].tolist() == [10.0, 30.0]
    assert kept.probs == [0.1, 0.3]


def test_warm_up_is_noop_for_stub(monkeypatch):
    monkeypatch.setenv("CELLVIT_MODEL", "stub")
    get_settings.cache_clear()
    # stub needs no GPU model — warm-up must not attempt a load, and must report it skipped.
    assert warm_up() is False


def test_warm_up_loads_model_for_cellvit(monkeypatch):
    monkeypatch.setenv("CELLVIT_MODEL", "cellvit")
    get_settings.cache_clear()
    calls = []
    monkeypatch.setattr(infer, "_get_cellvit_model", lambda: calls.append(1))
    assert warm_up() is True
    assert calls == [1]  # delegated to the singleton builder exactly once


# ── Sub-patch padding (fixes the process_wsi single-patch coordinate offset) ──────────


def test_min_native_side_scales_inversely_with_mpp():
    # A region is resampled native_mpp -> target(0.25), so a coarser slide needs fewer native
    # px to clear one inference patch. native = (patch + margin) * target / mpp.
    at_050 = _min_native_side(0.50)
    at_025 = _min_native_side(0.25)
    assert at_025 > at_050  # 0.25 mpp is read 1:1, so it needs the full patch in native px
    assert at_050 == 576  # (1024 + 128) * 0.25 / 0.50


def test_pad_to_min_grows_a_sub_patch_region_keeping_content_at_origin():
    region = np.full((192, 247, 3), 7, dtype=np.uint8)  # (H, W, 3)
    padded = _pad_to_min(region, 576)
    assert padded.shape == (576, 576, 3)
    # the real region stays at the top-left origin, byte-for-byte, so centroids need no un-offset
    assert np.array_equal(padded[:192, :247], region)


def test_pad_to_min_is_a_noop_when_region_already_clears_the_patch():
    region = np.zeros((800, 900, 3), dtype=np.uint8)
    padded = _pad_to_min(region, 576)
    assert padded is region  # large regions tile correctly on their own — no padding, no copy


def test_load_cells_returns_empty_when_cellvit_wrote_no_file(tmp_path):
    # A zero-nuclei region makes CellViT skip cells.json — that must read back as an empty
    # result, not a FileNotFoundError (which used to surface as a 500 on sparse tissue).
    assert _load_cells(tmp_path / "cells.json") == []


def test_load_cells_reads_the_cells_array(tmp_path):
    import json as _json
    p = tmp_path / "cells.json"
    p.write_text(_json.dumps({"cells": [{"centroid": [1, 2], "type": 3}]}))
    assert _load_cells(p) == [{"centroid": [1, 2], "type": 3}]


def test_clip_to_region_drops_pad_hits_in_lockstep():
    pts = [[5.0, 5.0], [246.9, 191.9], [300.0, 10.0], [10.0, 500.0], [-1.0, 5.0]]
    classes = [1, 2, 3, 4, 5]
    rings = [[list(p)] for p in pts]
    kept = _clip_to_region(segmented(pts, classes, rings), 247, 192)
    assert kept.points == [[5.0, 5.0], [246.9, 191.9]]  # only the two inside [0,247) x [0,192)
    assert kept.classes == [1, 2]  # their classes rode along
