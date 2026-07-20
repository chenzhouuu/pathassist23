"""Increment 6b — content-addressed cache at the route level.

An identical approved plan (same slide + ROI + steps + registry → same digest) reuses the
prior run's result instead of re-invoking the tools. Scoped per (user, slide), so reuse
works within a thread and across threads on the same slide. Exercised against MemoryStore
+ the deterministic StubPlanner.
"""

from starlette.testclient import TestClient

_ROI = {"x": 10, "y": 20, "width": 300, "height": 240}
_ROI2 = {"x": 0, "y": 0, "width": 128, "height": 128}


def _conv(client: TestClient, item: str = "s") -> int:
    return client.post("/api/copilot/conversations", json={"item_id": item}).json()["id"]


def _approved_digest(client: TestClient, cid: int, roi: dict = _ROI) -> str:
    client.post(f"/api/copilot/conversations/{cid}/messages",
                json={"text": "count the inflammatory cells here", "roi": roi})
    digest = client.get(f"/api/copilot/conversations/{cid}").json()["plans"][-1]["digest"]
    client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/approve")
    return digest


def test_first_run_is_not_cached(client: TestClient):
    cid = _conv(client)
    digest = _approved_digest(client, cid)
    r = client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/run")
    assert '"type":"run_done"' in r.text
    assert '"cached":false' in r.text


def test_second_run_of_same_plan_is_a_cache_hit(client: TestClient):
    cid = _conv(client)
    digest = _approved_digest(client, cid)
    client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/run")
    r2 = client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/run")
    assert '"cached":true' in r2.text
    # A cache hit still records a run + Claim, so the reused result is reload-safe.
    conv = client.get(f"/api/copilot/conversations/{cid}").json()
    assert len(conv["claims"]) == 2


def test_cache_reuses_across_conversations_on_the_same_slide(client: TestClient):
    c1 = _conv(client, item="slideX")
    d1 = _approved_digest(client, c1)
    client.post(f"/api/copilot/conversations/{c1}/plan/{d1}/run")
    # A fresh conversation on the same slide, same ask → identical digest → cache hit.
    c2 = _conv(client, item="slideX")
    d2 = _approved_digest(client, c2)
    assert d2 == d1
    r = client.post(f"/api/copilot/conversations/{c2}/plan/{d2}/run")
    assert '"cached":true' in r.text


def test_a_different_roi_is_a_cache_miss(client: TestClient):
    cid = _conv(client, item="slideY")
    d1 = _approved_digest(client, cid, roi=_ROI)
    client.post(f"/api/copilot/conversations/{cid}/plan/{d1}/run")
    d2 = _approved_digest(client, cid, roi=_ROI2)
    assert d2 != d1
    r = client.post(f"/api/copilot/conversations/{cid}/plan/{d2}/run")
    assert '"cached":false' in r.text
