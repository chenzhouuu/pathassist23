"""Increment 6c — the case blackboard at the route level.

A completed run's Claim projects onto a per-slide blackboard of deduped current facts.
It surfaces two ways: on GET /conversations/{id} (reload hydration) and on the run_done
SSE frame (live update). Scoped per (user, slide), so it spans threads on the slide.
Exercised against MemoryStore + the deterministic StubPlanner.
"""

import json

from starlette.testclient import TestClient

_ROI = {"x": 10, "y": 20, "width": 300, "height": 240}


def _conv(client: TestClient, item: str = "s") -> int:
    return client.post("/api/copilot/conversations", json={"item_id": item}).json()["id"]


def _approved_digest(client: TestClient, cid: int, roi: dict = _ROI) -> str:
    client.post(f"/api/copilot/conversations/{cid}/messages",
                json={"text": "count the inflammatory cells here", "roi": roi})
    digest = client.get(f"/api/copilot/conversations/{cid}").json()["plans"][-1]["digest"]
    client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/approve")
    return digest


def _run(client: TestClient, cid: int, digest: str):
    return client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/run")


def _last_frame(text: str, etype: str) -> dict | None:
    found = None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        try:
            evt = json.loads(line[len("data:"):].strip())
        except json.JSONDecodeError:
            continue
        if evt.get("type") == etype:
            found = evt
    return found


def test_get_conversation_includes_blackboard(client: TestClient):
    cid = _conv(client)
    # Fresh conversation, no runs → blackboard is present and empty.
    assert client.get(f"/api/copilot/conversations/{cid}").json()["blackboard"] == []
    digest = _approved_digest(client, cid)
    _run(client, cid, digest)
    bb = client.get(f"/api/copilot/conversations/{cid}").json()["blackboard"]
    assert len(bb) == 1
    assert bb[0]["predicate"] == "count"
    assert bb[0]["value"] is not None


def test_run_done_frame_carries_the_updated_blackboard(client: TestClient):
    cid = _conv(client)
    digest = _approved_digest(client, cid)
    done = _last_frame(_run(client, cid, digest).text, "run_done")
    assert done is not None
    assert len(done["blackboard"]) == 1
    assert done["blackboard"][0]["predicate"] == "count"


def test_blackboard_spans_threads_on_the_same_slide(client: TestClient):
    c1 = _conv(client, item="slideX")
    d1 = _approved_digest(client, c1)
    _run(client, c1, d1)
    # A different thread on the same slide sees the fact asserted in the first thread.
    c2 = _conv(client, item="slideX")
    bb = client.get(f"/api/copilot/conversations/{c2}").json()["blackboard"]
    assert len(bb) == 1
    assert bb[0]["conversation_id"] == c1   # fact traces back to its source thread
