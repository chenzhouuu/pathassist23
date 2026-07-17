from starlette.testclient import TestClient

from agent.gateway.app import create_app


def test_health_ok():
    client = TestClient(create_app())
    resp = client.get("/api/copilot/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "copilot"
