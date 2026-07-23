"""StubAgentLoop — the keyless framework-on-a-stub agent loop (PathAgent v2, R7→R8).

Stands in for the Claude Agent SDK before it is a dependency. At R8 it orchestrates the
two tool classes (D3) for a turn: a **client-side** viewer command (pan/zoom to the ROI
or the injected viewport, in level-0 pixels — fire-and-forget) followed by a
**server-side** data tool (segmentation, stubbed until R10/R11), then a final answer
grounded in that tool's summary. This exercises the whole loop + typed-event + two-class +
coordinate-contract plumbing end-to-end without a model. R10 replaces this with
SdkAgentLoop behind the same seam.
"""

import uuid
from asyncio import Event
from collections.abc import AsyncIterator

from .base import AgentLoop
from .events import (
    AgentEvent,
    ReasoningDelta,
    RunError,
    RunFinished,
    RunStarted,
    TextDelta,
    ToolCallResult,
    ToolCallStart,
)
from .tools import ToolContext, get_tool, run_server_tool


def _new_id() -> str:
    """A short correlation id for a run or a tool call."""
    return uuid.uuid4().hex[:12]


def _target_bbox(scope: dict, viewer: dict | None) -> dict | None:
    """Where the viewer should look, in level-0 pixels: the ROI wins; else the injected
    current viewport; else ``None`` ⇒ the whole slide (D8 scope rule)."""
    roi = (scope or {}).get("roi")
    if roi:
        return roi
    return viewer


class StubAgentLoop(AgentLoop):
    """Deterministic two-class loop for keyless dev and tests."""

    async def run(
        self,
        *,
        text: str,
        history: list[dict],
        scope: dict,
        viewer: dict | None = None,
        ctx: ToolContext | None = None,
        abort: Event | None = None,
    ) -> AsyncIterator[AgentEvent]:
        run_id = _new_id()
        yield RunStarted(run_id=run_id)
        yield ReasoningDelta(run_id=run_id, text="Frame the region, then segment it.")

        # 1) client-side viewer tool — a level-0-px pan the browser executes.
        #    Pure effect ⇒ fire-and-forget: it resolves as soon as the command is emitted.
        pan = get_tool("pan_zoom_to_region")
        pan_id = _new_id()
        yield ToolCallStart(
            run_id=run_id, tool_call_id=pan_id, name=pan.name,
            args={"bbox": _target_bbox(scope, viewer)}, tool_class=pan.tool_class,
        )
        if _aborted(abort):
            async for ev in _cancel(run_id, pan_id):
                yield ev
            return
        yield ToolCallResult(
            run_id=run_id, tool_call_id=pan_id, ok=True, summary="framed the region"
        )

        # 2) server-side data tool — segmentation (stubbed; the user's token joins at R11).
        seg = get_tool("run_segmentation")
        seg_id = _new_id()
        yield ToolCallStart(
            run_id=run_id, tool_call_id=seg_id, name=seg.name, args={}, tool_class=seg.tool_class
        )
        if _aborted(abort):
            async for ev in _cancel(run_id, seg_id):
                yield ev
            return
        outcome = await run_server_tool(seg, {}, scope, ctx)
        yield ToolCallResult(
            run_id=run_id, tool_call_id=seg_id, ok=outcome.ok, summary=outcome.summary,
            artifact=outcome.artifact.to_dict() if outcome.artifact else None,
        )

        # Answer, grounded in the server tool's summary.
        final = f"Done — {outcome.summary}."
        for word in final.split():
            yield TextDelta(run_id=run_id, text=f"{word} ")
        yield RunFinished(run_id=run_id, text=final)


def _aborted(abort: Event | None) -> bool:
    return abort is not None and abort.is_set()


async def _cancel(run_id: str, tool_call_id: str) -> AsyncIterator[AgentEvent]:
    """Hard cancel with a tool in flight: emit a synthetic error result so the transcript
    stays well-formed (Claude Code's abort pattern), then end the run."""
    yield ToolCallResult(run_id=run_id, tool_call_id=tool_call_id, ok=False, summary="aborted")
    yield RunError(run_id=run_id, message="aborted")
