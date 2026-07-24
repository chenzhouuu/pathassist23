from biomarker_service.align import in_bounds, region_pixels, to_region_pixel


def test_to_region_pixel_native_scale():
    # native read (scale 1): a level-0 centroid maps to (centroid - origin)
    assert to_region_pixel(150.0, 260.0, 100.0, 200.0, 1.0) == (50.0, 60.0)


def test_to_region_pixel_rescaled():
    # CellViT read the region at scale 2 (level0 = local*2 + origin) → local = (level0-origin)/2
    assert to_region_pixel(140.0, 300.0, 100.0, 200.0, 2.0) == (20.0, 50.0)


def test_in_bounds():
    assert in_bounds(0.0, 0.0, 64, 48)
    assert not in_bounds(64.0, 0.0, 64, 48)   # right edge is exclusive
    assert not in_bounds(-1.0, 0.0, 64, 48)


def test_region_pixels_drops_out_of_bounds_keeps_index():
    centroids = [[100.0, 200.0], [163.0, 247.0], [1000.0, 200.0]]  # third is far right → dropped
    kept = region_pixels(centroids, 100.0, 200.0, 1.0, 64, 48)
    assert [i for i, _, _ in kept] == [0, 1]           # index preserved, OOB cell dropped
    assert kept[0][1:] == (0.0, 0.0)
    assert kept[1][1:] == (63.0, 47.0)
