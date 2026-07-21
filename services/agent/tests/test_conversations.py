"""Conversation persistence routes, exercised against MemoryStore."""

from starlette.testclient import TestClient

from agent.gateway.app import create_app
from agent.gateway.routes import get_store


def test_create_and_get_conversation(client: TestClient):
    r = client.post("/api/copilot/conversations", json={"item_id": "slide-1"})
    assert r.status_code == 200
    conv = r.json()
    assert conv["item_id"] == "slide-1"
    cid = conv["id"]

    r = client.get(f"/api/copilot/conversations/{cid}")
    assert r.status_code == 200
    assert r.json()["turns"] == []


def test_list_filters_by_item(client: TestClient):
    client.post("/api/copilot/conversations", json={"item_id": "a"})
    client.post("/api/copilot/conversations", json={"item_id": "b"})

    got = client.get("/api/copilot/conversations", params={"item_id": "a"}).json()["conversations"]
    assert [c["item_id"] for c in got] == ["a"]
    assert len(client.get("/api/copilot/conversations").json()["conversations"]) == 2


def test_first_turn_auto_titles_and_counts(client: TestClient):
    """A conversation auto-titles from its first turn's text and counts user+assistant turns.
    (The turn flow is the only write path now; the stub loop yields an assistant answer.)"""
    cid = client.post("/api/copilot/conversations", json={"item_id": "s"}).json()["id"]
    client.post(
        f"/api/copilot/conversations/{cid}/turns", json={"text": "count the nuclei please"}
    )

    listed = client.get("/api/copilot/conversations", params={"item_id": "s"}).json()
    row = listed["conversations"][0]
    assert row["title"] == "count the nuclei please"
    assert row["turn_count"] == 2


def test_delete_conversation(client: TestClient):
    cid = client.post("/api/copilot/conversations", json={"item_id": "s"}).json()["id"]
    assert client.delete(f"/api/copilot/conversations/{cid}").status_code == 204
    assert client.get(f"/api/copilot/conversations/{cid}").status_code == 404
    assert client.delete(f"/api/copilot/conversations/{cid}").status_code == 404  # already gone


def test_delete_scoped_to_owner(store):
    # One app; flip the identity override between phases (the override dict is shared).
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    client = TestClient(app)

    from agent.gateway.auth import require_user

    app.dependency_overrides[require_user] = lambda: {"_id": "owner"}
    cid = client.post("/api/copilot/conversations", json={"item_id": "s"}).json()["id"]

    app.dependency_overrides[require_user] = lambda: {"_id": "intruder"}
    assert client.delete(f"/api/copilot/conversations/{cid}").status_code == 404

    app.dependency_overrides[require_user] = lambda: {"_id": "owner"}
    assert client.get(f"/api/copilot/conversations/{cid}").status_code == 200  # untouched


def test_conversation_scoped_to_owner(store):
    """A conversation created by one user is invisible (404) to another."""
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store

    from agent.gateway.auth import require_user

    app.dependency_overrides[require_user] = lambda: {"_id": "owner"}
    owner = TestClient(app)
    cid = owner.post("/api/copilot/conversations", json={"item_id": "s"}).json()["id"]

    app.dependency_overrides[require_user] = lambda: {"_id": "intruder"}
    intruder = TestClient(app)
    assert intruder.get(f"/api/copilot/conversations/{cid}").status_code == 404


def test_conversations_require_auth(store):
    """Store present but no auth stub and no token → handler is never reached."""
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/api/copilot/conversations").status_code in (401, 422)
