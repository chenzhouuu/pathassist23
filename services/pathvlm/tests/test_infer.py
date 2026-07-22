import numpy as np

from pathvlm_service import infer


def _pixels(mean=120):
    return np.full((8, 8, 3), mean, dtype=np.uint8)


def test_stub_is_deterministic_and_mentions_mag_and_focus():
    def run():
        return infer.describe_array(_pixels(), magnification=20, focus="nuclear atypia",
                                    use_model=False)

    out1, out2 = run(), run()
    assert out1 == out2  # deterministic — no randomness in the stub
    assert "20x" in out1 and "nuclear atypia" in out1 and "STUB" in out1


def test_dispatch_hits_model_path_only_when_use_model(monkeypatch):
    called = {}

    def fake(pixels, magnification, focus=None):
        called["hit"] = (magnification, focus)
        return "REAL"

    monkeypatch.setattr(infer, "_medgemma_describe", fake)
    assert infer.describe_array(_pixels(), 40, "mitoses", use_model=True) == "REAL"
    assert called["hit"] == (40, "mitoses")

    called.clear()
    out = infer.describe_array(_pixels(), 40, None, use_model=False)
    assert "STUB" in out and "hit" not in called  # stub never touches the model
