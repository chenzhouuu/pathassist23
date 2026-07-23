import pytest

import agent.loop.tools as tools_mod
from agent.loop.preprocess_client import RegionsResult
from agent.loop.sdk_tools import sdk_tool_names
from agent.loop.tools import ToolContext, get_tool, run_server_tool

_REGIONS = [
    {"x": 0, "y": 0, "width": 512, "height": 512, "score": 0.61},
    {"x": 512, "y": 0, "width": 512, "height": 512, "score": 0.55},
]


@pytest.mark.asyncio
async def test_find_regions_returns_inline_regions_artifact(monkeypatch):
    async def fake(*, base_url, item, query, k, token):
        assert base_url == "http://pp" and item == "item9" and token == "tok" and k == 8
        return RegionsResult(regions=_REGIONS, top_score=0.61, encoder="conch_v1", query=query)

    monkeypatch.setattr(tools_mod, "preprocess_find_regions", fake)
    ctx = ToolContext(owner="u", conversation_id=1, girder_token="tok", preprocess_url="http://pp")
    out = await run_server_tool(
        get_tool("find_regions"), {"query": "invasive tumor"}, {"item_id": "item9"}, ctx
    )
    assert out.ok
    assert "invasive tumor" in out.summary and "0.61" in out.summary
    # inline handle (like describe_region): meta rides on the handle, ref empty (N1)
    assert out.artifact is not None and out.artifact.kind == "regions" and out.artifact.ref == ""
    assert out.artifact.count == 2
    assert out.artifact.meta["query"] == "invasive tumor"
    assert out.artifact.meta["regions"] == _REGIONS
    # must not leak the backend name into the model-facing summary
    assert "conch" not in out.summary.lower() and "trident" not in out.summary.lower()


@pytest.mark.asyncio
async def test_find_regions_not_indexed_degrades_cleanly(monkeypatch):
    async def fake(*, base_url, item, query, k, token):
        return None  # service 404/409 → not indexed / image-only

    monkeypatch.setattr(tools_mod, "preprocess_find_regions", fake)
    ctx = ToolContext(owner="u", conversation_id=1, preprocess_url="http://pp")
    out = await run_server_tool(
        get_tool("find_regions"), {"query": "tumor"}, {"item_id": "s"}, ctx
    )
    assert out.ok is False and out.artifact is None
    assert "preprocessed" in out.summary or "index" in out.summary


@pytest.mark.asyncio
async def test_find_regions_requires_a_query():
    ctx = ToolContext(owner="u", conversation_id=1, preprocess_url="http://pp")
    out = await run_server_tool(get_tool("find_regions"), {"query": "  "}, {"item_id": "s"}, ctx)
    assert out.ok is False and "look for" in out.summary.lower()


@pytest.mark.asyncio
async def test_find_regions_without_service_degrades():
    ctx = ToolContext(owner="u", conversation_id=1)  # no preprocess_url
    out = await run_server_tool(
        get_tool("find_regions"), {"query": "tumor"}, {"item_id": "s"}, ctx
    )
    assert out.ok is False and "configured" in out.summary


@pytest.mark.asyncio
async def test_find_regions_needs_a_slide():
    ctx = ToolContext(owner="u", conversation_id=1, preprocess_url="http://pp")
    out = await run_server_tool(get_tool("find_regions"), {"query": "tumor"}, {}, ctx)
    assert out.ok is False and "slide" in out.summary.lower()


def test_find_regions_is_exposed_to_the_sdk():
    assert "mcp__pathagent__find_regions" in sdk_tool_names()
