"""Recycling the CellViT session (Inc 5, ticket 07).

The behaviour being defended is a mitigation, not a fix: past twenty-odd consecutive `process_wsi`
calls the vendored pipeline's ray actors stop delivering and the worker blocks in `ray.get()`
forever, with the actors alive and the GPU idle. Observed twice on a real whole-slide run and
confirmed by stack dump. Nothing here can interrupt that, so the session is rebuilt often enough
that it never gets there.
"""

import pytest

from cellvit_service import infer


@pytest.fixture(autouse=True)
def counters(monkeypatch):
    monkeypatch.setattr(infer, "_CALLS", 0)
    yield


def _cellvit_settings(monkeypatch, every):
    monkeypatch.setenv("CELLVIT_MODEL", "cellvit")
    monkeypatch.setenv("CELLVIT_RECYCLE_EVERY", str(every))
    from cellvit_service.config import get_settings
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _count_resets(monkeypatch, n_calls, every):
    resets = []
    monkeypatch.setattr(infer, "reset_cellvit_model", lambda: resets.append(1))
    monkeypatch.setattr(infer, "_cellvit_segment_array", lambda pixels, mpp: ([], [], []))
    for _ in _cellvit_settings(monkeypatch, every):
        for _ in range(n_calls):
            infer.segment_array(None, 0.25)
        return len(resets)


def test_the_session_is_rebuilt_before_it_can_reach_the_wedge(monkeypatch):
    # 25 inferences at a recycle of 12: rebuilt on the 13th and the 25th, so no session ever
    # gets past 12 — comfortably under the earliest wedge seen (21).
    assert _count_resets(monkeypatch, 25, 12) == 2


def test_a_short_run_is_never_interrupted(monkeypatch):
    """A rebuild costs a 2.7 GB model load. A region job of a few cores must not pay it."""
    assert _count_resets(monkeypatch, 12, 12) == 0


def test_recycling_can_be_switched_off(monkeypatch):
    assert _count_resets(monkeypatch, 100, 0) == 0


def test_the_stub_backend_never_recycles(monkeypatch):
    """No ray, no wedge, and the stub is what CI runs — it must not reach for a GPU model."""
    resets = []
    monkeypatch.setattr(infer, "reset_cellvit_model", lambda: resets.append(1))
    monkeypatch.setenv("CELLVIT_MODEL", "stub")
    monkeypatch.setenv("CELLVIT_RECYCLE_EVERY", "1")
    from cellvit_service.config import get_settings
    get_settings.cache_clear()
    try:
        import numpy as np
        for _ in range(5):
            infer.segment_array(np.zeros((64, 64, 3), dtype=np.uint8), 0.25)
        assert resets == []
    finally:
        get_settings.cache_clear()


def test_reset_drops_the_singleton(monkeypatch):
    monkeypatch.setattr(infer, "_MODEL", object())
    infer.reset_cellvit_model()
    assert infer._MODEL is None
