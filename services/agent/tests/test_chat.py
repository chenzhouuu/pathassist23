"""The Responder seam: the message route streams whatever the responder yields,
persists the assembled reply, and emits an `error` frame on backend failure."""

from agent.chat import EchoResponder, build_responder
from agent.common.config import Settings
from agent.gateway.routes import get_responder


class _ScriptedResponder:
    """Yields fixed chunks — stands in for Claude without network access."""

    def __init__(self, chunks):
        self._chunks = chunks

    async def stream_reply(self, *, messages):
        for c in self._chunks:
            yield c


class _BoomResponder:
    async def stream_reply(self, *, messages):
        yield "partial "
        raise RuntimeError("upstream exploded")


def _new_conv(client):
    return client.post("/api/copilot/conversations", json={"item_id": "s"}).json()["id"]


def test_reply_comes_from_the_responder(client):
    client.app.dependency_overrides[get_responder] = lambda: _ScriptedResponder(["Two ", "cells."])
    cid = _new_conv(client)

    # A plain-chat message (no quantify cue) so it streams from the responder, not the planner.
    r = client.post(f"/api/copilot/conversations/{cid}/messages", json={"text": "hello there"})
    assert '"type":"done"' in r.text
    assert "Two cells." in r.text

    turns = client.get(f"/api/copilot/conversations/{cid}").json()["turns"]
    assert [t["role"] for t in turns] == ["user", "assistant"]
    assert turns[1]["text"] == "Two cells."


def test_error_frame_on_backend_failure(client):
    client.app.dependency_overrides[get_responder] = lambda: _BoomResponder()
    cid = _new_conv(client)

    r = client.post(f"/api/copilot/conversations/{cid}/messages", json={"text": "go"})
    assert r.status_code == 200
    assert '"type":"error"' in r.text
    assert '"type":"done"' not in r.text

    # the user turn + the partial assistant reply are both persisted
    turns = client.get(f"/api/copilot/conversations/{cid}").json()["turns"]
    assert [t["role"] for t in turns] == ["user", "assistant"]
    assert turns[1]["text"] == "partial"


def test_default_responder_is_echo(client):
    # The fixture pins EchoResponder; assert the wiring resolves to it.
    assert isinstance(client.app.dependency_overrides[get_responder](), EchoResponder)


def test_build_responder_selects_backend():
    assert isinstance(build_responder(Settings(anthropic_api_key="")), EchoResponder)
    claude = build_responder(
        Settings(anthropic_api_key="sk-ant-test", anthropic_model="claude-sonnet-5")
    )
    assert type(claude).__name__ == "ClaudeResponder"  # constructed, no network call
