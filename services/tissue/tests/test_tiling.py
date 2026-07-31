from tissue_service.artifacts import CORE, HALO
from tissue_service.tiling import clip_bbox_to_slide, core_tiles, haloed_read_window


def test_core_tiles_are_absolute_so_two_regions_share_coverage():
    a = core_tiles({"x": 100, "y": 100, "width": 10, "height": 10})
    b = core_tiles({"x": CORE + 5, "y": 100, "width": 10, "height": 10})
    assert a == [(0, 0)]
    assert b == [(1, 0)]          # indices are on the slide grid, not relative to the bbox


def test_core_tiles_cover_a_straddling_box():
    tiles = core_tiles({"x": CORE - 5, "y": CORE - 5, "width": 10, "height": 10})
    assert set(tiles) == {(0, 0), (1, 0), (0, 1), (1, 1)}


def test_core_tiles_of_an_empty_box_is_empty():
    assert core_tiles({"x": 0, "y": 0, "width": 0, "height": 10}) == []


def test_halo_supplies_context_and_is_clamped_at_the_slide_edge():
    w = haloed_read_window(1, 1, 10_000, 10_000)
    assert (w.x, w.y) == (CORE - HALO, CORE - HALO)
    assert w.width == CORE + 2 * HALO
    assert (w.core_dx, w.core_dy) == (HALO, HALO)

    # top-left tile has no room for a halo on two sides — the core offset must follow
    tl = haloed_read_window(0, 0, 10_000, 10_000)
    assert (tl.x, tl.y) == (0, 0)
    assert (tl.core_dx, tl.core_dy) == (0, 0)
    assert tl.width == CORE + HALO


def test_partial_edge_core_is_truncated_not_padded():
    w = haloed_read_window(1, 0, CORE + 100, 5000)
    assert w.core_w == 100
    assert w.x + w.width <= CORE + 100


def test_core_entirely_off_slide_is_none():
    assert haloed_read_window(5, 0, 1000, 1000) is None


def test_clip_bbox():
    assert clip_bbox_to_slide({"x": -10, "y": -10, "width": 50, "height": 50}, 100, 100) == {
        "x": 0, "y": 0, "width": 40, "height": 40}
    assert clip_bbox_to_slide({"x": 200, "y": 0, "width": 10, "height": 10}, 100, 100) is None
