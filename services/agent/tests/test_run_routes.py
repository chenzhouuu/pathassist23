"""Increment 5 — plan execution + artifact fetch, at the route level.

Only an APPROVED plan runs; the run streams per-step frames then a run_done with artifact
handles; the produced nuclei are fetched separately and are owner-scoped. Exercised
against MemoryStore + the deterministic StubPlanner.
"""

from starlette.testclient import TestClient

from agent.gateway.app import create_app
from agent.gateway.routes import get_planner, get_store
from agent.plan.planner import StubPlanner

_ROI = {"x": 10, "y": 20, "width": 300, "height": 240}


def _conv(client: TestClient, item: str = "s") -> int:
    return client.post("/api/copilot/conversations", json={"item_id": item}).json()["id"]


def _approved_digest(client: TestClient, cid: int) -> str:
    client.post(f"/api/copilot/conversations/{cid}/messages",
                json={"text": "count the inflammatory cells here", "roi": _ROI})
    digest = client.get(f"/api/copilot/conversations/{cid}").json()["plans"][0]["digest"]
    client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/approve")
    return digest


def test_running_an_approved_plan_streams_steps_then_done(client: TestClient):
    cid = _conv(client)
    digest = _approved_digest(client, cid)
    r = client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/run")
    assert r.status_code == 200
    assert '"type":"run_start"' in r.text
    assert '"type":"run_step"' in r.text
    assert '"type":"run_done"' in r.text
    assert "nuclei_segment_stub" in r.text and "count_within_roi" in r.text
    # run_done carries scalar values + an artifact handle, not the bulk geometry
    assert '"count"' in r.text
    assert '"key":"nuclei"' in r.text


def test_run_result_count_is_positive_and_artifact_is_fetchable(client: TestClient):
    cid = _conv(client)
    digest = _approved_digest(client, cid)
    r = client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/run")
    # find the run id from any frame
    import json
    run_id = None
    for line in r.text.splitlines():
        if line.startswith("data:") and "run_done" in line:
            run_id = json.loads(line[len("data:"):].strip())["run_id"]
    assert run_id is not None
    art = client.get(f"/api/copilot/conversations/{cid}/runs/{run_id}/artifact/nuclei")
    assert art.status_code == 200
    nuclei = art.json()
    assert nuclei["kind"] == "nuclei" and nuclei["count"] == len(nuclei["points"]) > 0


def test_cannot_run_an_unapproved_plan(client: TestClient):
    cid = _conv(client)
    client.post(f"/api/copilot/conversations/{cid}/messages",
                json={"text": "count the inflammatory cells here", "roi": _ROI})
    digest = client.get(f"/api/copilot/conversations/{cid}").json()["plans"][0]["digest"]
    # not approved yet → 409
    r = client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/run")
    assert r.status_code == 409


def test_run_unknown_plan_is_404(client: TestClient):
    cid = _conv(client)
    r = client.post(f"/api/copilot/conversations/{cid}/plan/deadbeef00/run")
    assert r.status_code == 404


def test_unknown_artifact_is_404(client: TestClient):
    cid = _conv(client)
    digest = _approved_digest(client, cid)
    client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/run")
    r = client.get(f"/api/copilot/conversations/{cid}/runs/999/artifact/nuclei")
    assert r.status_code == 404


def test_artifact_fetch_scoped_to_owner(store):
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_planner] = lambda: StubPlanner()

    from agent.gateway.auth import require_user

    app.dependency_overrides[require_user] = lambda: {"_id": "owner"}
    client = TestClient(app)
    cid = _conv(client)
    digest = _approved_digest(client, cid)
    import json
    r = client.post(f"/api/copilot/conversations/{cid}/plan/{digest}/run")
    run_id = next(
        json.loads(line[len("data:"):].strip())["run_id"]
        for line in r.text.splitlines()
        if line.startswith("data:") and "run_done" in line
    )

    app.dependency_overrides[require_user] = lambda: {"_id": "intruder"}
    r2 = client.get(f"/api/copilot/conversations/{cid}/runs/{run_id}/artifact/nuclei")
    assert r2.status_code == 404
