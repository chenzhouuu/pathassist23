"""R7/R8 — the autonomous agent turn, at the route level.

`POST /conversations/{id}/turns` runs one Claude-Code-style loop (a two-class stub at R8)
and streams the typed event trace over the existing SSE seam: a client-side viewer
command and a server-side data tool, correlated by ids. It persists the user turn before
streaming and the assistant's final answer when the run finishes, and coexists with the
legacy /messages plan flow during migration. Exercised against MemoryStore + StubAgentLoop.
"""

import json

from starlette.testclient import TestClient


def _conv(client: TestClient, item: str = "s") -> int:
    return client.post("/api/copilot/conversations", json={"item_id": item}).json()["id"]


def _frames(resp) -> list[dict]:
    return [
        json.loads(line[len("data:"):].strip())
        for line in resp.text.splitlines()
        if line.startswith("data:")
    ]


_ROI = {"x": 100, "y": 200, "width": 512, "height": 512}


def test_turn_streams_the_two_class_typed_trace(client: TestClient):
    cid = _conv(client)
    r = client.post(f"/api/copilot/conversations/{cid}/turns",
                    json={"text": "count cells here", "roi": _ROI})
    assert r.status_code == 200
    for frame in ('"type":"run_started"', '"type":"tool_call_start"',
                  '"type":"tool_call_result"', '"type":"run_finished"'):
        assert frame in r.text
    # both tool classes show up as distinct, self-describing frames
    assert '"name":"pan_zoom_to_region"' in r.text and '"tool_class":"client"' in r.text
    assert '"name":"run_segmentation"' in r.text and '"tool_class":"server"' in r.text


def test_turn_persists_user_then_assistant(client: TestClient):
    cid = _conv(client)
    client.post(f"/api/copilot/conversations/{cid}/turns",
                json={"text": "count cells here", "roi": _ROI})
    turns = client.get(f"/api/copilot/conversations/{cid}").json()["turns"]
    assert [t["role"] for t in turns] == ["user", "assistant"]
    assert turns[0]["text"] == "count cells here"
    assert "segmented" in turns[1]["text"]  # the answer cites the server tool's result


def test_turn_client_tool_carries_the_roi_in_level0_pixels(client: TestClient):
    cid = _conv(client)
    r = client.post(f"/api/copilot/conversations/{cid}/turns",
                    json={"text": "count cells here", "roi": _ROI})
    pan = next(f for f in _frames(r) if f.get("name") == "pan_zoom_to_region")
    assert pan["tool_class"] == "client"
    assert pan["args"]["bbox"] == {**_ROI, "kind": "rect", "unit": "px"}


def test_turn_injects_viewer_state_into_the_client_tool(client: TestClient):
    """With no ROI, the viewer snapshot sent with the turn frames the client tool (D8)."""
    cid = _conv(client)
    r = client.post(f"/api/copilot/conversations/{cid}/turns",
                    json={"text": "what's here", "viewer": {"x": 0, "y": 0,
                                                             "width": 4096, "height": 4096}})
    pan = next(f for f in _frames(r) if f.get("name") == "pan_zoom_to_region")
    assert pan["args"]["bbox"]["width"] == 4096


def test_turn_binds_the_roi_to_the_user_message(client: TestClient):
    cid = _conv(client)
    client.post(f"/api/copilot/conversations/{cid}/turns",
                json={"text": "what is here", "roi": _ROI})
    turns = client.get(f"/api/copilot/conversations/{cid}").json()["turns"]
    assert turns[0]["roi"] == {**_ROI, "kind": "rect", "unit": "px"}


def test_turn_on_missing_conversation_is_404(client: TestClient):
    r = client.post("/api/copilot/conversations/999/turns", json={"text": "hi"})
    assert r.status_code == 404


def test_turn_forwards_the_approval_flag_to_the_loop(client: TestClient):
    """R10.7: the per-turn `approved` consent (the human lifting the tool gate) reaches the
    agent loop, so a re-run after approval can execute the costly server tools."""
    from agent.gateway.routes import get_agent
    from agent.loop.events import RunFinished

    seen: dict = {}

    class RecordingLoop:
        async def run(self, *, text, history, scope, viewer=None, ctx=None,
                      approved=False, abort=None):
            seen["approved"] = approved
            yield RunFinished(run_id="r", text="ok")

    client.app.dependency_overrides[get_agent] = lambda: RecordingLoop()
    cid = _conv(client)
    r = client.post(f"/api/copilot/conversations/{cid}/turns",
                    json={"text": "count cells here", "approved": True})
    assert r.status_code == 200
    assert seen["approved"] is True


def _seg_result_frame(frames: list[dict]) -> dict:
    """Correlate the run_segmentation start to its result frame by tool_call_id."""
    seg_id = next(
        f["tool_call_id"] for f in frames
        if f["type"] == "tool_call_start" and f["name"] == "run_segmentation"
    )
    return next(
        f for f in frames if f["type"] == "tool_call_result" and f["tool_call_id"] == seg_id
    )


def test_turn_emits_a_handle_and_geometry_is_fetchable_out_of_band(client: TestClient):
    cid = _conv(client)
    r = client.post(f"/api/copilot/conversations/{cid}/turns",
                    json={"text": "count cells here", "roi": _ROI})
    handle = _seg_result_frame(_frames(r))["artifact"]
    assert handle["kind"] == "nuclei" and handle["ref"] and handle["count"] > 0
    # the dense geometry never rides the SSE stream — only the handle does
    assert '"points"' not in r.text

    # ...but it is fetchable out-of-band by the handle's ref, owner-scoped
    got = client.get(f"/api/copilot/conversations/{cid}/artifacts/{handle['ref']}")
    assert got.status_code == 200
    assert len(got.json()["points"]) == handle["count"]


def test_unknown_turn_artifact_is_404(client: TestClient):
    cid = _conv(client)
    r = client.get(f"/api/copilot/conversations/{cid}/artifacts/no-such-ref")
    assert r.status_code == 404


def test_turn_artifact_fetch_scoped_to_owner(store):
    from agent.gateway.app import create_app
    from agent.gateway.auth import require_user
    from agent.gateway.routes import get_agent, get_store
    from agent.loop import StubAgentLoop

    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[require_user] = lambda: {"_id": "owner"}
    app.dependency_overrides[get_agent] = lambda: StubAgentLoop()
    c = TestClient(app)
    cid = c.post("/api/copilot/conversations", json={"item_id": "s"}).json()["id"]
    r = c.post(f"/api/copilot/conversations/{cid}/turns",
               json={"text": "count cells here", "roi": _ROI})
    ref = _seg_result_frame(_frames(r))["artifact"]["ref"]
    assert c.get(f"/api/copilot/conversations/{cid}/artifacts/{ref}").status_code == 200

    app.dependency_overrides[require_user] = lambda: {"_id": "intruder"}
    assert c.get(f"/api/copilot/conversations/{cid}/artifacts/{ref}").status_code == 404
