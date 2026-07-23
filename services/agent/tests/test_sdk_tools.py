"""R10.3 — the in-process (SDK) two-class tools + tool-result handle contract.

Client tools are thin viewer acks (the real OSD effect is emitted by the loop from the
observed tool_use). Server data tools execute with the per-turn ToolContext and return a
model-facing summary plus a marker-tagged artifact handle (D4) the loop lifts out — the
dense geometry never touches the model's context.
"""

import json

from agent.loop.artifacts import InMemoryArtifactStore
from agent.loop.sdk_tools import (
    ARTIFACT_MARKER,
    run_client_tool,
    run_data_tool,
    sdk_tool_names,
)
from agent.loop.tools import ToolContext

_ALL = {
    "mcp__pathagent__pan_zoom_to_region",
    "mcp__pathagent__highlight_roi",
    "mcp__pathagent__run_segmentation",
    "mcp__pathagent__describe_region",
    "mcp__pathagent__find_regions",
}


def test_sdk_tool_names_are_the_two_class_catalog():
    assert set(sdk_tool_names()) == _ALL


async def test_client_tool_is_a_viewer_ack():
    out = await run_client_tool("pan_zoom_to_region", {"bbox": None})
    assert not out.get("is_error")
    assert "pan_zoom_to_region" in out["content"][0]["text"]


async def test_data_tool_returns_summary_and_a_tagged_handle():
    store = InMemoryArtifactStore()
    ctx = ToolContext(owner="u1", conversation_id=1, artifacts=store)
    roi = {"x": 0, "y": 0, "width": 8, "height": 8}

    out = await run_data_tool("run_segmentation", {}, {"roi": roi}, ctx)
    texts = [b["text"] for b in out["content"]]

    assert any("segmented" in t for t in texts)
    marker = next(t for t in texts if t.startswith(ARTIFACT_MARKER))
    handle = json.loads(marker[len(ARTIFACT_MARKER):])
    assert handle["kind"] == "nuclei" and handle["ref"] and handle["count"] > 0
    # the geometry the handle points at is fetchable out-of-band (it was actually stored)
    geometry = await store.get(owner="u1", ref=handle["ref"])
    assert len(geometry["points"]) == handle["count"]


async def test_data_tool_without_a_store_is_summary_only():
    out = await run_data_tool("run_segmentation", {}, {"roi": None}, None)
    texts = [b["text"] for b in out["content"]]
    assert any("segmented" in t for t in texts)
    assert not any(t.startswith(ARTIFACT_MARKER) for t in texts)
