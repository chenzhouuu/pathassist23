import threading
import time

import httpx
import numpy as np
from support import segmented

import cellvit_service.app as app_module
from cellvit_service.app import create_app
from cellvit_service.config import get_settings
from cellvit_service.region import RegionImage


def test_health_ok():
    client = create_app().test_client()
    r = client.get("/health")
    assert r.status_code == 200
    body = r.get_json()
    assert body["status"] == "ok"
    assert body["service"] == "cellvit"


def _client_with_fakes():
    app = create_app()

    def fake_read_region(*, girder_base, slide_ref, bbox, token, client=None):
        return RegionImage(pixels=np.zeros((48, 64, 3), dtype=np.uint8), mpp=0.5, scale=1.0)

    def fake_segment(pixels, mpp):
        # region-local centroids, PanNuke class ids, region-local contour rings
        return segmented(
            [[0.0, 0.0], [10.0, 20.0]],
            [1, 2],
            [[[-1.0, 0.0], [1.0, 0.0], [0.0, 1.0]], [[9.0, 20.0], [11.0, 20.0], [10.0, 21.0]]],
        )

    app.config["READ_REGION"] = fake_read_region
    app.config["SEGMENT"] = fake_segment
    return app.test_client()


def test_segment_returns_level0_centroids_and_count():
    client = _client_with_fakes()
    r = client.post("/segment", json={
        "slide_ref": "item1",
        "bbox": {"x": 100, "y": 200, "width": 64, "height": 48},
        "girder_token": "tok",
    })
    assert r.status_code == 200
    body = r.get_json()
    assert body["count"] == 2
    # region-local [0,0] and [10,20] re-offset by the bbox origin (scale 1)
    assert body["centroids"] == [[100.0, 200.0], [110.0, 220.0]]
    assert body["mpp"] == 0.5  # the slide's native µm/px, surfaced for density grounding


def test_segment_returns_typed_counts_and_class_names():
    app = create_app()

    def fake_read_region(*, girder_base, slide_ref, bbox, token, client=None):
        return RegionImage(pixels=np.zeros((48, 64, 3), dtype=np.uint8), mpp=0.5, scale=1.0)

    def fake_segment(pixels, mpp):
        # two Neoplastic, one Inflammatory, each with a one-vertex placeholder ring
        return segmented(
            [[0.0, 0.0], [10.0, 20.0], [5.0, 5.0]], [1, 2, 1],
            [[[0.0, 0.0]], [[10.0, 20.0]], [[5.0, 5.0]]],
        )

    app.config["READ_REGION"] = fake_read_region
    app.config["SEGMENT"] = fake_segment
    body = app.test_client().post("/segment", json={
        "slide_ref": "s1", "bbox": {"x": 100, "y": 200, "width": 64, "height": 48},
    }).get_json()

    assert body["count"] == 3
    assert body["centroids"] == [[100.0, 200.0], [110.0, 220.0], [105.0, 205.0]]
    assert body["classes"] == [1, 2, 1]
    assert body["counts_by_type"] == {"Neoplastic": 2, "Inflammatory": 1}
    assert body["class_names"]["1"] == "Neoplastic" and len(body["class_names"]) == 5
    # the alignment invariant the route asserts
    assert body["count"] == len(body["centroids"]) == len(body["classes"])
    assert sum(body["counts_by_type"].values()) == body["count"]
    # contours ride along, index-aligned and re-offset to level-0 like the centroids (Inc 3b)
    assert len(body["contours"]) == body["count"]
    assert body["contours"] == [[[100.0, 200.0]], [[110.0, 220.0]], [[105.0, 205.0]]]


def test_create_app_warms_up_when_model_is_cellvit(monkeypatch):
    monkeypatch.setenv("CELLVIT_MODEL", "cellvit")
    get_settings.cache_clear()
    warmed = threading.Event()
    monkeypatch.setattr(app_module, "warm_up", lambda: warmed.set(), raising=False)
    try:
        create_app()
        assert warmed.wait(timeout=2)  # model preload kicked off in the background
    finally:
        get_settings.cache_clear()


def test_create_app_does_not_warm_up_for_stub(monkeypatch):
    monkeypatch.setenv("CELLVIT_MODEL", "stub")
    get_settings.cache_clear()
    calls = []
    monkeypatch.setattr(app_module, "warm_up", lambda: calls.append(1), raising=False)
    try:
        create_app()
        time.sleep(0.1)  # a would-be warm-up thread would have run by now
        assert calls == []
    finally:
        get_settings.cache_clear()


def test_segment_missing_bbox_is_400():
    client = create_app().test_client()
    r = client.post("/segment", json={"slide_ref": "x"})
    assert r.status_code == 400


def test_segment_returns_502_when_region_read_fails():
    app = create_app()

    def failing_read(*, girder_base, slide_ref, bbox, token, client=None):
        raise httpx.ConnectError("girder unreachable")

    app.config["READ_REGION"] = failing_read
    client = app.test_client()
    r = client.post("/segment", json={
        "slide_ref": "x", "bbox": {"x": 0, "y": 0, "width": 8, "height": 8},
    })
    assert r.status_code == 502
    assert "region" in r.get_json()["detail"].lower()
