"""R8 — the two-class loop tool registry (D3).

The catalog of record for the agent loop: every tool is either a **client** viewer
command (executed in the browser, no auth) or a **server** data tool (run in the gateway
with the user's token; stubbed until R10/R11).
"""

from agent.loop.artifacts import InMemoryArtifactStore
from agent.loop.tools import CLIENT, SERVER, ToolContext, catalog, get_tool, run_server_tool


def test_registry_declares_each_tool_class():
    assert get_tool("pan_zoom_to_region").tool_class == CLIENT
    assert get_tool("highlight_roi").tool_class == CLIENT
    assert get_tool("run_segmentation").tool_class == SERVER


def test_catalog_has_both_classes():
    classes = {t.tool_class for t in catalog()}
    assert classes == {CLIENT, SERVER}


def test_unknown_tool_is_none():
    assert get_tool("does_not_exist") is None


async def test_server_segmentation_stub_reports_the_region():
    roi = {"x": 0, "y": 0, "width": 10, "height": 10}
    scoped = await run_server_tool(get_tool("run_segmentation"), {}, {"roi": roi})
    assert scoped.ok and "in the region" in scoped.summary

    whole = await run_server_tool(get_tool("run_segmentation"), {}, {"roi": None})
    assert whole.ok and "across the slide" in whole.summary


async def test_segmentation_writes_a_handle_when_a_store_is_present():
    """With a store in context, bulk output is written and only a handle is returned (D4)."""
    store = InMemoryArtifactStore()
    ctx = ToolContext(owner="u1", conversation_id=1, artifacts=store)
    roi = {"x": 0, "y": 0, "width": 8, "height": 8}
    out = await run_server_tool(get_tool("run_segmentation"), {}, {"roi": roi}, ctx)

    assert out.ok and out.artifact is not None
    assert out.artifact.kind == "nuclei" and out.artifact.count > 0
    assert out.artifact.bbox == roi  # level-0 px (D8)
    # the count on the handle matches the geometry actually stored out-of-band
    geometry = await store.get(owner="u1", ref=out.artifact.ref)
    assert len(geometry["points"]) == out.artifact.count


async def test_segmentation_is_summary_only_without_a_store():
    """No store (unit context) ⇒ the tool still grounds an answer, just no handle."""
    out = await run_server_tool(get_tool("run_segmentation"), {}, {"roi": None}, None)
    assert out.ok and out.artifact is None and "segmented" in out.summary
