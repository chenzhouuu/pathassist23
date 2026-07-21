"""R7/R8 — the autonomous agent-loop seam, at the unit level.

`StubAgentLoop` stands in for the Claude Agent SDK (not yet a dependency). At R8 it
orchestrates the two tool classes (D3): a **client-side** viewer tool whose effect is an
OpenSeadragon command the browser executes, and a **server-side** data tool that runs in
the gateway (stubbed until R10/R11). These tests pin the loop's shape — a well-formed,
correlated event stream; the client→server tool order; the level-0-pixel coordinate
contract (D8) with viewer-state injection; and a well-formed hard-cancel — without a model.
"""

import asyncio

from agent.common.config import Settings
from agent.loop import AgentLoop, StubAgentLoop, build_agent
from agent.loop.events import (
    RunError,
    RunFinished,
    RunStarted,
    TextDelta,
    ToolCallResult,
    ToolCallStart,
)

_ROI = {"kind": "rect", "x": 100.0, "y": 200.0, "width": 512.0, "height": 512.0, "unit": "px"}
_VIEWER = {"x": 0.0, "y": 0.0, "width": 4096.0, "height": 4096.0, "unit": "px"}


async def _drain(loop: AgentLoop, **kw) -> list:
    return [ev async for ev in loop.run(**kw)]


async def test_stub_loop_emits_a_correlated_typed_trace():
    events = await _drain(
        StubAgentLoop(), text="count cells here", history=[], scope={"item_id": "s", "roi": _ROI}
    )

    # Well-formed lifecycle: opens with run_started, closes with run_finished.
    assert isinstance(events[0], RunStarted)
    assert isinstance(events[-1], RunFinished)

    # Every tool_call_start has exactly one matching result, correlated by tool_call_id.
    starts = [e for e in events if isinstance(e, ToolCallStart)]
    results = [e for e in events if isinstance(e, ToolCallResult)]
    assert len(starts) == len(results) >= 2
    assert {s.tool_call_id for s in starts} == {r.tool_call_id for r in results}

    # Every event carries the same run_id (a single turn).
    run_id = events[0].run_id
    assert run_id and all(e.run_id == run_id for e in events)


async def test_loop_orchestrates_a_client_then_a_server_tool():
    """The two-class split (D3): a client-side viewer tool, then a server-side data tool."""
    events = await _drain(
        StubAgentLoop(), text="count cells here", history=[], scope={"item_id": "s", "roi": _ROI}
    )
    starts = [e for e in events if isinstance(e, ToolCallStart)]
    by_name = {s.name: s for s in starts}

    assert by_name["pan_zoom_to_region"].tool_class == "client"
    assert by_name["run_segmentation"].tool_class == "server"
    order = [s.name for s in starts]
    assert order.index("pan_zoom_to_region") < order.index("run_segmentation")


async def test_client_tool_targets_the_roi_in_level0_pixels():
    """The coordinate contract (D8): the viewer tool's bbox is the ROI, in level-0 px."""
    events = await _drain(
        StubAgentLoop(), text="count", history=[], scope={"item_id": "s", "roi": _ROI}
    )
    pan = next(
        e for e in events if isinstance(e, ToolCallStart) and e.name == "pan_zoom_to_region"
    )
    assert pan.args["bbox"] == _ROI


async def test_client_tool_falls_back_to_injected_viewer_state():
    """Viewer-state injection: with no ROI, the viewer tool frames the current viewport."""
    events = await _drain(
        StubAgentLoop(), text="what's here", history=[],
        scope={"item_id": "s", "roi": None}, viewer=_VIEWER,
    )
    pan = next(
        e for e in events if isinstance(e, ToolCallStart) and e.name == "pan_zoom_to_region"
    )
    assert pan.args["bbox"] == _VIEWER


async def test_whole_slide_when_no_roi_and_no_viewer():
    """No ROI and no viewport ⇒ whole slide: the viewer tool's bbox is null (D8)."""
    events = await _drain(StubAgentLoop(), text="count", history=[], scope={"item_id": "s"})
    pan = next(
        e for e in events if isinstance(e, ToolCallStart) and e.name == "pan_zoom_to_region"
    )
    assert pan.args["bbox"] is None


async def test_server_tool_summary_grounds_the_final_answer():
    events = await _drain(
        StubAgentLoop(), text="count", history=[], scope={"item_id": "s", "roi": _ROI}
    )
    seg_start = next(
        e for e in events if isinstance(e, ToolCallStart) and e.name == "run_segmentation"
    )
    seg_result = next(
        e for e in events
        if isinstance(e, ToolCallResult) and e.tool_call_id == seg_start.tool_call_id
    )
    assert "segmented" in seg_result.summary
    assert seg_result.summary in events[-1].text  # the answer cites the tool's result


async def test_the_answer_streams_only_after_every_tool_resolves():
    events = await _drain(
        StubAgentLoop(), text="count", history=[], scope={"item_id": "s", "roi": _ROI}
    )
    kinds = [type(e).__name__ for e in events]
    last_result = len(kinds) - 1 - kinds[::-1].index("ToolCallResult")
    first_text = kinds.index("TextDelta")
    assert last_result < first_text


async def test_abort_with_a_tool_in_flight_closes_the_trace_well_formed():
    """Hard cancel (Claude Code's pattern): an in-flight tool gets a synthetic error
    result so the transcript stays well-formed, then the run ends — no final answer."""
    abort = asyncio.Event()
    events = []
    async for ev in StubAgentLoop().run(
        text="count", history=[], scope={"item_id": "s", "roi": _ROI}, abort=abort
    ):
        events.append(ev)
        if isinstance(ev, ToolCallStart):
            abort.set()  # cancel the moment the first tool starts

    last_result = [e for e in events if isinstance(e, ToolCallResult)][-1]
    assert last_result.ok is False and last_result.summary == "aborted"
    assert isinstance(events[-1], RunError)
    assert not any(isinstance(e, TextDelta) for e in events)  # no answer after abort
    assert sum(isinstance(e, ToolCallStart) for e in events) == 1  # no runaway


async def test_events_serialize_to_a_typed_sse_dict():
    """Each event renders to a compact dict with a `type` discriminant for the SSE frame."""
    ev = ToolCallStart(
        run_id="r1", tool_call_id="c1", name="pan_zoom_to_region",
        args={"bbox": _ROI}, tool_class="client",
    )
    assert ev.as_event() == {
        "type": "tool_call_start",
        "run_id": "r1",
        "tool_call_id": "c1",
        "name": "pan_zoom_to_region",
        "args": {"bbox": _ROI},
        "tool_class": "client",
    }


async def test_server_tool_result_carries_a_handle_not_geometry():
    """D4: the tool result event carries the artifact handle; the dense geometry never
    rides the stream or enters the model's context."""
    import json

    from agent.loop.artifacts import InMemoryArtifactStore
    from agent.loop.tools import ToolContext

    store = InMemoryArtifactStore()
    ctx = ToolContext(owner="u1", conversation_id=1, artifacts=store)
    events = await _drain(
        StubAgentLoop(), text="count", history=[], scope={"item_id": "s", "roi": _ROI}, ctx=ctx
    )

    seg_start = next(
        e for e in events if isinstance(e, ToolCallStart) and e.name == "run_segmentation"
    )
    seg_result = next(
        e for e in events
        if isinstance(e, ToolCallResult) and e.tool_call_id == seg_start.tool_call_id
    )
    assert seg_result.artifact is not None
    assert seg_result.artifact["kind"] == "nuclei" and seg_result.artifact["ref"]
    assert seg_result.artifact["count"] > 0
    # the geometry (points) is nowhere in the serialized event
    assert "points" not in json.dumps(seg_result.as_event())


def test_build_agent_returns_an_agent_loop():
    assert isinstance(build_agent(Settings()), AgentLoop)


def test_build_agent_selects_sdk_loop_when_keyed():
    """R10.7: with a key the gateway drives the real Claude Agent SDK; keyless it stays on
    the deterministic stub (same selection rule as the responder/planner)."""
    from agent.loop.sdk import SdkAgentLoop

    assert isinstance(build_agent(Settings(anthropic_api_key="")), StubAgentLoop)
    keyed = build_agent(
        Settings(anthropic_api_key="sk-test", anthropic_model="claude-sonnet-5")
    )
    assert isinstance(keyed, SdkAgentLoop)
