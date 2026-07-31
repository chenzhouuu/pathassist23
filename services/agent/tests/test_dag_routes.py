import httpx
import pytest
from starlette.testclient import TestClient

from agent.gateway import routes as routes_mod
from agent.gateway.app import create_app
from agent.gateway.auth import require_user
from agent.gateway.routes import get_preprocess_artifact_store, get_preprocess_url
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
