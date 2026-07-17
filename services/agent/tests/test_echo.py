from starlette.testclient import TestClient

from agent.gateway.app import create_app
from agent.gateway.auth import require_user


def _authed_client() -> TestClient:
    """A client whose require_user is stubbed, so we exercise the endpoint itself."""
    app = create_app()
    app.dependency_overrides[require_user] = lambda: {"login": "tester"}
    return TestClient(app)


def test_echo_streams_words_in_order():
    client = _authed_client()
    resp = client.post("/api/copilot/echo", json={"text": "hello brave world"})
    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers["content-type"]
    body = resp.text
    for word in ("hello", "brave", "world"):
        assert word in body
    assert '"type":"done"' in body


def test_echo_rejects_empty_text():
    client = _authed_client()
    resp = client.post("/api/copilot/echo", json={"text": ""})
    assert resp.status_code == 422  # Field(min_length=1)


def test_echo_requires_girder_token():
    # No dependency override and no Girder-Token header → the required header is missing,
    # so the request never reaches the handler. Proves auth is enforced.
    client = TestClient(create_app(), raise_server_exceptions=False)
    resp = client.post("/api/copilot/echo", json={"text": "hi"})
    assert resp.status_code in (401, 422)
