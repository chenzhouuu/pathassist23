import httpx
import numpy as np

import pathvlm_service.app as app_module
from pathvlm_service.app import create_app
from pathvlm_service.config import get_settings
from pathvlm_service.region import RegionImage


def test_health_ok():
    r = create_app().test_client().get("/health")
    assert r.status_code == 200 and r.get_json()["service"] == "pathvlm"


def test_a_configured_checkpoint_starts_cold_and_reaps(monkeypatch):
    """The default holds no VRAM at boot — the first describe loads, the reaper releases."""
    monkeypatch.setenv("PATHVLM_MEDGEMMA_CKPT", "/weights/ckpt")
    monkeypatch.delenv("PATHVLM_WARM_START", raising=False)
    get_settings.cache_clear()
    warmed, reaped = [], []
    monkeypatch.setattr(app_module, "warm_up", lambda: warmed.append(1))
    monkeypatch.setattr(app_module, "start_idle_reaper", lambda: reaped.append(1))
    try:
        app_module.create_app()
        assert warmed == [] and reaped == [1]
    finally:
        get_settings.cache_clear()


def test_warm_start_opts_back_into_preloading(monkeypatch):
    monkeypatch.setenv("PATHVLM_MEDGEMMA_CKPT", "/weights/ckpt")
    monkeypatch.setenv("PATHVLM_WARM_START", "1")
    get_settings.cache_clear()
    warmed, reaped = [], []
    monkeypatch.setattr(app_module, "warm_up", lambda: warmed.append(1))
    monkeypatch.setattr(app_module, "start_idle_reaper", lambda: reaped.append(1))
    try:
        app_module.create_app()
        assert warmed == [1] and reaped == [1]  # preloaded, still reaped once quiet
    finally:
        get_settings.cache_clear()


def test_create_app_skips_warm_up_for_stub(monkeypatch):
    monkeypatch.setenv("PATHVLM_MEDGEMMA_CKPT", "")
    get_settings.cache_clear()
    calls, reaped = [], []
    monkeypatch.setattr(app_module, "warm_up", lambda: calls.append(1))
    monkeypatch.setattr(app_module, "start_idle_reaper", lambda: reaped.append(1))
    try:
        app_module.create_app()
        # The GPU-free stub never loads a model, so it also has nothing to reap — no thread.
        assert calls == [] and reaped == []
    finally:
        get_settings.cache_clear()


def _client_with_fakes():
    app = create_app()

    def fake_read(*, girder_base, slide_ref, bbox, magnification, out_px,
                  default_mag, token, client=None):
        return RegionImage(pixels=np.zeros((8, 8, 3), np.uint8), magnification=20.0, mpp=0.5)

    def fake_describe(pixels, magnification, focus=None):
        return f"desc@{magnification:g}x focus={focus}"

    app.config["READ_REGION"] = fake_read
    app.config["DESCRIBE"] = fake_describe
    return app.test_client()


def test_describe_returns_description_and_effective_mag():
    r = _client_with_fakes().post("/describe_region", json={
        "slide_ref": "item1",
        "bbox": {"x": 100, "y": 200, "width": 512, "height": 512},
        "magnification": 80, "focus": "atypia", "girder_token": "tok",
    })
    assert r.status_code == 200
    body = r.get_json()
    assert body["magnification_used"] == 20.0
    assert body["description"] == "desc@20x focus=atypia"
    assert body["mpp"] == 0.5


def test_missing_bbox_is_400():
    r = create_app().test_client().post("/describe_region", json={"slide_ref": "x"})
    assert r.status_code == 400


def test_nonpositive_bbox_is_400():
    r = create_app().test_client().post("/describe_region", json={
        "slide_ref": "x", "bbox": {"x": 0, "y": 0, "width": 0, "height": 10},
    })
    assert r.status_code == 400


def test_region_read_failure_is_502():
    app = create_app()

    def failing(*, girder_base, slide_ref, bbox, magnification, out_px,
                default_mag, token, client=None):
        raise httpx.ConnectError("girder down")

    app.config["READ_REGION"] = failing
    r = app.test_client().post("/describe_region", json={
        "slide_ref": "x", "bbox": {"x": 0, "y": 0, "width": 8, "height": 8},
    })
    assert r.status_code == 502
    assert "region" in r.get_json()["detail"].lower()
