"""Shared test fixtures.

`MemoryStore` is an in-process ConversationStore so route tests exercise the real
handlers without a Postgres. The DB-free health/echo tests don't use it.
"""

import pytest
from starlette.testclient import TestClient

from agent.chat import EchoResponder
from agent.gateway.app import create_app
from agent.gateway.auth import require_user
from agent.gateway.routes import get_responder, get_store
from agent.store.base import ConversationStore

_TS = "2026-07-17T00:00:00+00:00"


class MemoryStore(ConversationStore):
    def __init__(self) -> None:
        self._conv: dict[int, dict] = {}
        self._turns: dict[int, list[dict]] = {}
        self._seq = 0

    @staticmethod
    def _public(conv: dict) -> dict:
        return {k: v for k, v in conv.items() if k != "user"}

    async def create_conversation(self, *, user, item, title):
        self._seq += 1
        cid = self._seq
        self._conv[cid] = {
            "id": cid, "user": user, "item_id": item, "title": title,
            "created_at": _TS, "updated_at": _TS,
        }
        self._turns[cid] = []
        return self._public(self._conv[cid])

    async def list_conversations(self, *, user, item):
        convs = [
            c for c in self._conv.values()
            if c["user"] == user and (item is None or c["item_id"] == item)
        ]
        return [
            {**self._public(c), "turn_count": len(self._turns.get(c["id"], []))}
            for c in reversed(convs)
        ]

    async def get_conversation(self, *, user, conversation_id):
        conv = self._conv.get(conversation_id)
        if conv is None or conv["user"] != user:
            return None
        return self._public(conv)

    async def get_turns(self, *, conversation_id):
        return list(self._turns.get(conversation_id, []))

    async def add_turn(self, *, conversation_id, role, content):
        self._turns.setdefault(conversation_id, []).append(
            {"role": role, "text": content, "created_at": _TS}
        )

    async def set_title_if_empty(self, *, conversation_id, title):
        conv = self._conv.get(conversation_id)
        if conv is not None and not conv.get("title"):
            conv["title"] = title

    async def delete_conversation(self, *, user, conversation_id):
        conv = self._conv.get(conversation_id)
        if conv is None or conv["user"] != user:
            return False
        del self._conv[conversation_id]
        self._turns.pop(conversation_id, None)
        return True


@pytest.fixture
def store() -> MemoryStore:
    return MemoryStore()


@pytest.fixture
def client(store: MemoryStore) -> TestClient:
    """A client with require_user stubbed, the in-memory store injected, and the echo
    responder pinned so replies are deterministic regardless of AGENT_ANTHROPIC_API_KEY."""
    app = create_app()
    app.dependency_overrides[require_user] = lambda: {"_id": "u1", "login": "tester"}
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_responder] = lambda: EchoResponder()
    return TestClient(app)
