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
    get_tissue_url,
)
from agent.store import MemoryPreprocessArtifactStore

_USER = {"_id": "u1", "login": "tester"}
_BASE = "/api/copilot/slides"


@pytest.fixture
def art_store():
    return MemoryPreprocessArtifactStore()


@pytest.fixture
def client(art_store):
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_preprocess_url] = lambda: "http://preprocess:8030"
    # These tests are about the pre-Inc-6 direct path, so say so rather than inheriting it from
    # whatever `AGENT_PATHASSIST_PLUGIN_URL` happens to be in the developer's .env. The dispatch
    # path has its own file (test_dispatch_routes.py), which pins this the other way.
    app.dependency_overrides[get_plugin_url] = lambda: None
    return TestClient(app)


def _fake_stage(**acks):
    """A trigger_stage double returning the given per-stage ack dict."""
    async def trigger(*, base_url, stage, item, params, token):
        return acks[stage]
    return trigger


def _raise_409(detail):
    req = httpx.Request("POST", "http://preprocess:8030/patch")
    resp = httpx.Response(409, json={"detail": detail}, request=req)

    async def trigger(*, base_url, stage, item, params, token):
        raise httpx.HTTPStatusError("conflict", request=req, response=resp)
    return trigger


def test_segment_records_segmentation_row(client, art_store, monkeypatch):
    monkeypatch.setattr(routes_mod, "trigger_stage", _fake_stage(segment={
        "job_id": "j1", "seg_hash": "s1", "kind": "segmentation", "status": "queued",
        "segmenter": "hest", "seg_conf_thresh": 0.5,
        "remove_artifacts": False, "remove_holes": False, "remove_penmarks": False,
    }))
    r = client.post(f"{_BASE}/item9/segment", json={"segmenter": "hest"})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "segmentation" and body["art_hash"] == "s1"
    assert body["parent_hash"] is None and body["status"] == "queued"
    assert body["params"]["segmenter"] == "hest"
    assert ("item9", "s1") in art_store._rows


def test_patch_records_row_linked_to_segmentation(client, art_store, monkeypatch):
    monkeypatch.setattr(routes_mod, "trigger_stage", _fake_stage(patch={
        "job_id": "j2", "patch_hash": "p1", "seg_hash": "s1", "kind": "patching",
        "status": "queued", "mag": 20, "patch_size": 256, "overlap": 0,
    }))
    r = client.post(f"{_BASE}/item9/patch", json={"seg_hash": "s1", "mag": 20, "patch_size": 256})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "patching" and body["art_hash"] == "p1"
    assert body["parent_hash"] == "s1" and body["params"]["mag"] == 20


def test_features_records_row_linked_to_patch(client, art_store, monkeypatch):
    monkeypatch.setattr(routes_mod, "trigger_stage", _fake_stage(features={
        "job_id": "j3", "feat_hash": "f1", "patch_hash": "p1", "kind": "features",
        "status": "queued", "encoder": "conch_v1",
    }))
    r = client.post(f"{_BASE}/item9/features", json={"patch_hash": "p1", "encoder": "conch_v1"})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "features" and body["art_hash"] == "f1"
    assert body["parent_hash"] == "p1" and body["params"]["encoder"] == "conch_v1"


def test_patch_before_segment_is_409(client, monkeypatch):
    monkeypatch.setattr(
        routes_mod, "trigger_stage",
        _raise_409("segment this slide first (no segmentation for that seg_hash)"),
    )
    r = client.post(f"{_BASE}/item9/patch", json={"seg_hash": "notbuilt"})
    assert r.status_code == 409 and "segment this slide first" in r.json()["detail"]


def test_patch_requires_seg_hash(client):
    assert client.post(f"{_BASE}/item9/patch", json={}).status_code == 422  # pydantic


def test_segment_requires_configured_service():
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = (
        lambda: MemoryPreprocessArtifactStore()
    )
    app.dependency_overrides[get_preprocess_url] = lambda: None  # unconfigured
    r = TestClient(app).post(f"{_BASE}/item9/segment", json={})
    assert r.status_code == 503


def test_artifacts_reconciles_in_flight_to_ready(client, art_store, monkeypatch):
    monkeypatch.setattr(routes_mod, "trigger_stage", _fake_stage(segment={
        "job_id": "j1", "seg_hash": "s1", "kind": "segmentation", "status": "queued",
        "segmenter": "hest", "seg_conf_thresh": 0.5,
        "remove_artifacts": False, "remove_holes": False, "remove_penmarks": False,
    }))
    client.post(f"{_BASE}/item9/segment", json={"segmenter": "hest"})

    async def fake_status(*, base_url, job_id):
        return {
            "status": "ready", "n_contours": 12,
            "contours_ref": "/c/item9/seg/s1/contours.geojson",
        }
    monkeypatch.setattr(routes_mod, "get_job_status", fake_status)

    r = client.get(f"{_BASE}/item9/artifacts")
    assert r.status_code == 200
    art = r.json()["artifacts"][0]
    assert art["status"] == "ready" and art["n_items"] == 12
    assert art["artifact_ref"].endswith("contours.geojson")


def test_artifacts_empty_for_unknown_slide(client):
    assert client.get(f"{_BASE}/nope/artifacts").json() == {"artifacts": []}


def test_segmentation_contours_proxied(client, monkeypatch):
    gj = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"kind": "tissue"},
         "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 0]]]}},
    ]}

    async def fake_contours(*, base_url, item, seg_hash):
        return gj
    monkeypatch.setattr(routes_mod, "get_contours", fake_contours)
    r = client.get(f"{_BASE}/item9/segmentation/s1/contours")
    assert r.status_code == 200 and r.json()["type"] == "FeatureCollection"


def test_segmentation_contours_404_when_absent(client, monkeypatch):
    async def none_contours(*, base_url, item, seg_hash):
        return None
    monkeypatch.setattr(routes_mod, "get_contours", none_contours)
    assert client.get(f"{_BASE}/item9/segmentation/nope/contours").status_code == 404


# ── delete (Inc 5, ticket 04) ──────────────────────────────────────────────────────


async def _seed(store, item, kind, art_hash, parent=None, params=None):
    return await store.upsert_artifact(
        item=item, kind=kind, art_hash=art_hash, parent_hash=parent, params=params or {},
    )


def _with_map_workers(client):
    """The tissue and biomarker workers own their own kinds' bytes, so a delete of one of those
    rows only reaches a service when their URLs are configured."""
    client.app.dependency_overrides[get_tissue_url] = lambda: "http://tissue:8021"
    client.app.dependency_overrides[get_biomarker_url] = lambda: "http://biomarker:8022"
    return client


def _deleted(calls):
    """A delete_artifact double that records what it was asked to remove."""
    async def delete(*, base_url, kind, item, art_hash, client=None):
        calls.append((base_url, kind, item, art_hash))
    return delete


def _sized(n):
    async def usage(*, base_url, kind, item, art_hash, client=None):
        return n
    return usage


@pytest.mark.anyio
async def test_delete_removes_the_row_and_asks_the_owning_service_for_the_bytes(
    client, art_store, monkeypatch,
):
    await _seed(art_store, "item9", "tissue", "t1")
    calls = []
    monkeypatch.setattr(routes_mod, "delete_artifact", _deleted(calls))
    _with_map_workers(client)

    r = client.delete(f"{_BASE}/item9/artifacts/t1")
    assert r.status_code == 204
    assert await art_store.get_artifact(item="item9", art_hash="t1") is None
    assert calls and calls[0][1:] == ("tissue", "item9", "t1")


@pytest.mark.anyio
async def test_delete_is_refused_while_something_was_built_from_it(client, art_store, monkeypatch):
    await _seed(art_store, "item9", "segmentation", "s1")
    await _seed(art_store, "item9", "patching", "p1", parent="s1", params={"mag": 20})
    calls = []
    monkeypatch.setattr(routes_mod, "delete_artifact", _deleted(calls))

    r = client.delete(f"{_BASE}/item9/artifacts/s1")
    assert r.status_code == 409
    body = r.json()["detail"]
    # Named, not counted — the dialog has to say what is holding it.
    assert body["dependants"] == [{"kind": "patching", "art_hash": "p1", "params": {"mag": 20}}]
    # And nothing was touched: refusing must not have removed the row or the bytes.
    assert await art_store.get_artifact(item="item9", art_hash="s1") is not None
    assert calls == []


@pytest.mark.anyio
async def test_deleting_a_leaf_leaves_its_parent_alone(client, art_store, monkeypatch):
    await _seed(art_store, "item9", "segmentation", "s1")
    await _seed(art_store, "item9", "patching", "p1", parent="s1")
    monkeypatch.setattr(routes_mod, "delete_artifact", _deleted([]))

    assert client.delete(f"{_BASE}/item9/artifacts/p1").status_code == 204
    assert await art_store.get_artifact(item="item9", art_hash="s1") is not None


def test_deleting_an_artifact_this_slide_does_not_have_is_404(client):
    assert client.delete(f"{_BASE}/item9/artifacts/nope").status_code == 404


@pytest.mark.anyio
async def test_a_dead_worker_does_not_fail_a_delete_the_user_cannot_retry(
    client, art_store, monkeypatch,
):
    await _seed(art_store, "item9", "tissue", "t1")

    async def boom(*, base_url, kind, item, art_hash, client=None):
        raise httpx.ConnectError("worker down")
    monkeypatch.setattr(routes_mod, "delete_artifact", boom)
    _with_map_workers(client)

    # The row is already gone, so the artifact is gone as far as the app is concerned. What is left
    # is an orphan directory, which the next build of the same hash overwrites.
    assert client.delete(f"{_BASE}/item9/artifacts/t1").status_code == 204
    assert await art_store.get_artifact(item="item9", art_hash="t1") is None


@pytest.mark.anyio
async def test_usage_answers_size_and_dependants_together(client, art_store, monkeypatch):
    await _seed(art_store, "item9", "segmentation", "s1")
    await _seed(art_store, "item9", "tissue", "t1", parent="s1", params={"backend": "hover-next"})
    monkeypatch.setattr(routes_mod, "artifact_usage", _sized(304_087_040))

    r = client.get(f"{_BASE}/item9/artifacts/s1/usage")
    assert r.status_code == 200
    assert r.json() == {
        "bytes": 304_087_040,
        "dependants": [{"kind": "tissue", "art_hash": "t1", "params": {"backend": "hover-next"}}],
    }


@pytest.mark.anyio
async def test_a_size_the_worker_cannot_give_is_not_a_refusal(client, art_store, monkeypatch):
    await _seed(art_store, "item9", "tissue", "t1")
    monkeypatch.setattr(routes_mod, "artifact_usage", _sized(0))

    r = client.get(f"{_BASE}/item9/artifacts/t1/usage")
    assert r.status_code == 200 and r.json()["bytes"] == 0


# ── nuclei (Inc 5 · 05; moved out in Inc 6 · 05) ───────────────────────────────────
#
# Submitting, stopping and reconciling a nuclei build are no longer this file's subject: nuclei
# dispatches onto the Girder job queue now, and this file's client pins `plugin_url` to None. The
# nine tests that were here are in `test_dispatch_routes.py`, rewritten around what replaced each
# one — a dispatch that writes no row, a refusal raised before the run is queued, and a report that
# creates the row when the bytes exist. What stays below is the read side, which did not move.


def _with_cellvit(client):
    from agent.gateway.routes import get_cellvit_url
    client.app.dependency_overrides[get_cellvit_url] = lambda: "http://cellvit:8020"
    return client


@pytest.mark.anyio
async def test_deleting_a_nuclei_artifact_reaches_the_cellvit_worker(
    client, art_store, monkeypatch,
):
    await _seed(art_store, "item9", "nuclei", "n1")
    calls = []
    monkeypatch.setattr(routes_mod, "delete_artifact", _deleted(calls))
    _with_cellvit(client)

    assert client.delete(f"{_BASE}/item9/artifacts/n1").status_code == 204
    assert calls[0] == ("http://cellvit:8020", "nuclei", "item9", "n1")


# ── the mask (Inc 5, ticket 06) ────────────────────────────────────────────────────


def _fake_tile(seen, *, status_code=200):
    from agent.loop.nuclei_client import TileResponse

    async def get(*, base_url, path, params, client=None):
        seen.append((base_url, path, params))
        return TileResponse(body=b"\x89PNG", content_type="image/png",
                            cache_control="public, max-age=86400", etag='W/"3"',
                            status_code=status_code)
    return get


def test_a_nuclei_tile_is_proxied_with_its_query_and_cache_headers(client, monkeypatch):
    seen = []
    monkeypatch.setattr(routes_mod, "get_nuclei_tile", _fake_tile(seen))
    _with_cellvit(client)

    r = client.get(f"{_BASE}/item9/nuclei/n1/tile/classes/2/3/4.png?alpha=0.6&show=Neoplastic")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    # An unchanged (artifact, coverage, query) tile is immutable, so the worker's caching survives
    # the hop through the gateway.
    assert r.headers["cache-control"] == "public, max-age=86400"
    assert r.headers["etag"] == 'W/"3"'

    base, path, params = seen[0]
    assert base == "http://cellvit:8020"
    assert path == "/nuclei/item9/n1/tile/classes/2/3/4.png"
    # Forwarded verbatim: the gateway does not know what a class is.
    assert params == {"alpha": "0.6", "show": "Neoplastic"}


def test_a_bad_class_spec_stays_a_400_rather_than_becoming_a_502(client, monkeypatch):
    """A typo in the class list is the panel's error to show, not a broken worker."""
    seen = []
    monkeypatch.setattr(routes_mod, "get_nuclei_tile", _fake_tile(seen, status_code=400))
    _with_cellvit(client)

    r = client.get(f"{_BASE}/item9/nuclei/n1/tile/classes/0/0/0.png?show=Tumour")
    assert r.status_code == 400


def test_a_tile_without_a_configured_worker_is_503(client):
    r = client.get(f"{_BASE}/item9/nuclei/n1/tile/classes/0/0/0.png")
    assert r.status_code == 503


# ── biomarker is built on nuclei (Inc 5, ticket 09) ────────────────────────────────


def _with_biomarker(client):
    client.app.dependency_overrides[get_biomarker_url] = lambda: "http://biomarker:8022"
    return client


@pytest.mark.anyio
async def test_a_phenotype_map_records_the_cells_it_is_a_map_of_as_its_parent(
    client, art_store, monkeypatch,
):
    """Not the segmentation. A phenotype is an attribute of a nucleus: change the cells and every
    number changes, whereas the tissue mask only decided which tiles were worth visiting."""
    seen = []

    async def enqueue(*, base_url, item, seg_hash, bbox, token, nuclei_hash=None, client=None):
        seen.append({"seg_hash": seg_hash, "nuclei_hash": nuclei_hash})
        return {"art_hash": "b1", "job_id": "j1", "status": "queued", "scope": "slide"}
    monkeypatch.setattr(routes_mod, "enqueue_map", enqueue)
    _with_biomarker(client)

    r = client.post(f"{_BASE}/item9/biomarker",
                    json={"seg_hash": "s1", "nuclei_hash": "n1", "bbox": None})
    assert r.status_code == 200
    assert seen[0] == {"seg_hash": "s1", "nuclei_hash": "n1"}
    row = r.json()
    assert row["parent_hash"] == "n1"
    # The segmentation is still recorded — as provenance, where it belongs.
    assert row["params"]["seg_hash"] == "s1"


@pytest.mark.anyio
async def test_deleting_the_nuclei_a_phenotype_map_stands_on_is_refused(
    client, art_store, monkeypatch,
):
    """The parent edge is what makes ticket 04's refusal cover this at all."""
    await _seed(art_store, "item9", "nuclei", "n1")
    await _seed(art_store, "item9", "biomarker", "b1", parent="n1",
                params={"scope": "slide"})
    _with_cellvit(client)
    _with_map_workers(client)

    r = client.delete(f"{_BASE}/item9/artifacts/n1")
    assert r.status_code == 409
    dependants = r.json()["detail"]["dependants"]
    assert [d["kind"] for d in dependants] == ["biomarker"]


@pytest.mark.anyio
async def test_a_map_built_before_the_switch_still_names_a_parent(
    client, art_store, monkeypatch,
):
    """Old rows point at the segmentation and keep working; only new builds take the new path."""
    async def enqueue(*, base_url, item, seg_hash, bbox, token, nuclei_hash=None, client=None):
        return {"art_hash": "b2", "job_id": "j2", "status": "queued", "scope": "region"}
    monkeypatch.setattr(routes_mod, "enqueue_map", enqueue)
    _with_biomarker(client)

    r = client.post(f"{_BASE}/item9/biomarker", json={"seg_hash": "s1"})
    assert r.json()["parent_hash"] == "s1"
