import numpy as np

from biomarker_service.infer import (
    NUM_CLASSES,
    normalize_rgb,
    stub_tile,
    tile_fn,
    window_padding,
)


def test_window_padding_reaches_256_multiple():
    # C1: any tile side must pad up to a whole number of 256 windows, by < 256 px.
    for h, w in [(256, 256), (300, 300), (176, 200), (512, 488), (1, 1)]:
        ph, pw = window_padding(h, w)
        assert (h + ph) % 256 == 0 and (w + pw) % 256 == 0
        assert 0 <= ph < 256 and 0 <= pw < 256


def test_normalize_rgb_shape_and_range():
    rgb = np.full((32, 48, 3), 128, dtype=np.uint8)
    x = normalize_rgb(rgb)
    assert x.shape == (3, 32, 48) and x.dtype == np.float32


def test_stub_tile_is_probability_map():
    rgb = np.random.default_rng(0).integers(0, 256, (40, 40, 3), dtype=np.uint8)
    mif = stub_tile(rgb)
    assert mif.shape == (NUM_CLASSES, 40, 40)
    assert mif.min() >= 0.0 and mif.max() <= 1.0
    # deterministic
    assert np.array_equal(mif, stub_tile(rgb))


def test_tile_fn_stub_for_non_real_modes():
    assert tile_fn("stub", None) is stub_tile
    assert tile_fn("unavailable", None) is stub_tile


def test_predict_tile_windows_a_fake_model():
    # a fake "model" verifies the windowing/sigmoid path; predict_tile imports torch, so only run
    # when torch is present (base env covers the real path via the GPU smoke).
    torch = __import__("importlib").util.find_spec("torch")
    if torch is None:
        return  # base env has no torch; real path is covered by the GPU smoke (T8)
    import torch as _t

    from biomarker_service.infer import predict_tile

    class FakeModel(_t.nn.Module):
        # Mimics the real GigaTIME-Flash: ALWAYS emits 256x256 regardless of input size.
        def forward(self, x):
            return _t.zeros(x.shape[0], NUM_CLASSES, 256, 256)

    m = FakeModel().eval()
    # exact 256 multiple, and — the C1 regression — sides that are NOT multiples of 256
    for h, w in [(256, 256), (300, 300), (176, 200), (512, 488)]:
        mif = predict_tile(np.zeros((h, w, 3), dtype=np.uint8), m)
        assert mif.shape == (NUM_CLASSES, h, w)
        assert np.allclose(mif, 0.5)  # sigmoid(0) = 0.5, cropped back to the tile size


def test_overlapping_windows_are_feathered_so_no_seam_grid_appears():
    """Butt-jointed 256 windows print a grid across the whole map (the artefact this fixes).

    The fake model returns a left-to-right ramp *within each window*, which is the worst case: with
    no overlap the result is a sawtooth whose teeth drop a full unit at every window boundary. With
    feathering the join must be gentle.
    """
    if __import__("importlib").util.find_spec("torch") is None:
        return  # base env has no torch; the real path is covered by the GPU smoke
    import torch as _t

    from biomarker_service.infer import OVERLAP, predict_tile

    class RampModel(_t.nn.Module):
        def forward(self, x):
            ramp = _t.linspace(-6.0, 6.0, 256).view(1, 1, 1, 256)
            return ramp.expand(x.shape[0], NUM_CLASSES, 256, 256).contiguous()

    assert OVERLAP > 0
    mif = predict_tile(np.zeros((256, 768, 3), dtype=np.uint8), RampModel().eval())
    row = mif[0, 128, :]
    steps = np.abs(np.diff(row))
    # A butt-jointed sawtooth steps by ~1.0 at each seam; a feathered one never comes close.
    assert steps.max() < 0.2, f"discontinuity of {steps.max():.3f} — windows are not blended"
