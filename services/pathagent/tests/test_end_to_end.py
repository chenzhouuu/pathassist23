# tests/test_end_to_end.py
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(redis_conn, job_redis, tmp_cache):
    # job_redis makes the inline fake job write status to the SAME fakeredis the app reads.
    from pathagent.gateway.app import create_app
    from pathagent.gateway.auth import require_user
    from pathagent.gateway.queue import PreprocessQueue

    app = create_app(redis_conn=redis_conn, queue=PreprocessQueue(redis_conn, is_async=False))
    app.dependency_overrides[require_user] = lambda: {"_id": "u1"}
    return TestClient(app)


def test_preprocess_to_ready(client, tmp_cache):
    from pathagent.common.cache_keys import cache_paths

    body = {"backbone": {"patchEncoder": "conch_v1", "mag": 20, "patchSize": 256}, "slidechat": True}
    resp = client.post("/api/agent/cases/item77/preprocess", json=body)
    cache_key = resp.json()["cacheKey"]

    # is_async=False ran the fake job inline during enqueue, so status is already ready.
    st = client.get("/api/agent/cases/item77/status", params={"cacheKey": cache_key})
    assert st.json()["status"] == "ready"
    assert st.json()["ready"]["features"] is True
    assert cache_paths(cache_key).manifest.exists()
