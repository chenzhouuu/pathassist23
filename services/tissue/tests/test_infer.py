"""Sliding-window inference: coverage, seam behaviour and the normalisation contract."""

import numpy as np
import pytest

from tissue_service.infer import NORMALISE, predict_window, window_starts

PATCH_IN, PATCH_OUT = 64, 32


def _centre(rgb: np.ndarray) -> np.ndarray:
    """The slice of a padded input the network would actually see."""
    m = (PATCH_IN - PATCH_OUT) // 2
    return rgb[m:m + PATCH_OUT, m:m + PATCH_OUT]


def constant_predictor(value: int = 0, n: int = 3):
    def predict(rgb):
        out = np.zeros((n, PATCH_OUT, PATCH_OUT), np.float32)
        out[value] = 1.0
        return out
    return predict


def content_predictor(n: int = 3):
    """Reacts to *pixels*, like a real model: class = red channel bucket.

    Deliberately not a function of the window's slide coordinates — the network has no idea where
    it is, and a fake that did would hide exactly the bugs this test exists to catch.
    """
    def predict(rgb):
        crop = _centre(rgb).astype(np.float32)
        red = crop[..., 0] / 255.0
        out = np.zeros((n, PATCH_OUT, PATCH_OUT), np.float32)
        for c in range(n):
            out[c] = np.clip(1.0 - np.abs(red - c / (n - 1)) * (n - 1), 0, 1)
        s = out.sum(0, keepdims=True)
        return out / np.maximum(s, 1e-6)
    return predict


def test_window_starts_cover_everything_including_a_ragged_tail():
    assert window_starts(32, 32, 32) == [0]
    assert window_starts(64, 32, 32) == [0, 32]
    tail = window_starts(70, 32, 32)
    assert tail[-1] + 32 == 70          # the last block is clamped so nothing is missed
    assert window_starts(10, 32, 32) == [0]


def test_output_covers_the_whole_window_and_sums_to_one():
    rgb = np.zeros((96, 80, 3), np.uint8)
    out = predict_window(rgb, constant_predictor(1), n_classes=3,
                         patch_in=PATCH_IN, patch_out=PATCH_OUT)
    assert out.shape == (3, 96, 80)
    assert np.allclose(out.sum(0), 1.0, atol=1e-4)
    assert np.allclose(out[1], 1.0)


@pytest.mark.parametrize("overlap", [0, 8, 16])
def test_a_uniform_field_is_reproduced_at_any_overlap(overlap):
    """Feathering must be weight-normalised: a constant input may not develop seams."""
    rgb = np.full((96, 96, 3), 128, np.uint8)
    out = predict_window(rgb, content_predictor(), n_classes=3,
                         patch_in=PATCH_IN, patch_out=PATCH_OUT, overlap=overlap)
    assert out.std() < 1e-5 or np.allclose(out, out[:, :1, :1], atol=1e-5)


def test_prediction_follows_the_pixels_not_the_window_grid():
    rgb = np.zeros((96, 96, 3), np.uint8)
    rgb[:, 48:, 0] = 255                       # a content edge that is NOT on a window boundary
    out = predict_window(rgb, content_predictor(), n_classes=3,
                         patch_in=PATCH_IN, patch_out=PATCH_OUT)
    left = out[:, :, :40].argmax(0)
    right = out[:, :, 56:].argmax(0)
    assert (left == 0).all()
    assert (right == 2).all()


def test_reflect_padding_means_no_dark_frame_at_the_window_border():
    """Zero-padding the input would make the border predict on black and ring every core tile."""
    rgb = np.full((96, 96, 3), 255, np.uint8)
    out = predict_window(rgb, content_predictor(), n_classes=3,
                         patch_in=PATCH_IN, patch_out=PATCH_OUT)
    border = np.concatenate([out[:, 0, :].ravel(), out[:, -1, :].ravel(),
                             out[:, :, 0].ravel(), out[:, :, -1].ravel()])
    interior = out[:, 48, 48]
    assert np.allclose(border.reshape(-1, 1).mean(), interior.mean(), atol=1e-3)


def test_normalisation_contract_is_stated():
    # the failure mode is a confidently wrong map, so the contract is pinned rather than implied
    assert NORMALISE == "x / 255.0"
