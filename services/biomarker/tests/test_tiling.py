"""Core+halo tiling — the geometry review finding B1 hinges on, so it is tested hardest."""

import numpy as np

from biomarker_service.artifacts import CORE, HALO
from biomarker_service.tiling import (
    clip_bbox_to_slide,
    core_tiles,
    haloed_read_window,
    owns,
)


def test_core_tiles_cover_bbox_with_absolute_grid_indices():
    # a bbox straddling a core boundary needs both tiles; indices are absolute on the slide grid
    tiles = core_tiles({"x": CORE - 10, "y": 0, "width": 20, "height": 10})
    assert tiles == [(0, 0), (1, 0)]
    # a bbox wholly inside one core needs exactly one
    assert core_tiles({"x": 100, "y": 100, "width": 50, "height": 50}) == [(0, 0)]
    # degenerate bboxes are empty, not an exception
    assert core_tiles({"x": 0, "y": 0, "width": 0, "height": 10}) == []


def test_core_tiles_are_a_gapless_row_major_cover():
    bbox = {"x": 3000, "y": 5000, "width": 9000, "height": 5000}
    tiles = core_tiles(bbox)
    xs = {t[0] for t in tiles}
    ys = {t[1] for t in tiles}
    assert xs == set(range(3000 // CORE, (3000 + 9000 - 1) // CORE + 1))
    assert ys == set(range(5000 // CORE, (5000 + 5000 - 1) // CORE + 1))
    assert len(tiles) == len(xs) * len(ys)          # gapless product, no duplicates
    assert tiles == sorted(tiles, key=lambda t: (t[1], t[0]))   # row-major


def test_read_window_adds_halo_and_clamps_at_slide_edges():
    slide_w, slide_h = 3 * CORE, 2 * CORE
    # interior tile: full halo on every side
    w = haloed_read_window(1, 0, slide_w, slide_h)
    assert (w.x, w.y) == (CORE - HALO, 0)           # top edge clamps, left does not
    assert w.core_dx == HALO and w.core_dy == 0
    assert w.width == CORE + 2 * HALO

    # top-left tile: clamped on two sides, so the core sits at the window origin
    w0 = haloed_read_window(0, 0, slide_w, slide_h)
    assert (w0.x, w0.y) == (0, 0)
    assert w0.core_dx == 0 and w0.core_dy == 0

    # a core entirely off the slide is not work
    assert haloed_read_window(9, 9, slide_w, slide_h) is None


def test_read_window_core_is_truncated_for_a_ragged_slide():
    slide_w, slide_h = CORE + 100, CORE + 50
    w = haloed_read_window(1, 1, slide_w, slide_h)
    assert (w.core_w, w.core_h) == (100, 50)
    assert w.x + w.width == slide_w and w.y + w.height == slide_h


def test_ownership_is_an_exact_partition_of_the_plane():
    # B1's core claim: every nucleus is claimed by exactly one tile — no dedup pass, no threshold.
    slide_w, slide_h = 3 * CORE, 3 * CORE
    wins = [haloed_read_window(tx, ty, slide_w, slide_h)
            for ty in range(3) for tx in range(3)]
    rng = np.random.default_rng(0)
    pts = rng.uniform(0, 3 * CORE, size=(2000, 2))
    # include the exact boundaries, which is where a half-open bug would show
    edges = np.array([[CORE, CORE], [0.0, 0.0], [2 * CORE, CORE], [CORE - 1e-9, CORE]])
    for cx, cy in np.vstack([pts, edges]):
        claims = [w for w in wins if owns(cx, cy, w)]
        assert len(claims) == 1, f"({cx},{cy}) claimed by {len(claims)} tiles"


def test_clip_bbox_to_slide():
    assert clip_bbox_to_slide({"x": -50, "y": -50, "width": 100, "height": 100}, 1000, 1000) == \
        {"x": 0, "y": 0, "width": 50, "height": 50}
    assert clip_bbox_to_slide({"x": 2000, "y": 0, "width": 10, "height": 10}, 1000, 1000) is None
