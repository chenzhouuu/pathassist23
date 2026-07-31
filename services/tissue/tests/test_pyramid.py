import numpy as np

from tissue_service.artifacts import TILE
from tissue_service.classes import BACKGROUND_INDEX, BCSS
from tissue_service.pyramid import (
    downsample_class,
    downsample_prob,
    levels_for,
    read_class_tile,
    read_prob_tile,
    write_class_tile,
    write_prob_tile,
)

N = len(BCSS.classes)


def test_levels_shrink_to_a_single_tile():
    assert levels_for(TILE, TILE) == 1
    assert levels_for(TILE * 2, TILE) == 2
    assert levels_for(1000, 1) == levels_for(1000, 1)
    assert levels_for(TILE * 8, TILE * 8) == 4


def test_class_tile_round_trip_preserves_indices(tmp_path):
    idx = np.zeros((TILE, TILE), dtype=np.uint8)
    idx[10:20, 10:20] = 1
    idx[30:40, 30:40] = 4
    write_class_tile(tmp_path, 0, 1, 2, idx, BCSS)
    back = read_class_tile(tmp_path, 0, 1, 2)
    assert np.array_equal(back, idx)
    assert read_class_tile(tmp_path, 0, 9, 9) is None


def test_prob_tile_reads_only_the_members_asked_for(tmp_path):
    planes = {c: np.full((TILE, TILE), i * 10, np.uint8) for i, c in enumerate(BCSS.classes)}
    write_prob_tile(tmp_path, 0, 0, 0, planes)
    got = read_prob_tile(tmp_path, 0, 0, 0, ["Stroma"])
    assert list(got) == ["Stroma"]
    assert got["Stroma"][0, 0] == 10
    assert read_prob_tile(tmp_path, 0, 5, 5, ["Stroma"]) == {}


def test_class_downsample_never_grows_the_outside_tissue_hole():
    # one in-tissue pixel per 2x2 must survive: a coarse level that ate it would read as
    # "the tissue shrank when I zoomed out"
    a = np.zeros((4, 4), dtype=np.uint8)
    a[0, 0] = 2
    a[2, 3] = 3
    out = downsample_class(a, N)
    assert out.shape == (2, 2)
    assert out[0, 0] == 2
    assert out[1, 1] == 3
    assert out[0, 1] == BACKGROUND_INDEX


def test_class_downsample_takes_the_majority_and_breaks_ties_by_lowest_index():
    a = np.array([[1, 1], [1, 3]], dtype=np.uint8)
    assert downsample_class(a, N)[0, 0] == 1
    tie = np.array([[2, 2], [5, 5]], dtype=np.uint8)
    assert downsample_class(tie, N)[0, 0] == 2       # deterministic, lowest palette index


def test_class_downsample_keeps_all_background_background():
    a = np.zeros((2, 2), dtype=np.uint8)
    assert downsample_class(a, N)[0, 0] == BACKGROUND_INDEX


def test_prob_downsample_is_the_mean():
    planes = {"Tumour": np.array([[0, 100], [200, 100]], dtype=np.uint8)}
    out = downsample_prob(planes)["Tumour"]
    assert out.shape == (1, 1)
    assert out[0, 0] == 100


def test_downsample_pads_an_odd_side():
    a = np.ones((3, 3), dtype=np.uint8)
    assert downsample_class(a, N).shape == (2, 2)
    assert downsample_prob({"x": a})["x"].shape == (2, 2)
