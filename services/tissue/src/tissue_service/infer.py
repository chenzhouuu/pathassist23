"""Sliding-window inference over a read window (Inc 4, design §5).

The network consumes ``patch_in`` px and returns the centre ``patch_out`` px, i.e. it discards
``(patch_in - patch_out) / 2`` px of context per side. Tiling therefore has a natural stride of
``patch_out``: consecutive output blocks abut, and each was computed with full context.

Whether abutting is *enough* is an empirical question. Inc 3b measured a visible seam grid from
butt-jointed windows even where each window was individually correct, so ``OVERLAP`` exists and
feathering happens **in probability space, before the argmax** — blending class indices would be
meaningless, blending probabilities is exactly right.

``NORMALISE`` is stated here as a named constant because getting it wrong is the failure mode that
produces a confident wrong map rather than an obviously broken one. The reference implementation's
``_transform`` is ``image / 255.0`` — no ImageNet mean/std.
"""

import numpy as np

NORMALISE = "x / 255.0"      # documented in model.predict_fn; asserted by tests
DEFAULT_OVERLAP = 0


def window_starts(total: int, size: int, stride: int) -> list[int]:
    """Output-block origins covering ``total`` px, the last one clamped so nothing is missed."""
    if total <= size:
        return [0]
    starts = list(range(0, total - size + 1, stride))
    if starts[-1] + size < total:
        starts.append(total - size)
    return starts


def _ramp(n: int, overlap: int) -> np.ndarray:
    """A 1-D blend weight: flat 1 in the middle, cosine-tapered over ``overlap`` at each end."""
    w = np.ones(n, dtype=np.float32)
    if overlap <= 0:
        return w
    k = min(overlap, n // 2)
    if k <= 0:
        return w
    taper = 0.5 * (1.0 - np.cos(np.linspace(0.0, np.pi, k + 2)[1:-1])).astype(np.float32)
    w[:k] = taper
    w[n - k:] = taper[::-1]
    return w


def predict_window(
    rgb: np.ndarray,
    predict,
    *,
    n_classes: int,
    patch_in: int = 1024,
    patch_out: int = 512,
    overlap: int = DEFAULT_OVERLAP,
) -> np.ndarray:
    """``rgb`` HxWx3 uint8 at the backend's input mpp → ``[C, H, W]`` float32 probabilities.

    The input is reflect-padded by the network's context margin so that *every* output pixel —
    including those on the window's own border — is produced with real context rather than with
    zeros, which would paint a dark frame around each core tile.
    """
    h, w = rgb.shape[:2]
    margin = (patch_in - patch_out) // 2
    stride = max(1, patch_out - overlap)

    ys = window_starts(h, patch_out, stride)
    xs = window_starts(w, patch_out, stride)
    # Pad enough for the furthest window's input, plus the margin on every side.
    pad_y = margin + max(0, (ys[-1] + patch_out) - h) + margin
    pad_x = margin + max(0, (xs[-1] + patch_out) - w) + margin
    padded = np.pad(rgb, ((margin, pad_y), (margin, pad_x), (0, 0)), mode="reflect")

    acc = np.zeros((n_classes, h, w), dtype=np.float32)
    wsum = np.zeros((h, w), dtype=np.float32)
    ramp = _ramp(patch_out, overlap)
    weight2d = np.outer(ramp, ramp)

    for oy in ys:
        for ox in xs:
            block = predict(padded[oy:oy + patch_in, ox:ox + patch_in])
            bh = min(patch_out, h - oy)
            bw = min(patch_out, w - ox)
            wt = weight2d[:bh, :bw]
            acc[:, oy:oy + bh, ox:ox + bw] += block[:, :bh, :bw] * wt
            wsum[oy:oy + bh, ox:ox + bw] += wt

    np.maximum(wsum, 1e-6, out=wsum)
    return acc / wsum
