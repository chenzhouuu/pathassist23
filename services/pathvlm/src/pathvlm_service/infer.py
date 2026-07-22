"""Perceptor inference: a region's pixels → a morphology description.

A stub/real seam exactly like the cellvit service. Without a Patho-R1 checkpoint the GPU-free
stub returns a deterministic, clearly-marked description (so the whole path is browser-E2E-able
with no GPU); the real Patho-R1-7B lands behind ``_patho_r1_describe`` in Inc 2a T6. torch and
transformers are imported lazily on the real path only, so the base env / CI stays GPU-free.
"""

import numpy as np

from .config import get_settings


def describe_array(
    pixels: np.ndarray,
    magnification: float,
    focus: str | None = None,
    *,
    use_model: bool | None = None,
) -> str:
    """Describe the region ``pixels`` (seen at ``magnification``), optionally directed by ``focus``.

    ``use_model`` overrides the config seam (tests pass it explicitly); None reads the settings.
    """
    if use_model is None:
        use_model = get_settings().use_model
    if use_model:
        return _patho_r1_describe(pixels, magnification, focus)
    return _stub_describe(pixels, magnification, focus)


def _stub_describe(pixels: np.ndarray, magnification: float, focus: str | None = None) -> str:
    """A deterministic, clearly-marked placeholder description that echoes mag + focus."""
    arr = np.asarray(pixels)
    mean = float(arr.mean()) if arr.size else 0.0
    density = "densely cellular" if mean < 160 else "sparse, pale"
    focus_note = f" Focus: {focus}." if focus else ""
    return (
        f"[STUB Perceptor @ {magnification:g}x] H&E region appears {density} "
        f"(mean intensity {mean:.0f}); real morphology description pending the Patho-R1 model."
        f"{focus_note}"
    )


def _patho_r1_describe(pixels: np.ndarray, magnification: float, focus: str | None = None) -> str:
    """Real Patho-R1-7B (Qwen2.5-VL) perception. Lands in Inc 2a T6 (lazy torch/transformers)."""
    raise NotImplementedError("real Patho-R1 Perceptor lands in Inc 2a T6")
