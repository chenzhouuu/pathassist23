import numpy as np

from cellvit_service.infer import segment_array


def test_default_model_is_the_stub_grid():
    # 128x128 at stride 32 → 4x4 = 16 grid points (the deterministic stub)
    pts = segment_array(np.zeros((128, 128, 3), dtype=np.uint8), mpp=None)
    assert len(pts) == 16
    assert pts[0] == [0.0, 0.0]
