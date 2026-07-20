"""Increment 6a — a run produces a durable Claim, at the route level.

Running an approved plan now persists a Claim (deterministic, evidence-bound). The
conversation-hydration endpoint returns claims so a reload can restore the run result +
nuclei overlay without re-executing. Exercised against MemoryStore + the StubPlanner.
"""

from starlette.testclient import TestClient

_ROI = {"x": 10, "y": 20, "width": 300, "height": 240}


def _conv(client: TestClient, item: str = "s") -> int:
    return client.post("/api/copilot/conversations", json={"item_id": item}).json()["id"]


def _approved_digest(client: TestClient, cid: int) -> str:
    client.post(f"/api/copilot/conversations/{cid}/messages",
                json={"text": "count the inflammatory cells here", "roi": _ROI})
    digest = client.get(f"/api/copilot/conversations/{cid}").json()["plans"][0]["digest"]
    client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/approve")
    return digest


def test_running_a_plan_persists_a_claim(client: TestClient):
    cid = _conv(client)
    digest = _approved_digest(client, cid)
    r = client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/run")
    assert '"type":"run_done"' in r.text
    assert '"claim"' in r.text        # the run_done frame carries the built claim

    conv = client.get(f"/api/copilot/conversations/{cid}").json()
    assert "claims" in conv
    claims = conv["claims"]
    assert len(claims) == 1
    c = claims[0]
    assert c["plan_digest"] == digest
    assert c["predicate"] == "count"
    assert c["value"] == c["metrics"]["count"] > 0    # authoritative number from the run
    assert c["status"] == "asserted"
    assert "registry_version" in c["method_versions"]
    assert any(e["key"] == "nuclei" for e in c["evidence"])


def test_claim_evidence_artifact_is_fetchable_for_overlay_rehydration(client: TestClient):
    cid = _conv(client)
    digest = _approved_digest(client, cid)
    client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/run")
    c = client.get(f"/api/copilot/conversations/{cid}").json()["claims"][0]
    ref = next(e for e in c["evidence"] if e["key"] == "nuclei")
    art = client.get(
        f"/api/copilot/conversations/{cid}/runs/{ref['run_id']}/artifact/nuclei"
    )
    assert art.status_code == 200
    assert art.json()["kind"] == "nuclei"


def test_no_claim_before_the_plan_is_run(client: TestClient):
    cid = _conv(client)
    _approved_digest(client, cid)   # approved, but never run
    conv = client.get(f"/api/copilot/conversations/{cid}").json()
    assert conv["claims"] == []
