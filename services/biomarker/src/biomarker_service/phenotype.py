"""Per-cell pooling → region-adaptive positivity → transparent phenotype (design §5).

Pure numpy; no torch, no IO. The mIF is a ``[C, H, W]`` per-pixel marker-**presence probability**
(sigmoid, review B1). For each nucleus we pool a small disk around its region-local pixel to a
per-marker mean probability (the source-of-truth vector). Positivity is decided by a **per-region
Otsu** threshold with a **degeneracy guard** (S6) so a uniformly-negative marker yields no false
positives. The phenotype is then the pure gate over the positive set (markers.py, O1).
"""

import numpy as np

from .markers import (
    CHANNEL_INDEX,
    DAPI_CHANNEL,
    DEFAULT_LINEAGE,
    FUNCTIONAL_FLAGS,
    LINEAGE_RULES,
    MARKER_CHANNELS,
)

# A pooled DAPI presence-prob below this reads as "no nuclear signal here" → the cell is flagged
# low-confidence (not dropped, not silently phenotyped).
DAPI_MIN_PROB = 0.1

# Degeneracy guard (S6): the two Otsu classes must be separated by at least this fraction of the
# marker's value range, and the positive class must be a real minority/majority split — else there
# is no bimodal population and we call **no** cell positive for that marker.
MIN_SEPARATION_RATIO = 0.15
MIN_POSITIVE_FRACTION = 0.01


def pool_cells(mif: np.ndarray, colrows: list[tuple[float, float]], radius_px: float) -> np.ndarray:
    """Mean marker-presence probability over a disk around each cell → ``[n_cells, C]``."""
    c, h, w = mif.shape
    r = max(1, int(round(radius_px)))
    out = np.zeros((len(colrows), c), dtype=np.float32)
    for k, (col, row) in enumerate(colrows):
        cc, rr = int(round(col)), int(round(row))
        y0, y1 = max(0, rr - r), min(h, rr + r + 1)
        x0, x1 = max(0, cc - r), min(w, cc + r + 1)
        yy, xx = np.ogrid[y0:y1, x0:x1]
        mask = (yy - rr) ** 2 + (xx - cc) ** 2 <= r * r
        if mask.any():
            out[k] = mif[:, y0:y1, x0:x1][:, mask].mean(axis=1)
        else:  # degenerate window at the raster edge — fall back to the single pixel
            out[k] = mif[:, min(rr, h - 1), min(cc, w - 1)]
    return out


def dapi_ok(vectors: np.ndarray) -> np.ndarray:
    """Boolean per-cell QC: the pooled DAPI (nuclear reference) clears the empty-nucleus floor."""
    if vectors.size == 0:
        return np.zeros((0,), dtype=bool)
    return vectors[:, CHANNEL_INDEX[DAPI_CHANNEL]] >= DAPI_MIN_PROB


def _otsu(values: np.ndarray) -> float:
    """1-D Otsu threshold (64-bin) maximising between-class variance."""
    lo, hi = float(values.min()), float(values.max())
    if hi <= lo:
        return hi
    hist, edges = np.histogram(values, bins=64, range=(lo, hi))
    centers = (edges[:-1] + edges[1:]) / 2.0
    wb = np.cumsum(hist).astype(np.float64)
    wf = wb[-1] - wb
    cs = np.cumsum(hist * centers)
    mb = cs / np.maximum(wb, 1)
    mf = (cs[-1] - cs) / np.maximum(wf, 1)
    between = wb * wf * (mb - mf) ** 2
    return float(centers[int(np.argmax(between))])


def _guarded_threshold(values: np.ndarray) -> float | None:
    """Otsu threshold, or None when the population is not bimodal enough to call positives (S6)."""
    if values.size == 0:
        return None
    lo, hi = float(values.min()), float(values.max())
    if hi <= lo:
        return None
    t = _otsu(values)
    pos = values >= t
    frac = float(pos.mean())
    if frac < MIN_POSITIVE_FRACTION or frac > 1.0 - MIN_POSITIVE_FRACTION:
        return None
    below, above = values[~pos], values[pos]
    if below.size == 0 or above.size == 0:
        return None
    if (above.mean() - below.mean()) < MIN_SEPARATION_RATIO * (hi - lo):
        return None
    return t


def region_thresholds(vectors: np.ndarray) -> dict[str, float | None]:
    """Per-marker guarded Otsu threshold over the region's cells (None ⇒ no positive population)."""
    if vectors.size == 0:
        return {m: None for m in MARKER_CHANNELS}
    return {m: _guarded_threshold(vectors[:, CHANNEL_INDEX[m]]) for m in MARKER_CHANNELS}


def positive_markers(vector: np.ndarray, thresholds: dict[str, float | None]) -> frozenset[str]:
    """The markers this cell is region-relative-positive for."""
    return frozenset(
        m for m in MARKER_CHANNELS
        if thresholds.get(m) is not None and float(vector[CHANNEL_INDEX[m]]) >= thresholds[m]
    )


def gate(pos: frozenset[str]) -> tuple[str, list[str]]:
    """(lineage, functional flags) from a cell's positive-marker set (first lineage rule wins)."""
    lineage = next((name for name, rule in LINEAGE_RULES if rule(pos)), DEFAULT_LINEAGE)
    flags = [name for name, rule in FUNCTIONAL_FLAGS if rule(pos)]
    return lineage, flags
