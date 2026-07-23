import pytest

import agent.loop.tools as tools_mod
from agent.loop.pathvlm_client import DescribeResult
from agent.loop.sdk_tools import sdk_tool_names
from agent.loop.tools import ToolContext, get_tool, run_server_tool


@pytest.mark.asyncio
async def test_describe_region_returns_region_grounded_summary_without_tool_name(monkeypatch):
    async def fake(*, base_url, slide_ref, bbox, magnification, focus, token):
        assert base_url == "http://p" and slide_ref == "item9" and token == "tok"
        assert focus == "atypia" and magnification == 20
        return DescribeResult(description="pleomorphic nuclei", magnification=20.0, mpp=0.5)

    monkeypatch.setattr(tools_mod, "pathvlm_describe", fake)
    ctx = ToolContext(owner="u", conversation_id=1, girder_token="tok", pathvlm_url="http://p")
    out = await run_server_tool(
        get_tool("describe_region"),
        {"bbox": {"x": 100, "y": 200, "width": 512, "height": 512},
         "magnification": 20, "focus": "atypia"},
        {"item_id": "item9"}, ctx,
    )
    assert out.ok
    # Inc 2c: the read region rides back as a lightweight rectangle artifact.
    assert out.artifact is not None and out.artifact.kind == "region"
    assert out.artifact.bbox == {"x": 100, "y": 200, "width": 512, "height": 512}
    assert out.artifact.meta["magnification"] == 20.0
    # Grounds the read to the region + magnification, but must NOT leak the backend tool name
    # into the model-facing summary (the trace/overlay carries the provenance instead).
    assert out.summary == "Morphology of region (100,200) at 20x: pleomorphic nuclei"
    assert "MedGemma" not in out.summary


@pytest.mark.asyncio
async def test_describe_region_falls_back_to_the_drawn_roi(monkeypatch):
    seen = {}

    async def fake(*, base_url, slide_ref, bbox, magnification, focus, token):
        seen["bbox"] = bbox
        return DescribeResult(description="stroma", magnification=10.0)

    monkeypatch.setattr(tools_mod, "pathvlm_describe", fake)
    ctx = ToolContext(owner="u", conversation_id=1, pathvlm_url="http://p")
    out = await run_server_tool(
        get_tool("describe_region"), {},  # no bbox arg → use the drawn ROI (D8)
        {"item_id": "s", "roi": {"x": 5, "y": 6, "width": 32, "height": 32}}, ctx,
    )
    assert out.ok and seen["bbox"] == {"x": 5, "y": 6, "width": 32, "height": 32}
    # the artifact echoes the resolved ROI even when the model passed no bbox.
    assert out.artifact.kind == "region"
    assert out.artifact.bbox == {"x": 5, "y": 6, "width": 32, "height": 32}


@pytest.mark.asyncio
async def test_describe_region_without_service_degrades():
    ctx = ToolContext(owner="u", conversation_id=1)  # no pathvlm_url
    out = await run_server_tool(
        get_tool("describe_region"),
        {"bbox": {"x": 0, "y": 0, "width": 8, "height": 8}}, {"item_id": "s"}, ctx,
    )
    assert out.ok is False and "Perceptor service" in out.summary


@pytest.mark.asyncio
async def test_describe_region_needs_a_region():
    ctx = ToolContext(owner="u", conversation_id=1, pathvlm_url="http://p")
    out = await run_server_tool(get_tool("describe_region"), {}, {"item_id": "s"}, ctx)
    assert out.ok is False and "region" in out.summary.lower()


def test_describe_region_is_exposed_to_the_sdk():
    assert "mcp__pathagent__describe_region" in sdk_tool_names()
