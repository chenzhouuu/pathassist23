import pytest

import agent.loop.tools as tools_mod
from agent.loop.artifacts import InMemoryArtifactStore
from agent.loop.biomarker_client import PhenotypeResult
from agent.loop.sdk_tools import sdk_tool_names
from agent.loop.tools import ToolContext, get_tool, run_server_tool

_RESULT = PhenotypeResult(
    count=3,
    counts_by_phenotype={"Tumour": 2, "Cytotoxic T": 1},
    flag_counts={"Proliferating": 1},
    cells=[
        {"x": 10.0, "y": 20.0, "phenotype": "Tumour", "flags": [], "markers": {"CK": 0.9}},
        {"x": 11.0, "y": 21.0, "phenotype": "Tumour", "flags": [], "markers": {"CK": 0.8}},
        {"x": 50.0, "y": 60.0, "phenotype": "Cytotoxic T", "flags": ["Proliferating"],
         "markers": {"CD3": 0.9, "CD8": 0.9, "Ki67": 0.7}},
    ],
    positive_markers=["CK", "CD3", "CD8", "Ki67"],
    mpp=0.5,
)


def _bbox():
    return {"x": 0, "y": 0, "width": 128, "height": 128}


@pytest.mark.asyncio
async def test_phenotype_cells_summary_and_artifact(monkeypatch):
    async def fake(*, base_url, slide_ref, bbox, focus, token):
        assert base_url == "http://bm" and slide_ref == "item9" and token == "tok"
        return _RESULT

    monkeypatch.setattr(tools_mod, "biomarker_phenotype", fake)
    store = InMemoryArtifactStore()
    ctx = ToolContext(owner="u", conversation_id=1, girder_token="tok",
                      biomarker_url="http://bm", artifacts=store)
    out = await run_server_tool(
        get_tool("phenotype_cells"), {"bbox": _bbox()}, {"item_id": "item9"}, ctx
    )
    assert out.ok
    # tool-derived counts, framed predicted + region-relative (review B1)
    assert "3 cells" in out.summary and "2 Tumour" in out.summary
    assert "predicted" in out.summary and "relative to this region" in out.summary
    # artifact handle → the stored geometry carries points, lineages, and per-cell tooltip data
    assert out.artifact is not None and out.artifact.kind == "phenotype" and out.artifact.count == 3
    geom = await store.get(owner="u", ref=out.artifact.ref)
    assert geom["classes"] == ["Tumour", "Tumour", "Cytotoxic T"]
    assert geom["cells"][2]["flags"] == ["Proliferating"]
    # must not leak the backend model name into the model-facing summary
    assert "gigatime" not in out.summary.lower()


@pytest.mark.asyncio
async def test_phenotype_cells_null_bbox_clean_fail():
    ctx = ToolContext(owner="u", conversation_id=1, biomarker_url="http://bm")
    out = await run_server_tool(get_tool("phenotype_cells"), {}, {"item_id": "s"}, ctx)
    assert out.ok is False and "Whole-slide phenotyping isn't available yet" in out.summary


@pytest.mark.asyncio
async def test_phenotype_cells_without_service_degrades():
    ctx = ToolContext(owner="u", conversation_id=1)  # no biomarker_url
    out = await run_server_tool(
        get_tool("phenotype_cells"), {"bbox": _bbox()}, {"item_id": "s"}, ctx
    )
    assert out.ok is False and "configured" in out.summary


@pytest.mark.asyncio
async def test_phenotype_cells_needs_a_slide():
    ctx = ToolContext(owner="u", conversation_id=1, biomarker_url="http://bm")
    out = await run_server_tool(get_tool("phenotype_cells"), {"bbox": _bbox()}, {}, ctx)
    assert out.ok is False and "slide" in out.summary.lower()


@pytest.mark.asyncio
async def test_phenotype_cells_oversize_bbox():
    ctx = ToolContext(owner="u", conversation_id=1, biomarker_url="http://bm")
    big = {"x": 0, "y": 0, "width": 5000, "height": 5000}
    out = await run_server_tool(get_tool("phenotype_cells"), {"bbox": big}, {"item_id": "s"}, ctx)
    assert out.ok is False and "too large" in out.summary


def test_phenotype_cells_is_exposed_to_the_sdk():
    assert "mcp__pathagent__phenotype_cells" in sdk_tool_names()
