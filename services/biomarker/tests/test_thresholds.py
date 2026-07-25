"""Slide-level thresholds (D9) — deterministic sampling, flat-memory histograms, guard reuse."""

import numpy as np

from biomarker_service.markers import CHANNEL_INDEX, MARKER_CHANNELS
from biomarker_service.thresholds import (
    SAMPLE_CAP,
    MarkerHistograms,
    sample_tiles,
)

N_CH = len(CHANNEL_INDEX)


def test_sample_tiles_is_deterministic_for_a_seed():
    tiles = [(x, y) for y in range(20) for x in range(20)]
    a = sample_tiles(tiles, seed="art123")
    b = sample_tiles(tiles, seed="art123")
    assert a == b                       # thresholds must not wobble between runs of one artifact
    # ...and the seeding must survive a PROCESS restart, so it cannot use CPython's randomised
    # str hash. Pin one known draw so a regression to hash() fails here rather than in the field.
    pinned = sample_tiles([(x, 0) for x in range(100)], seed="pinned")
    assert pinned[:3] == [(19, 0), (20, 0), (22, 0)]
    assert sample_tiles(tiles, seed="other") != a or len(a) == len(tiles)


def test_sample_tiles_respects_cap_floor_and_membership():
    tiles = [(x, 0) for x in range(50_000)]     # 2% = 1000, well past the cap
    s = sample_tiles(tiles, seed="s")
    assert len(s) == SAMPLE_CAP
    assert set(s).issubset(set(tiles))  # never invents a non-tissue tile
    assert s == sorted(s)

    few = [(0, 0), (1, 0)]
    assert len(sample_tiles(few, seed="s")) == 2      # floor cannot exceed what exists
    assert sample_tiles([], seed="s") == []


def _mif_with(marker: str, values: np.ndarray) -> np.ndarray:
    mif = np.full((N_CH, values.shape[0], values.shape[1]), 0.05, dtype=np.float32)
    mif[CHANNEL_INDEX[marker]] = values
    return mif


def test_bimodal_marker_gets_a_threshold_between_the_modes():
    rng = np.random.default_rng(0)
    vals = np.where(rng.random((64, 64)) < 0.3, 0.85, 0.08).astype(np.float32)
    h = MarkerHistograms()
    h.add(_mif_with("CD8", vals))
    t = h.thresholds()["CD8"]
    assert t is not None and 0.08 < t < 0.85


def test_uniform_marker_yields_no_threshold_reusing_the_inc3a_guard():
    h = MarkerHistograms()
    h.add(_mif_with("CD8", np.full((64, 64), 0.7, dtype=np.float32)))
    # A flat population is not bimodal: calling every pixel positive would manufacture a
    # slide-wide false lineage. The Inc 3a degeneracy guard says None.
    assert h.thresholds()["CD8"] is None


def test_histograms_accumulate_across_tiles_with_flat_memory():
    h = MarkerHistograms()
    for i in range(50):
        vals = np.full((32, 32), 0.9 if i < 15 else 0.05, dtype=np.float32)
        h.add(_mif_with("CK", vals))
    assert h.n_tiles == 50
    # the accumulator keeps BINS counters per marker, never the pixels
    assert h._h["CK"].shape == (256,)
    assert h._h["CK"].sum() == 50 * 32 * 32
    t = h.thresholds()["CK"]
    assert t is not None and 0.05 < t < 0.9


def test_thresholds_cover_every_marker_channel():
    h = MarkerHistograms()
    h.add(np.full((N_CH, 8, 8), 0.5, dtype=np.float32))
    assert set(h.thresholds()) == set(MARKER_CHANNELS)


def test_mask_restricts_accumulation_to_tissue():
    vals = np.zeros((8, 8), dtype=np.float32)
    vals[:2] = 0.9                       # only the top two rows carry signal
    mask = np.zeros((8, 8), dtype=bool)
    mask[:2] = True
    h = MarkerHistograms()
    h.add(_mif_with("CK", vals), mask=mask)
    assert h._h["CK"].sum() == 16        # 2 rows x 8 cols, background never counted
