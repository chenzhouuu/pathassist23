"""R8 — the two-class loop tool registry (D3).

The catalog of record for the agent loop: every tool is either a **client** viewer
command (executed in the browser, no auth) or a **server** data tool (run in the gateway
with the user's token; stubbed until R10/R11).
"""

import pytest

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


class _FakeSeg:
    def __init__(self):
        self.calls = []

    async def __call__(self, *, base_url, slide_ref, bbox, token, timeout=120.0, client=None):
        from agent.loop.segmenter import SegmentResult
        self.calls.append({"base_url": base_url, "slide_ref": slide_ref, "bbox": bbox,
                           "token": token})
        return SegmentResult(count=3, points=[[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]])


@pytest.mark.asyncio
async def test_run_segmentation_uses_service_when_configured(monkeypatch):
    fake = _FakeSeg()
    monkeypatch.setattr("agent.loop.tools.segment_region", fake)
    ctx = ToolContext(owner="u1", conversation_id=1, artifacts=InMemoryArtifactStore(),
                      girder_token="tok", cellvit_url="http://cellvit")
    scope = {"item_id": "item1", "roi": {"x": 10, "y": 20, "width": 30, "height": 40}}
    out = await run_server_tool(get_tool("run_segmentation"), {}, scope, ctx)
    assert out.ok and out.artifact.count == 3
    assert "3 nuclei" in out.summary
    assert fake.calls[0]["slide_ref"] == "item1"
    assert fake.calls[0]["bbox"]["width"] == 30  # fell back to scope.roi


@pytest.mark.asyncio
async def test_run_segmentation_prefers_bbox_arg(monkeypatch):
    fake = _FakeSeg()
    monkeypatch.setattr("agent.loop.tools.segment_region", fake)
    ctx = ToolContext(owner="u1", conversation_id=1, artifacts=InMemoryArtifactStore(),
                      girder_token="tok", cellvit_url="http://cellvit")
    scope = {"item_id": "item1", "roi": {"x": 10, "y": 20, "width": 30, "height": 40}}
    arg_bbox = {"x": 500, "y": 600, "width": 128, "height": 128}
    await run_server_tool(get_tool("run_segmentation"), {"bbox": arg_bbox}, scope, ctx)
    assert fake.calls[0]["bbox"] == arg_bbox  # explicit arg wins over scope.roi


@pytest.mark.asyncio
async def test_run_segmentation_service_no_region_is_error():
    ctx = ToolContext(owner="u1", conversation_id=1, artifacts=InMemoryArtifactStore(),
                      cellvit_url="http://cellvit")
    out = await run_server_tool(get_tool("run_segmentation"), {}, {"item_id": "item1"}, ctx)
    assert out.ok is False and "region" in out.summary.lower()
