from starlette.testclient import TestClient

from cellvit_service.app import create_app


def test_health_ok():
    client = TestClient(create_app())
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "cellvit"


import numpy as np

from cellvit_service.region import RegionImage


def _client_with_fakes():
    from cellvit_service.app import create_app
    app = create_app()

    async def fake_read_region(*, girder_base, slide_ref, bbox, token, client=None):
        return RegionImage(pixels=np.zeros((48, 64, 3), dtype=np.uint8), mpp=None, scale=1.0)

    def fake_segment(pixels, mpp):
        return [[0.0, 0.0], [10.0, 20.0]]  # two region-local centroids

    app.state.read_region = fake_read_region
    app.state.segment = fake_segment
    return TestClient(app)


def test_segment_returns_level0_centroids_and_count():
    client = _client_with_fakes()
    r = client.post("/segment", json={
        "slide_ref": "item1",
        "bbox": {"x": 100, "y": 200, "width": 64, "height": 48},
        "girder_token": "tok",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    # region-local [0,0] and [10,20] re-offset by the bbox origin (scale 1)
    assert body["centroids"] == [[100.0, 200.0], [110.0, 220.0]]
