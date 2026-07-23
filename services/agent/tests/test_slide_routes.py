import pytest
from starlette.testclient import TestClient

from agent.gateway import routes as routes_mod
from agent.gateway.app import create_app
from agent.gateway.auth import require_user
from agent.gateway.routes import get_preprocess_url, get_slide_index_store
from agent.store import MemorySlideIndexStore

_USER = {"_id": "u1", "login": "tester"}


@pytest.fixture
def index_store():
    return MemorySlideIndexStore()


@pytest.fixture
def client(index_store):
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_slide_index_store] = lambda: index_store
    app.dependency_overrides[get_preprocess_url] = lambda: "http://preprocess:8030"
    return TestClient(app)


def _fake_trigger(returns):
    async def trigger(*, base_url, item, params, token):
        return {
            "job_id": "j1", "params_hash": "h1", "status": "queued",
            "encoder": params.get("encoder", "conch_v15"), "mag": 20,
            "patch_size": 256, "segmenter": "hest", **returns,
        }
    return trigger


def test_preprocess_requires_configured_service():
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_slide_index_store] = lambda: MemorySlideIndexStore()
    app.dependency_overrides[get_preprocess_url] = lambda: None  # unconfigured
    r = TestClient(app).post("/api/copilot/slides/item9/preprocess", json={})
    assert r.status_code == 503


def test_preprocess_enqueues_and_records_queued_row(client, index_store, monkeypatch):
    monkeypatch.setattr(routes_mod, "trigger_preprocess", _fake_trigger({}))
    r = client.post("/api/copilot/slides/item9/preprocess", json={"encoder": "conch_v1"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "queued" and body["params_hash"] == "h1"
    assert body["encoder"] == "conch_v1" and body["job_id"] == "j1"
    # the durable row exists
    rows = index_store._rows
    assert (("item9", "h1") in rows) and rows[("item9", "h1")]["status"] == "queued"


def test_index_reconciles_running_row_to_ready(client, index_store, monkeypatch):
    monkeypatch.setattr(routes_mod, "trigger_preprocess", _fake_trigger({}))
    client.post("/api/copilot/slides/item9/preprocess", json={"encoder": "conch_v1"})

    async def fake_status(*, base_url, job_id):
        return {"status": "ready", "n_patches": 16, "features_ref": "/c/item9/h1/features.h5"}
    monkeypatch.setattr(routes_mod, "get_job_status", fake_status)

    r = client.get("/api/copilot/slides/item9/index")
    assert r.status_code == 200
    idx = r.json()["indexes"][0]
    assert idx["status"] == "ready" and idx["n_patches"] == 16
    assert idx["feature_ref"].endswith("features.h5")


def test_index_reconciles_failure(client, index_store, monkeypatch):
    monkeypatch.setattr(routes_mod, "trigger_preprocess", _fake_trigger({}))
    client.post("/api/copilot/slides/item9/preprocess", json={})

    async def fake_status(*, base_url, job_id):
        return {"status": "failed", "error": "no slide on this Girder"}
    monkeypatch.setattr(routes_mod, "get_job_status", fake_status)

    idx = client.get("/api/copilot/slides/item9/index").json()["indexes"][0]
    assert idx["status"] == "failed" and "no slide" in idx["error"]


def test_index_empty_for_unknown_slide(client):
    assert client.get("/api/copilot/slides/nope/index").json() == {"indexes": []}
