"""Gateway control plane + authenticated tile proxy for the Inc 3b marker map."""

import httpx
import pytest
from starlette.testclient import TestClient

from agent.gateway import routes as routes_mod
from agent.gateway.app import create_app
from agent.gateway.auth import require_user
from agent.gateway.routes import (
    get_biomarker_url,
    get_preprocess_artifact_store,
    get_preprocess_url,
)
from agent.loop.biomarker_map_client import TileResponse
from agent.store import MemoryPreprocessArtifactStore

_USER = {"_id": "u1", "login": "tester"}
_BASE = "/api/copilot/slides"
_BIO = "http://biomarker:8022"
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
    app.dependency_overrides[get_biomarker_url] = lambda: _BIO
    return TestClient(app)


@pytest.fixture
def unconfigured_client(art_store):
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_biomarker_url] = lambda: None
    return TestClient(app)


def _fake_enqueue(**ack):
    async def enqueue(*, base_url, item, seg_hash, bbox, token):
        return {"art_hash": "bio0001", "job_id": "j1", "status": "queued",
                "scope": "slide" if bbox is None else "region", **ack}
    return enqueue


def test_region_build_records_a_biomarker_row_parented_on_the_segmentation(
    client, art_store, monkeypatch,
):
    monkeypatch.setattr(routes_mod, "enqueue_map", _fake_enqueue())
    r = client.post(f"{_BASE}/item1/biomarker",
                    json={"seg_hash": "seg9", "bbox": {"x": 0, "y": 0, "width": 2048,
                                                       "height": 2048}})
    assert r.status_code == 200
    row = r.json()
    # D2: same artifact table as the preprocess DAG, so /tasks polling comes free.
    assert row["kind"] == "biomarker"
    assert row["art_hash"] == "bio0001"
    # ...and the parent is the SEGMENTATION, not a patch grid (design §11 correction 1)
    assert row["parent_hash"] == "seg9"
    assert row["params"]["scope"] == "region"
    assert row["status"] == "queued"

    rows = art_store._rows
    assert len(rows) == 1


def test_whole_slide_build_is_the_same_route_with_a_null_bbox(client, monkeypatch):
    monkeypatch.setattr(routes_mod, "enqueue_map", _fake_enqueue())
    r = client.post(f"{_BASE}/item1/biomarker", json={"seg_hash": "seg9"})
    assert r.status_code == 200
    assert r.json()["params"]["scope"] == "slide"      # D5: one pipeline, two scopes


def test_seg_hash_is_required(client):
    assert client.post(f"{_BASE}/item1/biomarker", json={}).status_code == 422


def test_unconfigured_service_is_503_not_a_crash(unconfigured_client):
    r = unconfigured_client.post(f"{_BASE}/item1/biomarker", json={"seg_hash": "seg9"})
    assert r.status_code == 503
    assert "AGENT_BIOMARKER_SERVICE_URL" in r.json()["detail"]


def test_worker_refusals_are_forwarded_verbatim(client, monkeypatch):
    req = httpx.Request("POST", f"{_BIO}/biomarker")
    resp = httpx.Response(503, json={"detail": "needs the GPU worker"}, request=req)

    async def enqueue(**kw):
        raise httpx.HTTPStatusError("no weights", request=req, response=resp)

    monkeypatch.setattr(routes_mod, "enqueue_map", enqueue)
    r = client.post(f"{_BASE}/item1/biomarker", json={"seg_hash": "seg9"})
    assert r.status_code == 503
    assert r.json()["detail"] == "needs the GPU worker"


def test_transport_failure_is_502(client, monkeypatch):
    async def enqueue(**kw):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(routes_mod, "enqueue_map", enqueue)
    assert client.post(f"{_BASE}/item1/biomarker",
                       json={"seg_hash": "seg9"}).status_code == 502


def test_tile_proxy_forwards_query_and_cache_headers(client, monkeypatch):
    seen = {}

    async def get_tile(*, base_url, path, params):
        seen["base"] = base_url
        seen["path"] = path
        seen["params"] = params
        return TileResponse(body=_PNG, content_type="image/png",
                            cache_control="public, max-age=86400", etag='W/"3"')

    monkeypatch.setattr(routes_mod, "get_tile", get_tile)
    r = client.get(f"{_BASE}/item1/biomarker/bio0001/tile/markers/2/5/7.png",
                   params={"ch": "CK:00ffff,CD8:8000ff", "gamma": "0.7", "lo": "0.2"})
    assert r.status_code == 200
    assert r.content == _PNG
    assert r.headers["content-type"] == "image/png"
    # D3: the gateway never interprets the display params, it forwards them
    assert seen["params"]["ch"] == "CK:00ffff,CD8:8000ff"
    assert seen["params"]["gamma"] == "0.7"
    assert seen["path"] == "/biomarker/item1/bio0001/tile/markers/2/5/7.png"
    # cacheability must survive the hop, or every pan re-fetches every tile
    assert r.headers["Cache-Control"] == "public, max-age=86400"
    assert r.headers["ETag"] == 'W/"3"'


def test_tile_proxy_forwards_a_400_rather_than_turning_it_into_a_502(client, monkeypatch):
    async def get_tile(*, base_url, path, params):
        return TileResponse(body=b'{"detail":"unknown marker"}', content_type="application/json",
                            cache_control=None, etag=None, status_code=400)

    monkeypatch.setattr(routes_mod, "get_tile", get_tile)
    r = client.get(f"{_BASE}/item1/biomarker/bio0001/tile/markers/0/0/0.png",
                   params={"ch": "NOPE:00ffff"})
    assert r.status_code == 400


def test_tile_requires_a_session(art_store):
    app = create_app()
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_biomarker_url] = lambda: _BIO
    r = TestClient(app).get(f"{_BASE}/item1/biomarker/bio0001/tile/markers/0/0/0.png")
    assert r.status_code in (401, 422)      # imagery is never served without a Girder session


def test_meta_404_when_the_artifact_does_not_exist(client, monkeypatch):
    async def get_json(*, base_url, path):
        return None

    monkeypatch.setattr(routes_mod, "get_map_json", get_json)
    assert client.get(f"{_BASE}/item1/biomarker/nope/meta").status_code == 404


def test_artifacts_listing_reconciles_a_biomarker_row_from_its_own_worker(
    client, art_store, monkeypatch,
):
    monkeypatch.setattr(routes_mod, "enqueue_map", _fake_enqueue())
    client.post(f"{_BASE}/item1/biomarker", json={"seg_hash": "seg9"})

    polled = {}

    async def map_status(*, base_url, job_id):
        polled["base"] = base_url
        return {"status": "ready", "stage": "done", "progress": 1.0,
                "result": {"art_hash": "bio0001", "n_tiles": 12, "n_cells": 4321, "seconds": 90}}

    async def preprocess_status(*, base_url, job_id):
        raise AssertionError("a biomarker row must not be polled on the preprocess worker")

    monkeypatch.setattr(routes_mod, "map_job_status", map_status)
    monkeypatch.setattr(routes_mod, "get_job_status", preprocess_status)

    rows = client.get(f"{_BASE}/item1/artifacts").json()["artifacts"]
    bio = next(r for r in rows if r["kind"] == "biomarker")
    assert polled["base"] == _BIO           # D2: polled at the biomarker worker, not preprocess
    assert bio["status"] == "ready"
    assert bio["result"]["n_cells"] == 4321
    assert bio["n_items"] == 4321


def test_catalog_is_proxied(client, monkeypatch):
    async def get_json(*, base_url, path):
        assert path == "/biomarker/catalog"
        return {"presets": {"Immune": []}, "markers": ["CD8"]}

    monkeypatch.setattr(routes_mod, "get_map_json", get_json)
    assert client.get("/api/copilot/biomarker/catalog").json()["markers"] == ["CD8"]
