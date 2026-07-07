"""Integration tests for the compiled M3 graph + run_query (fakes only -- no net)."""

import pytest

from pathagent.common.config import Settings
from pathagent.common.schemas import AgentQueryRequest
from pathagent.orchestrator.graph import run_query
from pathagent.orchestrator.llm_client import LLMError
from pathagent.orchestrator.perception import NavResult, PerceptionError
from pathagent.orchestrator.state import Deps

# Redundant under asyncio_mode=auto, but makes the async intent explicit.
pytestmark = pytest.mark.asyncio


class FakeLLM:
    """Stand-in for LLMClient. One superset JSON serves every complete_json caller.

    ``diagnose`` reads ``answer``/``reasoning``, ``icv`` reads ``phiL`` and
    ``fact`` reads ``phiK`` -- each ``.get()``s only its own key, so a single
    dict carrying all of them satisfies the whole graph.
    """

    def __init__(self, *, text="Findings and final answer.", json_obj=None, raise_error=False):
        self._text = text
        self._json = json_obj if json_obj is not None else {
            "answer": "ILC",
            "reasoning": "single-file infiltration",
            "phiL": 0.9,
            "phiK": 0.8,
        }
        self._raise = raise_error

    def complete(self, system: str, user: str) -> str:
        if self._raise:
            raise LLMError("boom")
        return self._text

    def complete_json(self, system: str, user: str) -> dict:
        if self._raise:
            raise LLMError("boom")
        return self._json


class FakePerception:
    """Stand-in for PerceptionRunner (no subprocess)."""

    def __init__(self, *, result=None, raise_error=False):
        self._result = result
        self._raise = raise_error
        self.calls: list[tuple] = []

    def run(self, cache_key, question, task_id, roi=None):
        self.calls.append((cache_key, question, task_id, roi))
        if self._raise:
            raise PerceptionError("perception boom")
        return self._result


_REGIONS = [
    {"x": 512, "y": 256, "width": 256, "height": 256, "score": 0.9,
     "rationale": "matches: invasive ductal carcinoma"},
    {"x": 1024, "y": 512, "width": 256, "height": 256, "score": 0.7,
     "rationale": "matches: lobular carcinoma"},
    {"x": 0, "y": 0, "width": 256, "height": 256, "score": 0.5,
     "rationale": "coverage sample"},
]

_NAV = NavResult(
    regions=_REGIONS,
    raster_extent={"x": 0, "y": 0, "width": 4096, "height": 4096},
    grid_shape=[4, 4],
    kb_hits=[
        {"id": "k1", "text": "IDC infiltrates stroma.", "source": "WHO (seed)", "score": 0.8},
        {"id": "k2", "text": "ILC grows single-file.", "source": "PathOutlines", "score": 0.6},
    ],
)

_CLASSIFIER = {"prediction": "ILC", "confidence": 70, "idc_prob": 29.1, "ilc_prob": 70.9}


def _deps(*, llm=None, perception=None, classifier=_CLASSIFIER, settings=None) -> Deps:
    return Deps(
        llm=llm or FakeLLM(),
        perception=perception or FakePerception(result=_NAV),
        settings=settings or Settings(),
        classifier=classifier,
    )


def _request() -> AgentQueryRequest:
    return AgentQueryRequest(
        item_id="itemX", cache_key="ck", question="subtype?", task="Diagnosis"
    )


async def test_graph_streams_full_reasoning_loop_in_order():
    deps = _deps()

    events = [ev async for ev in run_query(_request(), deps, "task123")]
    types = [ev["type"] for ev in events]

    # 3 in-bounds regions, deep budget (classifier present) -> visit all three.
    expected_navigate = min(len(_REGIONS), Settings().agent_max_regions)
    assert types.count("navigate") == expected_navigate
    assert types.count("navigate") == 3

    # Ordered phases: route, triage, (navigate, describe)+, diagnose, verify, final.
    assert types[0] == "route"
    assert types[1] == "triage"
    assert types[-1] == "final"
    assert types[-2] == "verify"
    assert types.count("diagnose") == 1
    # Every navigate is immediately followed by its describe.
    for i, kind in enumerate(types):
        if kind == "navigate":
            assert types[i + 1] == "describe"
    # diagnose lands after the last describe and before verification.
    assert types.index("diagnose") == types.index("verify") - 1

    # final event contract.
    final = events[-1]
    assert final["type"] == "final"
    assert final["heatmapTaskId"] == "task123"
    assert final["trail"]  # non-empty exploration trail
    assert len(final["trail"]) == 3
    assert 0 <= final["confidence"] <= 100

    # verify event carries the four camelCase phi scores.
    verify_ev = events[-2]
    scores = verify_ev["scores"]
    assert {"phiL", "phiK", "phiC", "phiTotal"} <= set(scores)
    for key in ("phiL", "phiK", "phiC", "phiTotal"):
        assert 0.0 <= scores[key] <= 1.0


async def test_graph_navigate_count_honors_budget_cap():
    # A tiny budget cap must bound the loop below the region count.
    deps = _deps(settings=Settings(agent_max_regions=2))

    events = [ev async for ev in run_query(_request(), deps, "taskCap")]
    types = [ev["type"] for ev in events]

    assert types.count("navigate") == 2  # min(3 regions, cap of 2)
    assert types[-1] == "final"
    assert len(events[-1]["trail"]) == 2


async def test_graph_abstains_when_perception_fails():
    deps = _deps(perception=FakePerception(raise_error=True))

    # Must not raise: the graph degrades to an abstention rather than crashing.
    events = [ev async for ev in run_query(_request(), deps, "taskERR")]
    types = [ev["type"] for ev in events]

    assert types.count("navigate") == 0  # no regions were reachable
    assert "diagnose" in types  # still diagnoses
    assert types[-1] == "final"  # still produces a final answer
    assert events[-1]["heatmapTaskId"] == "taskERR"


async def test_graph_completes_when_llm_unavailable():
    # Every node degrades gracefully; the stream still terminates with a final.
    deps = _deps(llm=FakeLLM(raise_error=True))

    events = [ev async for ev in run_query(_request(), deps, "taskLLM")]
    types = [ev["type"] for ev in events]

    assert types[0] == "route"
    assert types[-1] == "final"
    assert "diagnose" in types
