"""Real-Claude smoke for SdkAgentLoop (R10.6) — MANUAL, makes real *billed* API calls.

Validates what the injected-`query` unit tests cannot: real Claude drives our in-process MCP
tools, its message stream translates to our typed events, and — the crux — the PreToolUse
gate actually blocks a costly server tool under ``bypassPermissions``.

    uv run python scripts/smoke_sdk.py

Auth: exports AGENT_ANTHROPIC_API_KEY (from .env) as ANTHROPIC_API_KEY for the spawned
`claude` subprocess; falls back to the logged-in CLI credentials if no key is configured.
Two turns: the same ask under the default (locked) gate, then under an approving gate.
"""

from __future__ import annotations

import asyncio
import os

from agent.common.config import get_settings
from agent.loop.artifacts import InMemoryArtifactStore
from agent.loop.events import RunFinished, ToolCallResult, ToolCallStart
from agent.loop.gate import GatePolicy
from agent.loop.sdk import SdkAgentLoop
from agent.loop.tools import ToolContext

_SCOPE = {
    "item_id": "smoke-slide",
    "roi": {"kind": "rect", "x": 0, "y": 0, "width": 512, "height": 512, "unit": "px"},
}
_ASK = (
    "Count the nuclei in the selected region using your segmentation tool, "
    "then tell me the number."
)


def _fmt(ev) -> str:
    d = ev.as_event()
    if ev.type == "tool_call_start":
        return f"tool_call_start  name={d['name']} class={d['tool_class']} args={d.get('args')}"
    if ev.type == "tool_call_result":
        return (
            f"tool_call_result ok={d['ok']} summary={d['summary']!r} "
            f"artifact={'yes' if d.get('artifact') else 'no'}"
        )
    if ev.type == "reasoning_delta":
        return f"reasoning_delta  {d['text'][:80]!r}"
    if ev.type == "text_delta":
        return f"text_delta       {d['text'][:80]!r}"
    if ev.type == "run_finished":
        return f"run_finished     {d['text'][:140]!r}"
    return ev.type


async def _turn(model: str, gate: GatePolicy) -> list:
    ctx = ToolContext(owner="smoke", conversation_id=1, artifacts=InMemoryArtifactStore())
    loop = SdkAgentLoop(api_key=os.environ.get("ANTHROPIC_API_KEY", ""), model=model, gate=gate)
    events: list = []
    async for ev in loop.run(
        text=_ASK, history=[{"role": "user", "content": _ASK}],
        scope=_SCOPE, viewer=None, ctx=ctx,
    ):
        events.append(ev)
        print("   ", _fmt(ev))
    return events


def _seg_results(events: list) -> list:
    ids = {
        e.tool_call_id for e in events
        if isinstance(e, ToolCallStart) and e.name == "run_segmentation"
    }
    return [e for e in events if isinstance(e, ToolCallResult) and e.tool_call_id in ids]


async def main() -> int:
    settings = get_settings()
    key = settings.anthropic_api_key
    if key:
        os.environ["ANTHROPIC_API_KEY"] = key
    model = settings.anthropic_model
    print(f"model={model}  auth={'api-key' if key else 'cli-credentials'}\n")

    print("== Check 1: DEFAULT gate — server tools need approval (expect segmentation DENIED) ==")
    ev1 = await _turn(model, GatePolicy())
    segs1 = _seg_results(ev1)

    print("\n== Check 2: APPROVED gate — server tools allowed (expect segmentation OK + handle) ==")
    ev2 = await _turn(model, GatePolicy(approve_server=True))
    segs2 = _seg_results(ev2)

    print("\n===== VERDICT =====")
    ok = True

    def check(label: str, cond: bool) -> None:
        nonlocal ok
        ok = ok and cond
        print(f"  [{'PASS' if cond else 'FAIL'}] {label}")

    check(
        "stream translated (both turns end in run_finished)",
        bool(ev1) and bool(ev2) and isinstance(ev1[-1], RunFinished)
        and isinstance(ev2[-1], RunFinished),
    )
    check(
        "real Claude called an in-process tool",
        any(isinstance(e, ToolCallStart) for e in ev1 + ev2),
    )
    print(f"       (seg attempts: default={len(segs1)}, approved={len(segs2)})")
    check(
        "default gate blocked segmentation (every attempt ok=False; none ran)",
        all(not s.ok for s in segs1),
    )
    check("approved gate ran segmentation (some attempt ok=True)", any(s.ok for s in segs2))
    check(
        "approved segmentation lifted an artifact handle",
        any(s.ok and s.artifact for s in segs2),
    )
    print("===================")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
