"""Pyramid I/O: per-channel npz members (S2) and nucleus-preserving phenotype downsampling."""

import numpy as np

from biomarker_service.artifacts import marker_tile_path
from biomarker_service.markers import PHENOTYPE_ORDER
from biomarker_service.pyramid import (
    BACKGROUND_INDEX,
    downsample_marker,
    downsample_pheno,
    levels_for,
    phenotype_index,
    read_marker_tile,
    read_pheno_tile,
    write_marker_tile,
    write_pheno_tile,
)


def test_marker_tile_round_trips_only_the_requested_channels(tmp_path):
    planes = {
        "CK": np.full((256, 256), 200, dtype=np.uint8),
        "CD8": np.full((256, 256), 100, dtype=np.uint8),
        "CD68": np.zeros((256, 256), dtype=np.uint8),
    }
    write_marker_tile(tmp_path, 0, 0, 0, planes)

    # S2: channels are separately-named npz members, so a 1-channel read inflates 1 member.
    with np.load(marker_tile_path(tmp_path, 0, 0, 0)) as z:
        assert set(z.files) == {"CK", "CD8", "CD68"}

    got = read_marker_tile(tmp_path, 0, 0, 0, ["CD8"])
    assert set(got) == {"CD8"}
    assert got["CD8"][0, 0] == 100

    # a channel that was never written is simply absent, not an exception
    assert read_marker_tile(tmp_path, 0, 0, 0, ["CD8", "PD-L1"]).keys() == {"CD8"}


def test_missing_marker_tile_reads_as_empty(tmp_path):
    assert read_marker_tile(tmp_path, 0, 9, 9, ["CK"]) == {}


def test_downsample_marker_is_a_2x2_mean(tmp_path):
    a = np.array([[0, 100], [200, 255]], dtype=np.uint8)
    out = downsample_marker({"CK": a})["CK"]
    assert out.shape == (1, 1)
    assert out[0, 0] == (0 + 100 + 200 + 255) // 4


def test_pheno_tile_round_trips_palette_indices(tmp_path):
    idx = np.zeros((64, 64), dtype=np.uint8)
    idx[10:20, 10:20] = phenotype_index("Tumour")
    idx[30:34, 30:34] = phenotype_index("Cytotoxic T")
    write_pheno_tile(tmp_path, 0, 0, 0, idx)
    back = read_pheno_tile(tmp_path, 0, 0, 0)
    assert np.array_equal(back, idx)
    assert read_pheno_tile(tmp_path, 0, 5, 5) is None


def test_phenotype_index_is_one_based_and_defaults_to_other():
    assert phenotype_index("Tumour") == 1
    assert phenotype_index(PHENOTYPE_ORDER[-1]) == len(PHENOTYPE_ORDER)
    assert phenotype_index("not a lineage") == phenotype_index("Other")


def test_a_single_nucleus_survives_four_levels_of_downsampling():
    # The design's stated risk: a mean (or a plain mode) downsample dissolves nuclei into
    # background within 2-3 levels, because a nucleus is ~10% of its neighbourhood's pixels.
    # "non-background first, then mode" must keep it visible all the way out.
    idx = np.zeros((256, 256), dtype=np.uint8)
    tum = phenotype_index("Tumour")
    idx[100:116, 100:116] = tum          # one 16x16 nucleus in an otherwise empty tile

    a = idx
    for _ in range(4):
        a = downsample_pheno(a)
    assert a.shape == (16, 16)
    assert (a == tum).sum() >= 1, "the nucleus was dissolved into background"
    assert a[a != BACKGROUND_INDEX].min() == tum


def test_downsample_pheno_prefers_foreground_and_breaks_ties_by_order():
    tum, other = phenotype_index("Tumour"), phenotype_index("Other")
    # 3 background + 1 foreground child ⇒ parent is foreground, not background
    q = np.array([[tum, 0], [0, 0]], dtype=np.uint8)
    assert downsample_pheno(q)[0, 0] == tum
    # a 2-2 tie resolves to the lower palette index, i.e. earlier in PHENOTYPE_ORDER
    q2 = np.array([[tum, other], [other, tum]], dtype=np.uint8)
    assert downsample_pheno(q2)[0, 0] == min(tum, other)
    # all-background stays background
    assert downsample_pheno(np.zeros((2, 2), dtype=np.uint8))[0, 0] == BACKGROUND_INDEX


def test_levels_for_tops_out_at_one_tile():
    assert levels_for(256, 256) == 1
    assert levels_for(512, 256) == 2
    assert levels_for(1024, 1024) == 3
    assert levels_for(100_000, 80_000) >= 10
