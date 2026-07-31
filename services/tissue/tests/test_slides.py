import numpy as np

from tissue_service.artifacts import CORE
from tissue_service.slides import find_local_slide, rasterise_tissue, tissue_core_tiles


def _poly(x0, y0, x1, y1, holes=()):
    ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
    return {"type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [ring, *[list(h) for h in holes]]}}


def _fc(*feats):
    return {"type": "FeatureCollection", "features": list(feats)}


def test_tissue_tiles_are_the_bbox_intersection():
    gj = _fc(_poly(10, 10, 100, 100), _poly(CORE * 2 + 5, 5, CORE * 2 + 50, 50))
    tiles = tissue_core_tiles(gj, CORE * 4, CORE * 2, CORE)
    assert (0, 0) in tiles
    assert (2, 0) in tiles
    assert (1, 0) not in tiles          # nothing there — a false positive only costs compute


def test_no_contours_means_no_tissue_tiles():
    # the caller decides what that means: a region job runs anyway, a whole-slide job refuses
    assert tissue_core_tiles(None, 1000, 1000, CORE) == []
    assert tissue_core_tiles(_fc(), 1000, 1000, CORE) == []


def test_rasterise_masks_outside_the_polygon():
    gj = _fc(_poly(0, 0, 40, 40))
    mask = rasterise_tissue(gj, x=0, y=0, width=80, height=80, scale=4.0)
    assert mask.shape == (20, 20)
    assert mask[2, 2]
    assert not mask[15, 15]


def test_rasterise_honours_holes():
    gj = _fc(_poly(0, 0, 80, 80, holes=[[[20, 20], [60, 20], [60, 60], [20, 60], [20, 20]]]))
    mask = rasterise_tissue(gj, x=0, y=0, width=80, height=80, scale=1.0)
    assert mask[5, 5]
    assert not mask[40, 40]             # a lumen is not tissue


def test_rasterise_is_offset_by_the_window_origin():
    gj = _fc(_poly(100, 100, 140, 140))
    mask = rasterise_tissue(gj, x=100, y=100, width=40, height=40, scale=1.0)
    assert mask.mean() > 0.9


def test_no_contours_means_everything_is_tissue():
    # blanking the whole region would be a silent no-result; the caller already decided to run
    mask = rasterise_tissue(None, x=0, y=0, width=40, height=40, scale=4.0)
    assert mask.shape == (10, 10)
    assert mask.all()


def test_local_slide_lookup_refuses_to_guess(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    (tmp_path / "a" / "S1.svs").write_bytes(b"x")
    (tmp_path / "b" / "S1.svs").write_bytes(b"x")
    # two candidates ⇒ None: analysing the wrong slide silently is worse than reading over Girder
    assert find_local_slide(str(tmp_path), "S1.svs") is None
    assert find_local_slide(str(tmp_path / "a"), "S1.svs") is not None
    assert find_local_slide(None, "S1.svs") is None


def test_rasterise_scale_matches_the_reduced_array(tmp_path):
    gj = _fc(_poly(0, 0, 2048, 2048))
    mask = rasterise_tissue(gj, x=0, y=0, width=2048, height=2048, scale=4.0)
    assert mask.shape == (512, 512)
    assert np.count_nonzero(mask) > 512 * 512 * 0.9
