import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(redis_conn, monkeypatch):
    from pathagent.common.registry import Registry
    from pathagent.gateway.app import create_app
    from pathagent.gateway.auth import require_user
    from pathagent.gateway.queue import PreprocessQueue
    from pathagent.worker import fake_preprocess

    # Don't run the real job body during route tests.
    monkeypatch.setattr(fake_preprocess, "run_fake_preprocess", lambda *a: None)
    app = create_app(redis_conn=redis_conn, queue=PreprocessQueue(redis_conn, is_async=False))
    app.dependency_overrides[require_user] = lambda: {"_id": "u1"}
    c = TestClient(app)
    c.registry = Registry(redis_conn)  # handle for assertions
    return c


def _body():
    return {
        "backbone": {"patchEncoder": "conch_v1", "mag": 20, "patchSize": 256},
        "slidechat": True,
    }


def test_preprocess_enqueues_and_returns_cache_key(client):
    resp = client.post("/api/agent/cases/item42/preprocess", json=_body())
    assert resp.status_code == 202
    data = resp.json()
    assert data["cacheKey"].startswith("item42-")
    assert data["status"] == "queued"


def test_status_reflects_registry(client):
    resp = client.post("/api/agent/cases/item42/preprocess", json=_body())
    cache_key = resp.json()["cacheKey"]
    st = client.get("/api/agent/cases/item42/status", params={"cacheKey": cache_key})
    assert st.status_code == 200
    assert st.json()["status"] == "queued"


def test_status_unknown_key(client):
    st = client.get("/api/agent/cases/item42/status", params={"cacheKey": "nope"})
    assert st.status_code == 200
    assert st.json()["status"] == "error"


def test_preprocess_rejects_unsafe_item_id(client):
    # "item..x" contains ".." which _validate_segment rejects (path-traversal guard).
    # FastAPI path params can't contain literal "/", so we use a ".."-bearing segment
    # to deterministically exercise compute_cache_key's ValueError -> 400 handling.
    resp = client.post("/api/agent/cases/item..x/preprocess", json=_body())
    assert resp.status_code == 400
    assert resp.json()["detail"] == "invalid itemId"


def _classifier_result():
    from pathagent.common.schemas import ClassifierResult

    return ClassifierResult(
        model="brca_abmil",
        prediction="ILC",
        confidence=0.88,
        idc_prob=0.12,
        ilc_prob=0.88,
        num_patches=9,
    )


def test_get_classifier_returns_result(client, tmp_cache):
    from pathagent.common.cache_keys import cache_paths

    key = "item42-deadbeef1234"
    paths = cache_paths(key)
    paths.root.mkdir(parents=True, exist_ok=True)
    paths.classifier.write_text(_classifier_result().model_dump_json(by_alias=True))

    resp = client.get("/api/agent/cases/item42/classifier", params={"cacheKey": key})
    assert resp.status_code == 200
    assert resp.json()["prediction"] == "ILC"


def test_get_classifier_missing_file(client, tmp_cache):
    resp = client.get(
        "/api/agent/cases/item42/classifier", params={"cacheKey": "item42-notthere99"}
    )
    assert resp.status_code == 404


def test_get_classifier_rejects_unsafe_cache_key(client, tmp_cache):
    resp = client.get("/api/agent/cases/item42/classifier", params={"cacheKey": "../x"})
    assert resp.status_code == 400
