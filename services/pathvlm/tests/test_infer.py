import time

import numpy as np

from pathvlm_service import infer
from pathvlm_service.config import get_settings


def _pixels(mean=120):
    return np.full((8, 8, 3), mean, dtype=np.uint8)


def test_stub_is_deterministic_and_mentions_mag_and_focus():
    def run():
        return infer.describe_array(_pixels(), magnification=20, focus="nuclear atypia",
                                    use_model=False)

    out1, out2 = run(), run()
    assert out1 == out2  # deterministic — no randomness in the stub
    assert "20x" in out1 and "nuclear atypia" in out1 and "STUB" in out1


def test_system_prompt_permits_a_negative_read():
    # A verifier must be able to disconfirm — the system prompt must allow a benign/normal answer
    # and must not force a caveat-free (always-confident) description.
    s = infer._SYSTEM.lower()
    assert "benign" in s or "normal" in s
    assert "do not append disclaimers or caveats" not in s


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


def _resident(monkeypatch, ttl, age):
    """Pretend a model is loaded and was last used `age` seconds ago, under an `idle_ttl` of `ttl`."""
    get_settings.cache_clear()
    monkeypatch.setenv("PATHVLM_IDLE_TTL", str(ttl))
    monkeypatch.setattr(infer, "_MODEL", ("model", "processor"))
    monkeypatch.setattr(infer, "_LAST_USE", time.monotonic() - age)


def test_idle_release_frees_the_card_only_after_the_window(monkeypatch):
    _resident(monkeypatch, ttl=900, age=100)
    assert infer.release_if_idle() is False and infer._MODEL is not None

    _resident(monkeypatch, ttl=900, age=901)
    assert infer.release_if_idle() is True and infer._MODEL is None
    get_settings.cache_clear()


def test_zero_ttl_keeps_the_model_resident_forever(monkeypatch):
    """0 is the opt-out for a machine with a card to spare — never release, however long it sits."""
    _resident(monkeypatch, ttl=0, age=86_400)
    assert infer.release_if_idle() is False and infer._MODEL is not None
    get_settings.cache_clear()


def test_the_reaper_is_not_started_when_the_policy_is_off(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("PATHVLM_IDLE_TTL", "0")
    started = []
    monkeypatch.setattr(infer.threading, "Thread",
                        lambda *a, **k: started.append(1) or _NoThread())
    infer.start_idle_reaper()
    assert started == []
    get_settings.cache_clear()


class _NoThread:
    def start(self):
        pass
