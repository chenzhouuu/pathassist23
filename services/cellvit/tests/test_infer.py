import numpy as np
import pytest

from cellvit_service import infer
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


def test_stub_segment_array_returns_aligned_points_and_classes():
    # 128x128 at stride 32 → 4x4 = 16 grid points, each with a deterministic PanNuke class.
    points, classes = segment_array(np.zeros((128, 128, 3), dtype=np.uint8), mpp=None)
    assert len(points) == 16
    assert points[0] == [0.0, 0.0]
    assert len(classes) == len(points)     # two parallel, index-aligned arrays
    assert all(1 <= c <= 5 for c in classes)
    assert all(len(p) == 2 for p in points)   # xy stays 2-D


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
    kept_pts, kept_cls = _clip_to_region(pts, classes, 247, 192)
    assert kept_pts == [[5.0, 5.0], [246.9, 191.9]]  # only the two inside [0,247) x [0,192)
    assert kept_cls == [1, 2]  # their classes rode along
