"""Increment 4 — the planner seam.

The planner decides whether a turn warrants a plan and, if so, proposes steps whose
tool names are constrained to the registry. The stub is deterministic (keyless dev +
tests); Claude is selected when a key is configured, mirroring the chat responder.
"""

from agent.common.config import Settings
from agent.plan import load_registry
from agent.plan.planner import ClaudePlanner, StubPlanner, build_planner

_SCOPE = {"item_id": "s", "roi": {"x": 1, "y": 2, "width": 3, "height": 4}}


async def test_stub_planner_proposes_a_chain_for_quantify_intent():
    raw = await StubPlanner().propose(
        text="count the inflammatory cells in this region", history=[],
        scope=_SCOPE, registry=load_registry(),
    )
    assert raw is not None
    assert [s["tool"] for s in raw["steps"]] == ["nuclei_segment_stub", "count_within_roi"]
    assert raw["reason"]


async def test_stub_planner_declines_plain_chat():
    raw = await StubPlanner().propose(
        text="what is a lymphocyte?", history=[],
        scope={"item_id": "s", "roi": None}, registry=load_registry(),
    )
    assert raw is None


async def test_stub_planner_names_only_registry_tools():
    reg = load_registry()
    raw = await StubPlanner().propose(
        text="quantify tumor cells", history=[], scope=_SCOPE, registry=reg,
    )
    assert all(reg.get(s["tool"]) is not None for s in raw["steps"])


def test_build_planner_selects_backend():
    assert isinstance(build_planner(Settings(anthropic_api_key="")), StubPlanner)
    assert isinstance(build_planner(Settings(anthropic_api_key="sk-test")), ClaudePlanner)
