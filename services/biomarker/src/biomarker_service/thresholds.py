"""Slide-level positivity thresholds (Inc 3b, design §7, D9).

**This replaces Inc 3a's per-ROI adaptive threshold.** Per-ROI thresholds mean adjacent parts of
one slide use different positivity standards, which (a) puts a visible seam through any
incrementally-assembled map and (b) makes a whole-slide count meaningless. The adaptive *spirit*
is kept — the threshold still comes from this slide's own distribution, so staining and scanner
differences are absorbed — but it is estimated **once**, from a sample spread over the whole
tissue, and then applied everywhere.

The sample is cheap because it needs **GigaTIME only**: positivity is a property of the mIF, not
of the nuclei, so CellViT (the hours-long part) is not involved. A few hundred tiles is minutes.

Accumulation is histogram-based, so memory stays flat no matter how many tiles are sampled — the
pixels themselves are never retained.
"""

import hashlib
import logging

import numpy as np

from .markers import CHANNEL_INDEX, MARKER_CHANNELS
from .phenotype import _guarded_threshold

logger = logging.getLogger(__name__)

# Probability histogram resolution. 256 bins over [0,1] matches the uint8 storage precision, so
# binning loses nothing that the pyramid would have kept anyway.
BINS = 256

# Sampling policy: enough tiles to characterise the slide, capped so the pre-pass stays minutes.
SAMPLE_FRACTION = 0.02
SAMPLE_MIN = 8
SAMPLE_CAP = 256


def sample_tiles(
    tiles: list[tuple[int, int]], seed: str,
    fraction: float = SAMPLE_FRACTION, cap: int = SAMPLE_CAP, minimum: int = SAMPLE_MIN,
) -> list[tuple[int, int]]:
    """A deterministic spread-out subsample of the tissue tiles.

    Seeded by the artifact hash so re-running a job re-samples identically — thresholds must not
    wobble between runs of the same artifact, or the map would change under the user for no
    reason. The seed goes through sha1, **not** ``hash()``: CPython randomises string hashing per
    process, so ``hash()`` would re-sample differently after every worker restart — the exact
    non-reproducibility this seeding exists to prevent.
    """
    if not tiles:
        return []
    n = min(len(tiles), max(minimum, int(round(len(tiles) * fraction))))
    n = min(n, cap)
    digest = hashlib.sha1(seed.encode()).digest()[:4]
    rng = np.random.default_rng(int.from_bytes(digest, "big"))
    idx = rng.choice(len(tiles), size=n, replace=False)
    return [tiles[int(i)] for i in sorted(idx)]


class MarkerHistograms:
    """Flat-memory accumulator: one [BINS] count vector per marker, fed tile by tile."""

    def __init__(self) -> None:
        self._h = {m: np.zeros(BINS, dtype=np.int64) for m in MARKER_CHANNELS}
        self._n = 0

    def add(self, mif: np.ndarray, mask: np.ndarray | None = None) -> None:
        """Accumulate one ``[C, H, W]`` probability tile, optionally restricted to ``mask``."""
        for m in MARKER_CHANNELS:
            plane = mif[CHANNEL_INDEX[m]]
            vals = plane[mask] if mask is not None else plane.ravel()
            if vals.size == 0:
                continue
            q = np.clip((vals * (BINS - 1)).astype(np.int32), 0, BINS - 1)
            self._h[m] += np.bincount(q, minlength=BINS)
        self._n += 1

    @property
    def n_tiles(self) -> int:
        return self._n

    def values_for(self, marker: str, max_samples: int = 200_000) -> np.ndarray:
        """Reconstruct a representative value array for one marker from its histogram.

        The guard in :func:`phenotype._guarded_threshold` reasons about a value population, so we
        expand the histogram back into (down-weighted) samples rather than duplicating its logic.
        Proportions are preserved, which is all Otsu and the guard depend on.
        """
        h = self._h[marker]
        total = int(h.sum())
        if total == 0:
            return np.zeros(0, dtype=np.float32)
        scale = min(1.0, max_samples / total)
        counts = np.maximum((h * scale).astype(np.int64), (h > 0).astype(np.int64))
        centers = (np.arange(BINS, dtype=np.float32) + 0.5) / BINS
        return np.repeat(centers, counts)

    def thresholds(self) -> dict[str, float | None]:
        """Guarded Otsu per marker; None ⇒ no separable positive population on this slide."""
        out: dict[str, float | None] = {}
        for m in MARKER_CHANNELS:
            t = _guarded_threshold(self.values_for(m))
            out[m] = None if t is None else float(t)
        n_ok = sum(1 for v in out.values() if v is not None)
        logger.info("slide thresholds: %d/%d markers separable over %d sampled tiles",
                    n_ok, len(MARKER_CHANNELS), self._n)
        return out


def positive_markers_for(
    vector: np.ndarray, thresholds: dict[str, float | None],
) -> frozenset[str]:
    """Slide-level positivity for one cell vector (mirrors phenotype.positive_markers)."""
    return frozenset(
        m for m in MARKER_CHANNELS
        if thresholds.get(m) is not None and float(vector[CHANNEL_INDEX[m]]) >= thresholds[m]
    )
