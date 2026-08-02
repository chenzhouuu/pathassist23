"""Shared test fixtures.

`MemoryStore` is an in-process ConversationStore so route tests exercise the real
handlers without a Postgres. The DB-free health test doesn't use it.
"""

import pytest
from starlette.testclient import TestClient

from agent.gateway.app import create_app
from agent.gateway.auth import require_user
from agent.gateway.routes import get_agent, get_store
from agent.loop import StubAgentLoop
from agent.store.base import ConversationStore

_TS = "2026-07-17T00:00:00+00:00"


class MemoryStore(ConversationStore):
    def __init__(self) -> None:
        self._conv: dict[int, dict] = {}
        self._turns: dict[int, list[dict]] = {}
        self._seq = 0
        self._turn_seq = 0

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

    async def add_turn(self, *, conversation_id, role, content, roi=None):
        self._turn_seq += 1
        tid = self._turn_seq
        self._turns.setdefault(conversation_id, []).append(
            {"id": tid, "role": role, "text": content, "roi": roi, "created_at": _TS}
        )
        return tid

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
    """A client with require_user stubbed, the in-memory store injected, and the stub agent
    loop pinned so behavior is deterministic and keyless regardless of
    AGENT_ANTHROPIC_API_KEY (the real SDK loop is never spawned)."""
    app = create_app()
    app.dependency_overrides[require_user] = lambda: {"_id": "u1", "login": "tester"}
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_agent] = lambda: StubAgentLoop()
    return TestClient(app)


# ── One planner, one seam (Inc 6 · 08) ────────────────────────────────────────────────
#
# Every submission route goes through `_plan_and_dispatch`, which asks `_addresser` what each step
# would be called. Doubling that one factory replaces the four per-kind `_*_address` doubles the
# route tests used to keep, and it is the seam that matters: what the *services* answer is their own
# suites' business, and what this one tests is what the gateway does with the answers.


def _fake_addresser(hashes=None, seen=None, extra=None):
    """A stand-in for `routes._addresser`. `seen` records `(kind, params)` in the order asked."""
    names = {
        "segmentation": "seg-1", "patching": "pat-1", "features": "feat-1",
        "prediction": "pred-1", "nuclei": "nuc-1", "tissue": "tis-1", "biomarker": "bio-1",
        **(hashes or {}),
    }

    def factory(urls):
        async def address(kind, params):
            if seen is not None:
                seen.append((kind, dict(params)))
            resolved = {**(extra or {}).get(kind, {})}
            return {"kind": kind, "art_hash": names[kind], "params": resolved}
        return address
    return factory


def _fake_chain(job_id="girder-job-1", chain_id="c1", seen=None):
    """A stand-in for `routes.dispatch_chain`, recording exactly what went on the queue."""
    async def dispatch(*, plugin_url, item, steps, token, label=None, **kw):
        if seen is not None:
            seen.append({"item": item, "label": label, "steps": steps})
        return {"chainId": chain_id, "jobId": job_id, "queue": "pathassist",
                "steps": [{"kind": s["kind"], "artHash": s["artHash"]} for s in steps]}
    return dispatch


@pytest.fixture
def plan_seam(monkeypatch):
    """Both seams at once, since no submission route uses one without the other.

    `seam(seen=[], addressed=[], hashes={}, extra={})` patches `routes._addresser` and
    `routes.dispatch_chain` and hands back the lists it will fill.
    """
    from agent.gateway import routes as routes_mod

    def seam(seen=None, addressed=None, hashes=None, extra=None):
        monkeypatch.setattr(routes_mod, "_addresser",
                            _fake_addresser(hashes=hashes, seen=addressed, extra=extra))
        monkeypatch.setattr(routes_mod, "dispatch_chain", _fake_chain(seen=seen))
    return seam
