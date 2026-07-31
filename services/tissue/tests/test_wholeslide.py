"""The job end to end on a synthetic slide: masking, tiling, pyramid, coverage, statistics."""

import numpy as np
import pytest

from tissue_service.artifacts import CORE, TILE, Coverage, meta_path, read_json, summary_path
from tissue_service.classes import BACKGROUND_INDEX, Backend
from tissue_service.pyramid import read_class_tile, read_prob_tile
from tissue_service.wholeslide import SlideInfo, run_region, seam_gradient_ratio

# A small backend so a test core is 4 windows, not 25. Everything else is the production geometry.
TEST = Backend(
    name="test", classes=("A", "B", "C"), colors=("FF0000", "00FF00", "0000FF"),
    input_mpp=0.25, patch_in=256, patch_out=128,
    trained_on="synthetic", weights_license="n/a", weights_file="none.pth", description="test",
)
W = H = CORE * 2                     # 2x2 core tiles
SLIDE = SlideInfo(W, H, 0.25)


def reader(x, y, w, h):
    """Red ramps left→right across the slide, so class is a function of slide position…"""
    xs = np.clip(np.arange(x, x + w) * 255 // max(1, W - 1), 0, 255).astype(np.uint8)
    rgb = np.zeros((h, w, 3), np.uint8)
    rgb[..., 0] = xs[None, :]
    return rgb


def predict(rgb):
    """…but the predictor only ever sees pixels — exactly like the real network."""
    m = (TEST.patch_in - TEST.patch_out) // 2
    crop = rgb[m:m + TEST.patch_out, m:m + TEST.patch_out].astype(np.float32)
    red = crop[..., 0] / 255.0
    out = np.zeros((3, TEST.patch_out, TEST.patch_out), np.float32)
    for c in range(3):
        out[c] = np.clip(1.0 - np.abs(red - c / 2.0) * 2.0, 0, 1)
    return out / np.maximum(out.sum(0, keepdims=True), 1e-6)


def _poly(x0, y0, x1, y1):
    return {"type": "FeatureCollection", "features": [{
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [[
            [x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}}]}


ALL_TISSUE = _poly(0, 0, W, H)
TILES = [(0, 0), (1, 0), (0, 1), (1, 1)]


def _run(root, bbox=None, contours=ALL_TISSUE, tiles=TILES, store_mpp=1.0):
    return run_region(
        root=root, art="a1", backend=TEST, slide=SLIDE, bbox=bbox,
        tissue_tiles=tiles, contours=contours, read_window=reader, predict=predict,
        store_mpp=store_mpp,
    )


def test_whole_slide_writes_an_aligned_level0_grid(tmp_path):
    res = _run(tmp_path)
    # 0.25 µm/px slide stored at 1 µm/px ⇒ 4x, so a 2048 core is 512 stored px = 2x2 tiles
    assert sorted(p.name for p in (tmp_path / "classes" / "0").glob("*.png")) == sorted(
        f"{x}_{y}.png" for y in range(4) for x in range(4))
    assert res["n_core_tiles"] == 4
    meta = read_json(meta_path(tmp_path))
    assert meta["layers"]["classes"]["level_offset"] == 2
    assert meta["store_mpp"] == pytest.approx(1.0)
    assert meta["classes"] == ["A", "B", "C"]


def test_the_map_follows_the_pixels_across_the_whole_slide(tmp_path):
    _run(tmp_path)
    left = read_class_tile(tmp_path, 0, 0, 0)
    right = read_class_tile(tmp_path, 0, 3, 0)
    assert left is not None and right is not None
    assert left[TILE // 2, 0] == 1          # red ≈ 0   → A
    assert right[TILE // 2, -1] == 3        # red ≈ 255 → C


def test_outside_the_tissue_contour_is_index_zero_not_a_class(tmp_path):
    # BCSS has no background output: unmasked, it labels glass and every fraction is wrong
    _run(tmp_path, contours=_poly(0, 0, CORE, H))       # left half only
    right = read_class_tile(tmp_path, 0, 3, 0)
    assert (right == BACKGROUND_INDEX).all()
    left = read_class_tile(tmp_path, 0, 0, 0)
    assert (left != BACKGROUND_INDEX).any()


def test_probabilities_are_stored_per_class_and_are_zero_outside_tissue(tmp_path):
    _run(tmp_path, contours=_poly(0, 0, CORE, H))
    planes = read_prob_tile(tmp_path, 0, 0, 0, list(TEST.classes))
    assert set(planes) == set(TEST.classes)
    assert planes["A"].dtype == np.uint8
    outside = read_prob_tile(tmp_path, 0, 3, 0, ["A"])
    assert outside["A"].max() == 0


def test_pyramid_levels_are_built_and_keep_the_tissue(tmp_path):
    _run(tmp_path)
    meta = read_json(meta_path(tmp_path))
    n = meta["layers"]["classes"]["levels"]
    assert n >= 3                                    # 1024px stored raster over 256px tiles
    top = read_class_tile(tmp_path, n - 1, 0, 0)
    assert top is not None
    assert (top != BACKGROUND_INDEX).any()           # zooming out must not empty the map


def test_two_region_jobs_accumulate_into_one_artifact(tmp_path):
    first = _run(tmp_path, bbox={"x": 0, "y": 0, "width": CORE, "height": CORE})
    assert first["n_core_tiles"] == 1
    assert read_class_tile(tmp_path, 0, 2, 0) is None

    second = _run(tmp_path, bbox={"x": CORE, "y": 0, "width": CORE, "height": CORE})
    assert second["n_core_tiles"] == 2               # extended, not forked
    assert read_class_tile(tmp_path, 0, 2, 0) is not None
    assert Coverage.load(tmp_path).done == {(0, 0), (1, 0)}


def test_recomputing_a_covered_tile_does_not_double_count(tmp_path):
    a = _run(tmp_path, bbox={"x": 0, "y": 0, "width": CORE, "height": CORE})
    b = _run(tmp_path, bbox={"x": 0, "y": 0, "width": CORE, "height": CORE})
    assert a["covered_mm2"] == b["covered_mm2"]
    assert a["fraction"] == b["fraction"]


def test_summary_reports_hard_and_soft_fractions_and_tsr(tmp_path):
    res = _run(tmp_path)
    assert sum(res["fraction"].values()) == pytest.approx(1.0, abs=1e-3)
    assert sum(res["fraction_soft"].values()) == pytest.approx(1.0, abs=1e-3)
    # this backend has no Tumour/Stroma, so TSR must be absent rather than invented
    assert res["tsr"] is None
    doc = read_json(summary_path(tmp_path))
    assert doc["tissue_px"] > 0
    assert res["covered_mm2"] == pytest.approx(doc["covered_mm2"])


def test_area_is_computed_from_the_stored_resolution(tmp_path):
    res = _run(tmp_path)
    # 4096 x 4096 level-0 px at 0.25 µm/px = 1.024 mm on a side
    assert res["covered_mm2"] == pytest.approx(1.024 ** 2, rel=0.02)


def test_a_region_with_no_tissue_fails_loudly(tmp_path):
    with pytest.raises(RuntimeError, match="no tissue"):
        _run(tmp_path, bbox={"x": 0, "y": 0, "width": CORE, "height": CORE}, tiles=[(9, 9)])


def test_a_region_job_without_a_mask_analyses_what_was_asked_for(tmp_path):
    # the user framed that box; refusing because segmentation has not run is a worse answer
    res = _run(tmp_path, bbox={"x": 0, "y": 0, "width": CORE, "height": CORE},
               contours=None, tiles=[])
    assert res["n_core_tiles"] == 1


def test_seam_metric_is_flat_on_a_smooth_field_and_spikes_on_a_grid():
    smooth = np.tile(np.linspace(0, 1, 256, dtype=np.float32), (16, 1))
    assert seam_gradient_ratio(smooth, 32) == pytest.approx(1.0, abs=0.2)
    grid = smooth.copy()
    grid[:, 31::32] += 0.5
    assert seam_gradient_ratio(grid, 32) > 3.0
