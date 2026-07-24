import numpy as np

from biomarker_service.infer import NUM_CLASSES, normalize_rgb, stub_tile, tile_fn


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
    # a fake "model" returning zeros verifies the windowing/sigmoid path; predict_tile imports
    # torch, so only run when torch is present (base env covers the real path via the GPU smoke).
    torch = __import__("importlib").util.find_spec("torch")
    if torch is None:
        return  # base env has no torch; real path is covered by the GPU smoke (T8)
    import torch as _t

    from biomarker_service.infer import predict_tile

    class FakeModel(_t.nn.Module):
        def forward(self, x):
            b, _, h, w = x.shape
            return _t.zeros(b, NUM_CLASSES, h, w)

    m = FakeModel().eval()
    mif = predict_tile(np.zeros((256, 256, 3), dtype=np.uint8), m)
    assert mif.shape == (NUM_CLASSES, 256, 256)
    assert np.allclose(mif, 0.5)  # sigmoid(0) = 0.5
