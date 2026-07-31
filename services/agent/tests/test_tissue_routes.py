"""Gateway control plane + authenticated tile proxy for the Inc 4 tissue map."""

import httpx
import pytest
from starlette.testclient import TestClient

from agent.gateway import routes as routes_mod
from agent.gateway.app import create_app
from agent.gateway.auth import require_user
from agent.gateway.routes import (
    get_preprocess_artifact_store,
    get_preprocess_url,
    get_tissue_url,
)
from agent.loop.tissue_map_client import TileResponse
from agent.store import MemoryPreprocessArtifactStore

_USER = {"_id": "u1", "login": "tester"}
_BASE = "/api/copilot/slides"
_TISSUE = "http://tissue:8023"
_PNG = b"\x89PNG\r\n\x1a\n-fake-"


@pytest.fixture
def art_store():
    return MemoryPreprocessArtifactStore()


@pytest.fixture
def client(art_store):
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_preprocess_url] = lambda: "http://preprocess:8030"
    app.dependency_overrides[get_tissue_url] = lambda: _TISSUE
    return TestClient(app)


@pytest.fixture
def unconfigured_client(art_store):
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_tissue_url] = lambda: None
    return TestClient(app)


def _fake_enqueue(**ack):
    async def enqueue(*, base_url, item, seg_hash, bbox, backend, token):
        return {"art_hash": "tis0001", "job_id": "j1", "status": "queued",
                "backend": backend or "bcss_fcn_unet",
                "scope": "slide" if bbox is None else "region", **ack}
    return enqueue


def test_region_build_records_a_tissue_row_parented_on_the_segmentation(
    client, art_store, monkeypatch,
):
    monkeypatch.setattr(routes_mod, "enqueue_tissue", _fake_enqueue())
    r = client.post(f"{_BASE}/item1/tissue",
                    json={"seg_hash": "seg9",
                          "bbox": {"x": 0, "y": 0, "width": 2048, "height": 2048}})
    assert r.status_code == 200
    row = r.json()
    assert row["kind"] == "tissue"
    assert row["art_hash"] == "tis0001"
    assert row["parent_hash"] == "seg9"          # the mask is what says where tissue is
    assert row["params"]["scope"] == "region"
    assert row["params"]["backend"] == "bcss_fcn_unet"


def test_whole_slide_build_is_the_same_route_with_no_bbox(client, monkeypatch):
    monkeypatch.setattr(routes_mod, "enqueue_tissue", _fake_enqueue())
    r = client.post(f"{_BASE}/item1/tissue", json={"seg_hash": "seg9"})
    assert r.json()["params"]["scope"] == "slide"


def test_both_scopes_land_on_one_artifact_row(client, art_store, monkeypatch):
    monkeypatch.setattr(routes_mod, "enqueue_tissue", _fake_enqueue())
    client.post(f"{_BASE}/item1/tissue",
                json={"seg_hash": "seg9", "bbox": {"x": 0, "y": 0, "width": 10, "height": 10}})
    client.post(f"{_BASE}/item1/tissue", json={"seg_hash": "seg9"})
    rows = [r for r in _rows(art_store) if r["kind"] == "tissue"]
    assert len(rows) == 1                        # extended, never forked


def _rows(store, item="item1"):
    import asyncio
    return asyncio.run(store.list_artifacts(item=item))


def test_a_backend_can_be_named_and_travels_to_the_worker(client, monkeypatch):
    seen = {}

    async def enqueue(*, base_url, item, seg_hash, bbox, backend, token):
        seen["backend"] = backend
        return {"art_hash": "x", "job_id": "j", "status": "queued", "scope": "slide",
                "backend": backend}

    monkeypatch.setattr(routes_mod, "enqueue_tissue", enqueue)
    client.post(f"{_BASE}/item1/tissue", json={"seg_hash": "s", "backend": "uni_decoder"})
    assert seen["backend"] == "uni_decoder"


def test_unconfigured_service_is_a_503_with_the_env_var_named(unconfigured_client):
    r = unconfigured_client.post(f"{_BASE}/item1/tissue", json={"seg_hash": "seg9"})
    assert r.status_code == 503
    assert "AGENT_TISSUE_SERVICE_URL" in r.json()["detail"]


def test_worker_without_weights_is_forwarded_as_503_not_a_502(client, monkeypatch):
    async def enqueue(**_kw):
        raise httpx.HTTPStatusError(
            "no weights", request=httpx.Request("POST", "/tissue"),
            response=httpx.Response(503, json={"detail": "tissue segmentation needs the GPU"}),
        )

    monkeypatch.setattr(routes_mod, "enqueue_tissue", enqueue)
    r = client.post(f"{_BASE}/item1/tissue", json={"seg_hash": "seg9"})
    assert r.status_code == 503
    assert "GPU" in r.json()["detail"]


def test_an_unreachable_worker_is_a_502(client, monkeypatch):
    async def enqueue(**_kw):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(routes_mod, "enqueue_tissue", enqueue)
    assert client.post(f"{_BASE}/item1/tissue", json={"seg_hash": "s"}).status_code == 502


def test_catalog_is_proxied(client, monkeypatch):
    async def get_json(*, base_url, path, params=None, client=None):
        assert path == "/tissue/catalog"
        return {"backends": {"bcss_fcn_unet": {"classes": ["Tumour"]}},
                "default_backend": "bcss_fcn_unet"}

    monkeypatch.setattr(routes_mod, "get_tissue_json", get_json)
    assert client.get("/api/copilot/tissue/catalog").json()["default_backend"] == "bcss_fcn_unet"


def test_meta_404_is_a_404_not_an_empty_document(client, monkeypatch):
    async def get_json(**_kw):
        return None

    monkeypatch.setattr(routes_mod, "get_tissue_json", get_json)
    assert client.get(f"{_BASE}/item1/tissue/abc/meta").status_code == 404


def test_stats_forwards_the_bbox_query(client, monkeypatch):
    seen = {}

    async def get_json(*, base_url, path, params=None, client=None):
        seen.update(params or {})
        return {"scope": "region", "fraction": {"Tumour": 0.4}}

    monkeypatch.setattr(routes_mod, "get_tissue_json", get_json)
    r = client.get(f"{_BASE}/item1/tissue/abc/stats?bbox=0,0,100,100")
    assert r.status_code == 200
    assert seen["bbox"] == "0,0,100,100"


def test_tile_proxy_forwards_the_query_verbatim_and_keeps_cache_headers(client, monkeypatch):
    seen = {}

    async def get_tile(*, base_url, path, params, client=None):
        seen["path"] = path
        seen["params"] = params
        return TileResponse(body=_PNG, content_type="image/png",
                            cache_control="public, max-age=86400", etag='W/"3"')

    monkeypatch.setattr(routes_mod, "get_tissue_tile", get_tile)
    r = client.get(f"{_BASE}/item1/tissue/abc/tile/classes/0/1/2.png"
                   "?show=Tumour,Stroma&alpha=0.45&conf=1")
    assert r.status_code == 200
    assert r.content == _PNG
    assert r.headers["Cache-Control"] == "public, max-age=86400"
    assert r.headers["ETag"] == 'W/"3"'
    assert seen["path"] == "/tissue/item1/abc/tile/classes/0/1/2.png"
    # the gateway must not interpret the render spec — a dropped param is a wrong picture
    assert seen["params"] == {"show": "Tumour,Stroma", "alpha": "0.45", "conf": "1"}


def test_a_worker_400_reaches_the_browser_as_a_400(client, monkeypatch):
    async def get_tile(*, base_url, path, params, client=None):
        return TileResponse(body=b'{"detail":"unknown class"}', content_type="application/json",
                            cache_control=None, etag=None, status_code=400)

    monkeypatch.setattr(routes_mod, "get_tissue_tile", get_tile)
    r = client.get(f"{_BASE}/item1/tissue/abc/tile/classes/0/0/0.png?show=Tumor")
    assert r.status_code == 400          # a typo must not surface as a gateway failure


def test_a_running_row_is_reconciled_against_the_tissue_worker(client, art_store, monkeypatch):
    monkeypatch.setattr(routes_mod, "enqueue_tissue", _fake_enqueue())
    client.post(f"{_BASE}/item1/tissue", json={"seg_hash": "seg9"})

    async def status(*, base_url, job_id, client=None):
        assert base_url == _TISSUE          # polled at the tissue worker, not preprocess
        return {"status": "ready",
                "result": {"art_hash": "tis0001", "n_core_tiles": 47, "covered_mm2": 12.4,
                           "tsr": 0.418, "fraction": {"Tumour": 0.43}}}

    monkeypatch.setattr(routes_mod, "tissue_job_status", status)
    rows = client.get(f"{_BASE}/item1/artifacts").json()["artifacts"]
    row = next(r for r in rows if r["kind"] == "tissue")
    assert row["status"] == "ready"
    assert row["result"]["tsr"] == 0.418
    assert row["result"]["covered_mm2"] == 12.4
    assert row["n_items"] == 47
