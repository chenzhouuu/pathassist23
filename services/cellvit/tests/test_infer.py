import numpy as np
import pytest

from cellvit_service import infer
from cellvit_service.config import get_settings
from cellvit_service.infer import segment_array, warm_up


@pytest.fixture(autouse=True)
def _isolate_settings_cache():
    """CELLVIT_MODEL is read through an lru_cache; clear it around each test."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_default_model_is_the_stub_grid():
    # 128x128 at stride 32 → 4x4 = 16 grid points (the deterministic stub)
    pts = segment_array(np.zeros((128, 128, 3), dtype=np.uint8), mpp=None)
    assert len(pts) == 16
    assert pts[0] == [0.0, 0.0]


def test_warm_up_is_noop_for_stub(monkeypatch):
    monkeypatch.setenv("CELLVIT_MODEL", "stub")
    get_settings.cache_clear()
    # stub needs no GPU model — warm-up must not attempt a load, and must report it skipped.
    assert warm_up() is False


def test_warm_up_loads_model_for_cellvit(monkeypatch):
    monkeypatch.setenv("CELLVIT_MODEL", "cellvit")
    get_settings.cache_clear()
    calls = []
    monkeypatch.setattr(infer, "_get_cellvit_model", lambda: calls.append(1))
    assert warm_up() is True
    assert calls == [1]  # delegated to the singleton builder exactly once
