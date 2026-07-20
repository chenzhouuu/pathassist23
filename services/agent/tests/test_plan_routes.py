"""Increment 4 — the plan proposal + approval gate, at the route level.

A quantitative ask yields a persisted, enum-valid, AWAITING_APPROVAL plan (nothing runs);
plain chat still streams; a new plan expires the prior one; approve/reject drive the
state machine, owner-scoped. Exercised against MemoryStore + the deterministic StubPlanner.
"""

from starlette.testclient import TestClient

from agent.gateway.app import create_app
from agent.gateway.routes import get_planner, get_store
from agent.plan.planner import StubPlanner

_ROI = {"x": 10, "y": 20, "width": 30, "height": 40}


def _conv(client: TestClient, item: str = "s") -> int:
    return client.post("/api/copilot/conversations", json={"item_id": item}).json()["id"]


def _quant(client: TestClient, cid: int, text: str = "count the inflammatory cells here",
           roi: bool = True):
    body = {"text": text}
    if roi:
        body["roi"] = _ROI
    return client.post(f"/api/copilot/conversations/{cid}/messages", json=body)


def _plans(client: TestClient, cid: int) -> list[dict]:
    return client.get(f"/api/copilot/conversations/{cid}").json()["plans"]


def test_tools_endpoint_lists_stub_tools(client: TestClient):
    r = client.get("/api/copilot/tools")
    assert r.status_code == 200
    names = [t["name"] for t in r.json()["tools"]]
    assert "nuclei_segment_stub" in names and "count_within_roi" in names


def test_quantify_request_proposes_a_persisted_plan(client: TestClient):
    cid = _conv(client)
    r = _quant(client, cid)
    assert r.status_code == 200
    assert '"type":"plan"' in r.text          # a plan frame, not chat tokens
    assert '"type":"token"' not in r.text
    assert "nuclei_segment_stub" in r.text

    plans = _plans(client, cid)
    assert len(plans) == 1
    assert plans[0]["state"] == "AWAITING_APPROVAL"
    assert [s["tool"] for s in plans[0]["steps"]] == ["nuclei_segment_stub", "count_within_roi"]
    assert plans[0]["envelope"]["tools"] == 2
    assert plans[0]["digest"]


def test_plain_chat_still_streams_and_makes_no_plan(client: TestClient):
    cid = _conv(client)
    r = client.post(f"/api/copilot/conversations/{cid}/messages",
                    json={"text": "what is a lymphocyte?"})
    assert '"type":"token"' in r.text
    assert '"type":"plan"' not in r.text
    assert _plans(client, cid) == []


def test_quantify_without_a_region_asks_for_one(client: TestClient):
    cid = _conv(client)
    r = _quant(client, cid, text="count the cells", roi=False)
    assert '"type":"plan"' not in r.text
    assert "region" in r.text.lower()          # validation → friendly guidance
    assert _plans(client, cid) == []


def test_approve_moves_plan_to_approved(client: TestClient):
    cid = _conv(client)
    _quant(client, cid)
    digest = _plans(client, cid)[0]["digest"]
    r = client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/approve")
    assert r.status_code == 200 and r.json()["state"] == "APPROVED"
    assert _plans(client, cid)[0]["state"] == "APPROVED"


def test_reject_moves_plan_to_rejected(client: TestClient):
    cid = _conv(client)
    _quant(client, cid)
    digest = _plans(client, cid)[0]["digest"]
    r = client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/reject")
    assert r.status_code == 200 and r.json()["state"] == "REJECTED"


def test_a_new_plan_expires_the_prior_one(client: TestClient):
    cid = _conv(client)
    _quant(client, cid)
    _quant(client, cid, text="quantify tumor cells")
    plans = _plans(client, cid)
    assert len(plans) == 2
    assert sorted(p["state"] for p in plans) == ["AWAITING_APPROVAL", "EXPIRED"]


def test_approve_unknown_digest_is_404(client: TestClient):
    cid = _conv(client)
    r = client.post(f"/api/copilot/conversations/{cid}/plan/deadbeef00/approve")
    assert r.status_code == 404


def test_approve_already_resolved_plan_conflicts(client: TestClient):
    cid = _conv(client)
    _quant(client, cid)
    digest = _plans(client, cid)[0]["digest"]
    client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/approve")
    again = client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/approve")
    assert again.status_code == 409


def test_approve_scoped_to_owner(store):
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_planner] = lambda: StubPlanner()

    from agent.gateway.auth import require_user

    app.dependency_overrides[require_user] = lambda: {"_id": "owner"}
    client = TestClient(app)
    cid = _conv(client)
    _quant(client, cid)
    digest = _plans(client, cid)[0]["digest"]

    app.dependency_overrides[require_user] = lambda: {"_id": "intruder"}
    assert client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/approve").status_code == 404
