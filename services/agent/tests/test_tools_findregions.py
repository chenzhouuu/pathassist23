import pytest

import agent.loop.tools as tools_mod
from agent.loop.preprocess_client import RegionsResult
from agent.loop.sdk_tools import sdk_tool_names
from agent.loop.tools import ToolContext, get_tool, run_server_tool
from agent.store import MemoryPreprocessArtifactStore

_REGIONS = [
    {"x": 0, "y": 0, "width": 512, "height": 512, "score": 0.61},
    {"x": 512, "y": 0, "width": 512, "height": 512, "score": 0.55},
]


@pytest.mark.asyncio
async def test_find_regions_returns_inline_regions_artifact(monkeypatch):
    async def fake(*, base_url, item, query, k, token, feat_hash=None, encoder=None):
        assert base_url == "http://pp" and item == "item9" and token == "tok" and k == 8
        return RegionsResult(regions=_REGIONS, top_score=0.61, encoder="conch_v1_text", query=query)

    monkeypatch.setattr(tools_mod, "preprocess_find_regions", fake)
    ctx = ToolContext(owner="u", conversation_id=1, girder_token="tok", preprocess_url="http://pp")
    out = await run_server_tool(
        get_tool("find_regions"), {"query": "invasive tumor"}, {"item_id": "item9"}, ctx
    )
    assert out.ok
    # candidate generator: names the query + count and frames them as leads to verify (no score)
    assert "invasive tumor" in out.summary and "candidate" in out.summary
    # inline handle: the candidate coordinates ride the handle meta, ref empty (N1)
    assert out.artifact is not None and out.artifact.kind == "regions" and out.artifact.ref == ""
    assert out.artifact.count == 2
    assert out.artifact.meta["query"] == "invasive tumor"
    assert out.artifact.meta["regions"] == _REGIONS
    # must not leak the backend name into the model-facing summary
    assert "conch" not in out.summary.lower() and "trident" not in out.summary.lower()


@pytest.mark.asyncio
async def test_find_regions_not_indexed_degrades_cleanly(monkeypatch):
    async def fake(*, base_url, item, query, k, token, feat_hash=None, encoder=None):
        return None  # service 404/409 → not indexed / image-only

    monkeypatch.setattr(tools_mod, "preprocess_find_regions", fake)
    ctx = ToolContext(owner="u", conversation_id=1, preprocess_url="http://pp")
    out = await run_server_tool(
        get_tool("find_regions"), {"query": "tumor"}, {"item_id": "s"}, ctx
    )
    assert out.ok is False and out.artifact is None
    assert "preprocessed" in out.summary or "index" in out.summary


@pytest.mark.asyncio
async def test_find_regions_resolves_dag_feat_hash(monkeypatch):
    """A DAG-built slide: find_regions must point the worker at the ready text-capable features
    artifact's feat_hash (else the worker falls back to the flat cache the DAG never writes)."""
    seen = {}

    async def fake(*, base_url, item, query, k, token, feat_hash=None, encoder=None):
        seen["feat_hash"] = feat_hash
        seen["encoder"] = encoder
        return RegionsResult(regions=_REGIONS, top_score=0.61, encoder="conch_v1_text", query=query)

    monkeypatch.setattr(tools_mod, "preprocess_find_regions", fake)
    store = MemoryPreprocessArtifactStore()
    # An image-only features row is newer, but must be skipped for a text-capable one.
    await store.upsert_artifact(
        item="s", kind="features", art_hash="feat_conch", parent_hash="p",
        params={"encoder": "conch_v1_text"}, status="ready",
    )
    await store.upsert_artifact(
        item="s", kind="features", art_hash="feat_uni", parent_hash="p",
        params={"encoder": "uni_v2"}, status="ready",
    )
    ctx = ToolContext(
        owner="u", conversation_id=1, preprocess_url="http://pp", preprocess_artifacts=store,
    )
    out = await run_server_tool(
        get_tool("find_regions"), {"query": "tumor"}, {"item_id": "s"}, ctx
    )
    assert out.ok
    assert seen["feat_hash"] == "feat_conch" and seen["encoder"] == "conch_v1_text"


@pytest.mark.asyncio
async def test_find_regions_no_dag_row_keeps_legacy_path(monkeypatch):
    """No DAG features row (legacy flat index / unprocessed) → feat_hash stays None so the worker
    resolves the legacy index by params."""
    seen = {}

    async def fake(*, base_url, item, query, k, token, feat_hash=None, encoder=None):
        seen["feat_hash"] = feat_hash
        return RegionsResult(regions=_REGIONS, top_score=0.61, encoder="conch_v1_text", query=query)

    monkeypatch.setattr(tools_mod, "preprocess_find_regions", fake)
    ctx = ToolContext(
        owner="u", conversation_id=1, preprocess_url="http://pp",
        preprocess_artifacts=MemoryPreprocessArtifactStore(),
    )
    out = await run_server_tool(
        get_tool("find_regions"), {"query": "tumor"}, {"item_id": "s"}, ctx
    )
    assert out.ok and seen["feat_hash"] is None


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
