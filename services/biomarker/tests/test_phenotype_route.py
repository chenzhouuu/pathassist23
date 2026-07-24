import httpx
import numpy as np

from biomarker_service.app import create_app
from biomarker_service.cellvit_client import CentroidResult
from biomarker_service.infer import NUM_CLASSES
from biomarker_service.markers import CHANNEL_INDEX
from biomarker_service.region import RegionImage


def test_health_reports_mode():
    r = create_app().test_client()
    body = r.get("/health").get_json()
    assert body["service"] == "biomarker" and "mode" in body


def _mixed_tile(tile_rgb):
    # CK high only on the left half → a bimodal CK population so the per-region threshold can call
    # positivity (a uniform all-CK region would correctly yield no positives, S6). DAPI high so QC
    # passes everywhere.
    h, w = tile_rgb.shape[:2]
    m = np.full((NUM_CLASSES, h, w), 0.05, dtype=np.float32)
    m[CHANNEL_INDEX["DAPI"]] = 0.9
    m[CHANNEL_INDEX["CK"], :, : w // 2] = 0.9
    return m


def _client_with_fakes():
    app = create_app()

    def fake_read(*, girder_base, slide_ref, bbox, token, client=None):
        return RegionImage(pixels=np.zeros((64, 64, 3), dtype=np.uint8), mpp=0.5, scale=1.0)

    def fake_centroids(*, base_url, slide_ref, bbox, token, client=None):
        # one cell in the left (CK+) half, one in the right (CK-) half
        return CentroidResult(centroids=[[10.0, 10.0], [50.0, 10.0]],
                              classes=["Neoplastic", "Inflammatory"], mpp=0.5)

    app.config["READ_REGION"] = fake_read
    app.config["FETCH_CENTROIDS"] = fake_centroids
    app.config["TILE_PREDICT"] = _mixed_tile
    app.config["MODE"] = "stub"
    return app.test_client()


def test_phenotype_returns_typed_counts():
    client = _client_with_fakes()
    r = client.post("/phenotype", json={
        "slide_ref": "item1",
        "bbox": {"x": 0, "y": 0, "width": 64, "height": 64},
        "girder_token": "tok",
    })
    assert r.status_code == 200
    body = r.get_json()
    assert body["count"] == 2
    assert body["counts_by_phenotype"]["Tumour"] == 1  # only the left (CK+) cell
    assert body["cells"][0]["x"] == 10.0 and body["cells"][0]["phenotype"] == "Tumour"
    assert "CK" in body["positive_markers"]


def test_phenotype_missing_bbox_is_400():
    client = _client_with_fakes()
    r = client.post("/phenotype", json={"slide_ref": "item1"})
    assert r.status_code == 400


def test_phenotype_oversize_bbox_is_400():
    client = _client_with_fakes()
    r = client.post("/phenotype", json={
        "slide_ref": "s", "bbox": {"x": 0, "y": 0, "width": 5000, "height": 5000},
    })
    assert r.status_code == 400


def test_phenotype_unavailable_is_503():
    app = create_app()
    app.config["TILE_PREDICT"] = None  # no model, no dev stub
    client = app.test_client()
    r = client.post("/phenotype", json={
        "slide_ref": "s", "bbox": {"x": 0, "y": 0, "width": 64, "height": 64},
    })
    assert r.status_code == 503


def test_phenotype_girder_error_is_502():
    app = create_app()

    def boom(*, girder_base, slide_ref, bbox, token, client=None):
        raise httpx.ConnectError("down")

    app.config["READ_REGION"] = boom
    app.config["TILE_PREDICT"] = _mixed_tile
    client = app.test_client()
    r = client.post("/phenotype", json={
        "slide_ref": "s", "bbox": {"x": 0, "y": 0, "width": 64, "height": 64},
    })
    assert r.status_code == 502
