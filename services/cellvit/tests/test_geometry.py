from cellvit_service.geometry import offset_points


def test_offset_adds_region_origin_at_native_scale():
    # native magnification: scale=1, just add the bbox origin
    pts = [[0.0, 0.0], [10.0, 20.0]]
    assert offset_points(pts, 100.0, 200.0) == [[100.0, 200.0], [110.0, 220.0]]


def test_offset_applies_scale_before_origin():
    # region requested at 2x upsample: local coords are 2x the level-0 region scale
    pts = [[10.0, 10.0]]
    assert offset_points(pts, 100.0, 100.0, scale=0.5) == [[105.0, 105.0]]


def test_offset_empty_is_empty():
    assert offset_points([], 5.0, 5.0) == []
