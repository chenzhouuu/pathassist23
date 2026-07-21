"""Nucleus segmentation on an extracted region → region-local centroids.

STUB implementation: a deterministic 32-px grid, so the whole service + gateway pipeline
is testable and demonstrable without a GPU. The real CellViT-SAM-H model swaps in behind
this exact signature in the GPU follow-up (see the R11 deployment design, §3.2) — it will
lazily import ``cellvit`` and run inference on ``pixels`` (using ``mpp`` to match its
0.25 µm/px training scale).
"""

import numpy as np

_STUB_STRIDE = 32


def segment_array(pixels: np.ndarray, mpp: float | None) -> list[list[float]]:
    """Return region-local ``[x, y]`` nucleus centroids for the region ``pixels``."""
    h, w = pixels.shape[:2]
    return [
        [float(x), float(y)]
        for y in range(0, h, _STUB_STRIDE)
        for x in range(0, w, _STUB_STRIDE)
    ]
