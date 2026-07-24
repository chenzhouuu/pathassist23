"""Tile-streamed fusion: region pixels + level-0 centroids → per-cell phenotype records.

Drives the tile predictor (infer.tile_fn) **tile by tile**, pools each tile's cells immediately,
and discards the tile raster (review S2 — the full ROI mIF is never held). Then computes the
region-adaptive thresholds over all cells and gates each cell. Pure w.r.t. IO: the predictor and
the centroids are injected, so this is unit-tested with a fake tile predictor (no torch, no GPU).
"""

import numpy as np

from . import align
from .infer import NUM_CLASSES, TILE
from .markers import CHANNEL_INDEX
from .phenotype import dapi_ok, gate, pool_cells, positive_markers, region_thresholds


def phenotype_region(
    pixels: np.ndarray,
    tile_predict,
    centroids_level0: list[list[float]],
    classes: list[str],
    origin_x: float,
    origin_y: float,
    read_scale: float,
    radius_px: float,
) -> tuple[list[dict], dict[str, float | None]]:
    """Return (per-cell records, per-marker thresholds) for the region.

    Each record: ``{x, y, phenotype, flags, dapi_ok, pannuke, markers}`` where ``markers`` holds
    only the gate-deciding (positive) values — not all 23 (review O2). ``x, y`` are level-0 px.
    """
    h, w = pixels.shape[:2]
    kept = align.region_pixels(centroids_level0, origin_x, origin_y, read_scale, w, h)
    vectors = np.zeros((len(kept), NUM_CLASSES), dtype=np.float32)

    for ty in range(0, h, TILE):
        for tx in range(0, w, TILE):
            th, tw = min(TILE, h - ty), min(TILE, w - tx)
            in_tile = [
                (k, col - tx, row - ty)
                for k, (_, col, row) in enumerate(kept)
                if ty <= row < ty + th and tx <= col < tx + tw
            ]
            if not in_tile:
                continue
            tile_mif = tile_predict(pixels[ty:ty + th, tx:tx + tw])  # [23, th, tw]
            pooled = pool_cells(tile_mif, [(c, r) for _, c, r in in_tile], radius_px)
            for (k, _, _), vec in zip(in_tile, pooled, strict=True):
                vectors[k] = vec
            # tile_mif goes out of scope here — one tile's worth of memory, never the ROI's.

    thresholds = region_thresholds(vectors)
    ok = dapi_ok(vectors)
    cells: list[dict] = []
    for k, (idx, _, _) in enumerate(kept):
        pos = positive_markers(vectors[k], thresholds)
        lineage, flags = gate(pos)
        cells.append({
            "x": float(centroids_level0[idx][0]),
            "y": float(centroids_level0[idx][1]),
            "phenotype": lineage,
            "flags": flags,
            "dapi_ok": bool(ok[k]),
            "pannuke": classes[idx] if idx < len(classes) else None,
            "markers": {m: round(float(vectors[k][CHANNEL_INDEX[m]]), 4) for m in sorted(pos)},
        })
    return cells, thresholds


def counts_by_phenotype(cells: list[dict]) -> dict[str, int]:
    """Per-lineage tally (numbers are always this, never model-computed)."""
    counts: dict[str, int] = {}
    for c in cells:
        counts[c["phenotype"]] = counts.get(c["phenotype"], 0) + 1
    return counts


def flag_counts(cells: list[dict]) -> dict[str, int]:
    """Per functional-flag tally across all cells (e.g. how many PD-1⁺)."""
    counts: dict[str, int] = {}
    for c in cells:
        for f in c["flags"]:
            counts[f] = counts.get(f, 0) + 1
    return counts
