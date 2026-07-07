import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(redis_conn):
    from pathagent.gateway.app import create_app
    from pathagent.gateway.auth import require_user
    from pathagent.gateway.queue import PreprocessQueue

    app = create_app(redis_conn=redis_conn, queue=PreprocessQueue(redis_conn, is_async=False))
    app.dependency_overrides[require_user] = lambda: {"_id": "u1"}
    return TestClient(app)


@pytest.fixture
def unauth_client(redis_conn):
    """A client whose require_user is NOT overridden — exercises the real auth gate."""
    from pathagent.gateway.app import create_app
    from pathagent.gateway.queue import PreprocessQueue

    app = create_app(redis_conn=redis_conn, queue=PreprocessQueue(redis_conn, is_async=False))
    return TestClient(app)


def test_query_stub_streams_events(client):
    resp = client.post("/api/agent/query", json={"itemId": "x", "question": "?"})
    assert resp.status_code == 200
    body = resp.text
    assert "route" in body and "navigate" in body and "final" in body


def test_heatmap_stub(client):
    resp = client.get("/api/agent/cases/x/heatmap/t1")
    assert resp.status_code == 200
    assert resp.json()["taskId"] == "t1"


def test_query_stub_requires_auth(unauth_client):
    resp = unauth_client.post("/api/agent/query", json={"itemId": "x", "question": "?"})
    assert resp.status_code in (401, 422)


def test_heatmap_stub_requires_auth(unauth_client):
    resp = unauth_client.get("/api/agent/cases/x/heatmap/t1")
    assert resp.status_code in (401, 422)
