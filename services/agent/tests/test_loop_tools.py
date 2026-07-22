"""R8 — the two-class loop tool registry (D3).

The catalog of record for the agent loop: every tool is either a **client** viewer
command (executed in the browser, no auth) or a **server** data tool (run in the gateway
with the user's token; stubbed until R10/R11).
"""

import pytest

import agent.loop.tools as tools
from agent.loop.artifacts import ArtifactHandle, InMemoryArtifactStore
from agent.loop.segmenter import SegmentResult
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
        return SegmentResult(count=3, points=[[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]], mpp=0.5)


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
    assert "0.5" in out.summary and "µm/px" in out.summary  # mpp surfaced for density
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


async def _raise_boom(*, base_url, slide_ref, bbox, token, timeout=120.0, client=None):
    raise RuntimeError("boom")


@pytest.mark.asyncio
async def test_run_segmentation_service_failure_is_ok_false(monkeypatch):
    monkeypatch.setattr("agent.loop.tools.segment_region", _raise_boom)
    ctx = ToolContext(owner="u1", conversation_id=1, artifacts=InMemoryArtifactStore(),
                      girder_token="tok", cellvit_url="http://cellvit")
    scope = {"item_id": "item1", "roi": {"x": 10, "y": 20, "width": 30, "height": 40}}
    out = await run_server_tool(get_tool("run_segmentation"), {}, scope, ctx)
    assert out.ok is False
    assert "segmentation failed" in out.summary


@pytest.mark.asyncio
async def test_run_segmentation_real_path_needs_a_slide(monkeypatch):
    fake = _FakeSeg()
    monkeypatch.setattr("agent.loop.tools.segment_region", fake)
    ctx = ToolContext(owner="u1", conversation_id=1, artifacts=InMemoryArtifactStore(),
                      girder_token="tok", cellvit_url="http://cellvit")
    scope = {"roi": {"x": 10, "y": 20, "width": 30, "height": 40}}  # no item_id
    out = await run_server_tool(get_tool("run_segmentation"), {}, scope, ctx)
    assert out.ok is False
    assert "slide" in out.summary.lower()
    assert fake.calls == []


@pytest.mark.asyncio
async def test_run_segmentation_rejects_oversized_region(monkeypatch):
    fake = _FakeSeg()
    monkeypatch.setattr("agent.loop.tools.segment_region", fake)
    ctx = ToolContext(owner="u1", conversation_id=1, artifacts=InMemoryArtifactStore(),
                      girder_token="tok", cellvit_url="http://cellvit")
    big = {"x": 0, "y": 0, "width": 5000, "height": 5000}  # 25M px^2 > 4096*4096 cap
    out = await run_server_tool(get_tool("run_segmentation"), {"bbox": big}, {"item_id": "s"}, ctx)
    assert out.ok is False
    assert "large" in out.summary.lower()
    assert fake.calls == []  # never called the GPU service for an oversized region


class _SpyStore:
    def __init__(self):
        self.put_kwargs = None

    async def put(self, **kwargs):
        self.put_kwargs = kwargs
        return ArtifactHandle(kind="nuclei", ref="r1", count=kwargs["geometry"]["count"],
                              summary=kwargs["summary"], bbox=kwargs["bbox"])

    async def get(self, **kwargs):
        return None


async def test_run_segmentation_threads_item_id_and_token_into_put(monkeypatch):
    async def _fake_seg(*, base_url, slide_ref, bbox, token):
        return SegmentResult(count=2, points=[[1.0, 2.0], [3.0, 4.0]], mpp=0.5)

    monkeypatch.setattr(tools, "segment_region", _fake_seg)
    spy = _SpyStore()
    ctx = tools.ToolContext(owner="u1", conversation_id=1, artifacts=spy,
                            girder_token="tok", cellvit_url="http://cellvit")
    scope = {"item_id": "item9", "roi": {"x": 0, "y": 0, "width": 10, "height": 10}}

    out = await tools.run_server_tool(tools.get_tool("run_segmentation"), {}, scope, ctx)

    assert out.ok
    assert spy.put_kwargs["item_id"] == "item9"
    assert spy.put_kwargs["token"] == "tok"


async def test_run_segmentation_survives_annotation_persist_failure(monkeypatch):
    import agent.loop.tools as tools

    async def _fake_seg(*, base_url, slide_ref, bbox, token):
        return SegmentResult(count=5, points=[[1.0, 2.0]], mpp=0.5)

    class _FailingStore:
        async def put(self, **kwargs):
            raise RuntimeError("girder write failed")

        async def get(self, **kwargs):
            return None

    monkeypatch.setattr(tools, "segment_region", _fake_seg)
    ctx = tools.ToolContext(owner="u1", conversation_id=1, artifacts=_FailingStore(),
                            girder_token="tok", cellvit_url="http://cellvit")
    scope = {"item_id": "item9", "roi": {"x": 0, "y": 0, "width": 10, "height": 10}}
    out = await tools.run_server_tool(tools.get_tool("run_segmentation"), {}, scope, ctx)
    assert out.ok
    assert "5" in out.summary and out.artifact is None  # count kept, overlay dropped


def test_typed_summary_formats_breakdown_desc_and_degrades():
    assert tools._typed_summary(195, {"Neoplastic": 142, "Inflammatory": 31, "Connective": 22}) == \
        "195 nuclei — 142 Neoplastic, 31 Inflammatory, 22 Connective"
    assert tools._typed_summary(195, {"Neoplastic": 195}) == "195 nuclei — 195 Neoplastic"
    assert tools._typed_summary(195, {}) == "195 nuclei"


async def test_stub_segmentation_geometry_carries_name_classes():
    class _GeomSpyStore:
        def __init__(self):
            self.geometry = None

        async def put(self, **kw):
            self.geometry = kw["geometry"]
            return ArtifactHandle(kind="nuclei", ref="r1", count=kw["geometry"]["count"],
                                  summary=kw["summary"], bbox=kw["bbox"])

        async def get(self, **kw):
            return None

    spy = _GeomSpyStore()
    ctx = ToolContext(owner="u1", conversation_id=1, artifacts=spy)  # no cellvit_url → stub
    scope = {"roi": {"x": 0, "y": 0, "width": 10, "height": 10}}
    out = await run_server_tool(get_tool("run_segmentation"), {}, scope, ctx)

    assert out.ok
    names = {"Neoplastic", "Inflammatory", "Connective", "Dead", "Epithelial"}
    assert set(spy.geometry["classes"]) <= names
    assert len(spy.geometry["classes"]) == len(spy.geometry["points"])
    assert "—" in out.summary  # typed breakdown, not a bare total
