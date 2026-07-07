import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(redis_conn):
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
