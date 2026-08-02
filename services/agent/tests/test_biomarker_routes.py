"""Gateway control plane + authenticated tile proxy for the Inc 3b marker map.

Since Inc 6 · 06 the control plane is a **dispatch**: the address is asked of the biomarker
service, the run becomes a Girder job, and no artifact row exists until the driver reports its
bytes (D9). What is unchanged, and still covered here, is the read side — the catalog, the meta
and the tile proxy.
"""

import httpx
import pytest
from starlette.testclient import TestClient

from agent.gateway import routes as routes_mod
from agent.gateway.app import create_app
from agent.gateway.auth import require_user
from agent.gateway.routes import (
    get_biomarker_url,
    get_plugin_url,
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
    app.dependency_overrides[get_plugin_url] = lambda: "http://girder:8080/api/v1"
    return TestClient(app)


@pytest.fixture
def unconfigured_client(art_store):
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_biomarker_url] = lambda: None
    app.dependency_overrides[get_plugin_url] = lambda: "http://girder:8080/api/v1"
    return TestClient(app)


def _address(art_hash="bio0001"):
    """A `/biomarker/hash` double: the service naming a run, enqueuing nothing."""
    async def addressed(biomarker_url, seg_hash, nuclei_hash):
        return {"kind": "biomarker", "art_hash": art_hash, "nuclei_hash": nuclei_hash}
    return addressed


def _dispatch(job_id="girder-job-7", seen=None):
    async def dispatch(*, plugin_url, kind, item, art_hash, params, token, **kw):
        if seen is not None:
            seen.append({"kind": kind, "item": item, "art_hash": art_hash, "params": params})
        return {"jobId": job_id, "celeryTaskId": "t1", "kind": kind,
                "item": item, "artHash": art_hash, "queue": "pathassist"}
    return dispatch


def _rows(store, item="item1"):
    import asyncio
    return asyncio.run(store.list_artifacts(item=item))


def test_a_dispatched_marker_run_writes_no_row(client, monkeypatch):
    monkeypatch.setattr(routes_mod, "_biomarker_address", _address())
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch("girder-job-7"))

    r = client.post(f"{_BASE}/item1/biomarker",
                    json={"seg_hash": "seg9", "nuclei_hash": "nuc9",
                          "bbox": {"x": 0, "y": 0, "width": 2048, "height": 2048}})
    assert r.status_code == 200
    assert r.json()["art_hash"] == "bio0001"
    assert r.json()["scope"] == "region"
    assert r.json()["girder_job_id"] == "girder-job-7"
    assert client.get(f"{_BASE}/item1/artifacts").json()["artifacts"] == []


def test_the_cells_and_the_contours_both_travel_to_the_run(client, monkeypatch):
    seen = []
    monkeypatch.setattr(routes_mod, "_biomarker_address", _address())
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch(seen=seen))

    client.post(f"{_BASE}/item1/biomarker", json={"seg_hash": "seg9", "nuclei_hash": "nuc9"})
    assert seen == [{"kind": "biomarker", "item": "item1", "art_hash": "bio0001",
                     "params": {"bbox": None, "seg_hash": "seg9", "nuclei_hash": "nuc9",
                                "scope": "slide"}}]


def test_the_row_appears_when_the_run_reports_its_bytes(client, art_store, monkeypatch):
    """The parent is the NUCLEI (Inc 5 · D9): a phenotype is an attribute of a cell, so change the
    cells and every number changes. The segmentation only ever chose which tiles to visit, and is
    kept in params as provenance. (It was the parent until Inc 5 — see design §11 corr. 1.)"""
    monkeypatch.setattr(routes_mod, "_biomarker_address", _address())
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch("girder-job-7"))
    client.post(f"{_BASE}/item1/biomarker", json={"seg_hash": "seg9", "nuclei_hash": "nuc9"})

    r = client.post(
        f"{_BASE}/item1/artifacts/bio0001/result",
        json={"status": "ready", "kind": "biomarker", "girder_job_id": "girder-job-7",
              "params": {"seg_hash": "seg9", "nuclei_hash": "nuc9", "scope": "slide"},
              "result": {"art_hash": "bio0001", "n_tiles": 12, "n_cells": 4321, "seconds": 90}},
    )
    assert r.status_code == 200

    row = next(x for x in _rows(art_store) if x["kind"] == "biomarker")
    assert row["parent_hash"] == "nuc9"
    assert row["params"]["seg_hash"] == "seg9"
    assert row["n_items"] == 4321
    assert row["result"]["n_cells"] == 4321
    assert row["girder_job_id"] == "girder-job-7"


def test_a_stopped_run_creates_its_row_too(client, art_store, monkeypatch):
    """Cooperative stop is new for this kind in 06 — so a stopped marker map has to land like a
    stopped tissue map: a complete map of a smaller area, with what is left to do."""
    monkeypatch.setattr(routes_mod, "_biomarker_address", _address())
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch())
    client.post(f"{_BASE}/item1/biomarker", json={"seg_hash": "seg9", "nuclei_hash": "nuc9"})

    client.post(
        f"{_BASE}/item1/artifacts/bio0001/result",
        json={"status": "cancelled", "kind": "biomarker",
              "params": {"seg_hash": "seg9", "nuclei_hash": "nuc9"},
              "result": {"n_tiles": 3, "n_cells": 812, "stopped": True, "remaining": 9}},
    )
    row = next(x for x in _rows(art_store) if x["kind"] == "biomarker")
    assert row["status"] == "cancelled"
    assert row["error"] is None
    assert row["n_items"] == 812
    assert row["result"]["remaining"] == 9
    assert row["parent_hash"] == "nuc9"


def test_seg_hash_is_required(client):
    assert client.post(f"{_BASE}/item1/biomarker", json={}).status_code == 422


def test_a_map_without_the_cells_it_is_a_map_of_is_refused_before_it_is_queued(
    client, monkeypatch,
):
    """The worker refuses too, but a refusal that only exists inside a queued job is one nobody
    sees until they go looking. This is the sentence the catalog form can show."""
    dispatched = []
    monkeypatch.setattr(routes_mod, "_biomarker_address", _address())
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch(seen=dispatched))

    r = client.post(f"{_BASE}/item1/biomarker", json={"seg_hash": "seg9"})
    assert r.status_code == 400
    assert "nuclei" in r.json()["detail"]
    assert dispatched == []


def test_biomarker_without_the_job_queue_is_refused(art_store):
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_biomarker_url] = lambda: _BIO
    app.dependency_overrides[get_plugin_url] = lambda: None

    r = TestClient(app).post(f"{_BASE}/item1/biomarker",
                             json={"seg_hash": "seg9", "nuclei_hash": "nuc9"})
    assert r.status_code == 503


def test_unconfigured_service_is_503_not_a_crash(unconfigured_client):
    r = unconfigured_client.post(f"{_BASE}/item1/biomarker",
                                 json={"seg_hash": "seg9", "nuclei_hash": "nuc9"})
    assert r.status_code == 503
    assert "AGENT_BIOMARKER_SERVICE_URL" in r.json()["detail"]


def test_worker_refusals_are_forwarded_verbatim():
    """Asserted on the mapping rather than through the route: the httpx client is constructed
    inside `_biomarker_address`, so doubling that seam would double the mapping with it."""
    req = httpx.Request("POST", f"{_BIO}/biomarker/hash")
    resp = httpx.Response(503, json={"detail": "needs the GPU worker"}, request=req)
    mapped = routes_mod._map_error(httpx.HTTPStatusError("no weights", request=req, response=resp))
    assert mapped.status_code == 503
    assert mapped.detail == "needs the GPU worker"


def test_a_biomarker_service_that_is_down_dispatches_nothing(client, monkeypatch):
    dispatched = []

    async def addressed(*_a, **_kw):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(routes_mod, "_biomarker_address", addressed)
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch(seen=dispatched))
    with pytest.raises(httpx.ConnectError):
        client.post(f"{_BASE}/item1/biomarker", json={"seg_hash": "seg9", "nuclei_hash": "n"})
    assert dispatched == []


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


def test_catalog_is_proxied(client, monkeypatch):
    async def get_json(*, base_url, path):
        assert path == "/biomarker/catalog"
        return {"presets": {"Immune": []}, "markers": ["CD8"]}

    monkeypatch.setattr(routes_mod, "get_map_json", get_json)
    assert client.get("/api/copilot/biomarker/catalog").json()["markers"] == ["CD8"]
