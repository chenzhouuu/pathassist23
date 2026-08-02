"""Gateway control plane + authenticated tile proxy for the Inc 4 tissue map.

Since Inc 6 · 06 the control plane is a **dispatch**: the address is asked of the tissue service,
the run becomes a Girder job, and no artifact row is written until the driver reports its bytes
(D9). The stop button went with it — a run is stopped from the Runs list, which revokes the job.
What is unchanged, and still covered here, is the read side: the catalog, the meta, the stats and
the tile proxy.
"""

import httpx
import pytest
from starlette.testclient import TestClient

from agent.gateway import routes as routes_mod
from agent.gateway.app import create_app
from agent.gateway.auth import require_user
from agent.gateway.routes import (
    get_plugin_url,
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
_REGION = {"x": 0, "y": 0, "width": 2048, "height": 2048}


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
    app.dependency_overrides[get_plugin_url] = lambda: "http://girder:8080/api/v1"
    return TestClient(app)


@pytest.fixture
def unconfigured_client(art_store):
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_tissue_url] = lambda: None
    app.dependency_overrides[get_plugin_url] = lambda: "http://girder:8080/api/v1"
    return TestClient(app)


def _address(art_hash="tis0001", backend="bcss_fcn_unet"):
    """A `/tissue/hash` double: names the run and resolves the backend, enqueuing nothing."""
    async def addressed(tissue_url, seg_hash, asked):
        return {"kind": "tissue", "art_hash": art_hash, "backend": asked or backend}
    return addressed


def _dispatch(job_id="girder-job-4", seen=None):
    async def dispatch(*, plugin_url, kind, item, art_hash, params, token, **kw):
        if seen is not None:
            seen.append({"kind": kind, "item": item, "art_hash": art_hash, "params": params})
        return {"jobId": job_id, "celeryTaskId": "t1", "kind": kind,
                "item": item, "artHash": art_hash, "queue": "pathassist"}
    return dispatch


def _rows(store, item="item1"):
    import asyncio
    return asyncio.run(store.list_artifacts(item=item))


# ── dispatch (Inc 6 · 06) ──────────────────────────────────────────────────────────


def test_a_dispatched_tissue_run_writes_no_row(client, monkeypatch):
    """Same rule as nuclei: a row is the claim that bytes exist, and at submit none do."""
    monkeypatch.setattr(routes_mod, "_tissue_address", _address())
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch("girder-job-4"))

    r = client.post(f"{_BASE}/item1/tissue", json={"seg_hash": "seg9", "bbox": _REGION})
    assert r.status_code == 200
    assert r.json()["art_hash"] == "tis0001"
    assert r.json()["scope"] == "region"
    assert r.json()["girder_job_id"] == "girder-job-4"
    assert client.get(f"{_BASE}/item1/artifacts").json()["artifacts"] == []


def test_the_run_carries_the_backend_the_service_resolved_not_the_one_asked_for(
    client, monkeypatch,
):
    """An unnamed backend lands on this deployment's default, and the row has to say which model
    produced its numbers — so what travels is the service's answer."""
    seen = []
    monkeypatch.setattr(routes_mod, "_tissue_address", _address(backend="bcss_fcn_unet"))
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch(seen=seen))

    client.post(f"{_BASE}/item1/tissue", json={"seg_hash": "seg9"})
    assert seen == [{"kind": "tissue", "item": "item1", "art_hash": "tis0001",
                     "params": {"bbox": None, "seg_hash": "seg9", "scope": "slide",
                                "backend": "bcss_fcn_unet"}}]


def test_a_named_backend_reaches_the_service_that_computes_the_address(client, monkeypatch):
    seen = {}

    async def addressed(tissue_url, seg_hash, backend):
        seen.update(seg_hash=seg_hash, backend=backend)
        return {"kind": "tissue", "art_hash": "x", "backend": backend}

    monkeypatch.setattr(routes_mod, "_tissue_address", addressed)
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch())
    client.post(f"{_BASE}/item1/tissue", json={"seg_hash": "s", "backend": "uni_decoder"})
    assert seen == {"seg_hash": "s", "backend": "uni_decoder"}


def test_the_row_appears_when_the_run_reports_its_bytes(client, art_store, monkeypatch):
    """…and it is parented on the segmentation. Unlike nuclei's, a tissue map's mask is not merely
    which tiles were worth visiting: everything outside the contours is masked out of the raster,
    so deleting the segmentation would invalidate this map."""
    monkeypatch.setattr(routes_mod, "_tissue_address", _address())
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch("girder-job-4"))
    client.post(f"{_BASE}/item1/tissue", json={"seg_hash": "seg9"})

    r = client.post(
        f"{_BASE}/item1/artifacts/tis0001/result",
        json={"status": "ready", "kind": "tissue", "girder_job_id": "girder-job-4",
              "params": {"scope": "slide", "seg_hash": "seg9", "backend": "bcss_fcn_unet"},
              "result": {"art_hash": "tis0001", "n_core_tiles": 47, "covered_mm2": 12.4,
                         "tsr": 0.418, "fraction": {"Tumour": 0.43}}},
    )
    assert r.status_code == 200

    row = next(x for x in _rows(art_store) if x["kind"] == "tissue")
    assert row["parent_hash"] == "seg9"
    assert row["n_items"] == 47
    assert row["result"]["tsr"] == 0.418
    assert row["girder_job_id"] == "girder-job-4"


def test_a_stopped_run_creates_its_row_too(client, art_store, monkeypatch):
    """It left a smaller but complete map, so its numbers are carried exactly as a finished
    build's are — and `remaining` is what makes starting again a resume."""
    monkeypatch.setattr(routes_mod, "_tissue_address", _address())
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch())
    client.post(f"{_BASE}/item1/tissue", json={"seg_hash": "seg9"})

    client.post(
        f"{_BASE}/item1/artifacts/tis0001/result",
        json={"status": "cancelled", "kind": "tissue", "params": {"seg_hash": "seg9"},
              "result": {"n_core_tiles": 140, "covered_mm2": 36.9, "tsr": 0.51,
                         "stopped": True, "remaining": 294}},
    )
    row = next(x for x in _rows(art_store) if x["kind"] == "tissue")
    assert row["status"] == "cancelled"
    assert row["error"] is None
    assert row["n_items"] == 140
    assert row["result"]["remaining"] == 294
    assert row["parent_hash"] == "seg9"


def test_there_is_no_stop_route_on_the_row_any_more(client):
    """Stop is the Runs list revoking the Girder job. A second stop button addressing the artifact
    would be a second answer to the same question, and one of them would be stale."""
    assert client.post(f"{_BASE}/item1/tissue/tis0001/cancel").status_code == 404


def test_tissue_without_the_job_queue_is_refused(art_store):
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_tissue_url] = lambda: _TISSUE
    app.dependency_overrides[get_plugin_url] = lambda: None

    r = TestClient(app).post(f"{_BASE}/item1/tissue", json={"seg_hash": "seg9"})
    assert r.status_code == 503


def test_unconfigured_service_is_a_503_with_the_env_var_named(unconfigured_client):
    r = unconfigured_client.post(f"{_BASE}/item1/tissue", json={"seg_hash": "seg9"})
    assert r.status_code == 503
    assert "AGENT_TISSUE_SERVICE_URL" in r.json()["detail"]


def test_a_worker_refusal_keeps_the_workers_own_words():
    """The address call reaches the same service, so its refusals still have to arrive as its
    own. Asserted on the mapping rather than through the route, because the route's httpx client
    is constructed inside `_tissue_address` and doubling that seam would double the mapping too."""
    exc = httpx.HTTPStatusError(
        "no weights", request=httpx.Request("POST", "/tissue/hash"),
        response=httpx.Response(503, json={"detail": "tissue segmentation needs the GPU"}),
    )
    mapped = routes_mod._tissue_error(exc)
    assert mapped.status_code == 503
    assert "GPU" in mapped.detail


def test_a_tissue_service_that_is_down_dispatches_nothing(client, monkeypatch):
    """Nothing can name the artifact, so nothing is queued — the same order `start_segment` uses,
    and the reason a job nobody will ever pick up cannot be created."""
    dispatched = []

    async def addressed(*_a, **_kw):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(routes_mod, "_tissue_address", addressed)
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch(seen=dispatched))
    with pytest.raises(httpx.ConnectError):
        client.post(f"{_BASE}/item1/tissue", json={"seg_hash": "s"})
    assert dispatched == []


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
