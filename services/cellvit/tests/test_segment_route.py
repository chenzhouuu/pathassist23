import httpx
import numpy as np

from cellvit_service.app import create_app
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
        return RegionImage(pixels=np.zeros((48, 64, 3), dtype=np.uint8), mpp=None, scale=1.0)

    def fake_segment(pixels, mpp):
        return [[0.0, 0.0], [10.0, 20.0]]  # two region-local centroids

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
