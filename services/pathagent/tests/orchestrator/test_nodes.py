"""Unit tests for the five M3 reasoning nodes (fakes only -- no network/torch)."""

from pathagent.common.config import Settings
from pathagent.orchestrator import nodes
from pathagent.orchestrator.llm_client import LLMError
from pathagent.orchestrator.perception import NavResult, PerceptionError
from pathagent.orchestrator.state import Deps


class FakeLLM:
    """Configurable stand-in for LLMClient (no network)."""

    def __init__(self, *, text="findings text", json_obj=None, raise_error=False):
        self._text = text
        self._json = json_obj if json_obj is not None else {"answer": "IDC", "reasoning": "why"}
        self._raise = raise_error
        self.complete_calls: list[tuple[str, str]] = []
        self.complete_json_calls: list[tuple[str, str]] = []

    def complete(self, system: str, user: str) -> str:
        self.complete_calls.append((system, user))
        if self._raise:
            raise LLMError("boom")
        return self._text

    def complete_json(self, system: str, user: str) -> dict:
        self.complete_json_calls.append((system, user))
        if self._raise:
            raise LLMError("boom")
        return self._json


class FakePerception:
    """Configurable stand-in for PerceptionRunner (no subprocess)."""

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
    {"x": 0, "y": 0, "width": 256, "height": 256, "score": 0.6,
     "rationale": "coverage sample"},
]

_NAV = NavResult(
    regions=_REGIONS,
    raster_extent={"x": 0, "y": 0, "width": 4096, "height": 4096},
    grid_shape=[4, 4],
    kb_hits=[{"id": "k1", "text": "IDC fact", "source": "WHO", "score": 0.7}],
)

_CLASSIFIER = {
    "model": "brca-abmil",
    "prediction": "IDC",
    "confidence": 88.0,
    "idc_prob": 88.0,
    "ilc_prob": 12.0,
    "num_patches": 100,
}


def _deps(*, llm=None, perception=None, classifier=None, settings=None) -> Deps:
    return Deps(
        llm=llm or FakeLLM(),
        perception=perception or FakePerception(result=_NAV),
        settings=settings or Settings(),
        classifier=classifier,
    )


# ── router ───────────────────────────────────────────────────────────────────


def test_router_sets_diagnosis_and_emits_route_event():
    out = nodes.router({"question": "any carcinoma?"}, _deps())

    assert out["task"] == "Diagnosis"
    assert len(out["events"]) == 1
    event = out["events"][0]
    assert event["type"] == "route"
    assert event["task"] == "Diagnosis"
    assert "navigate" in event["tools"]


# ── triage ───────────────────────────────────────────────────────────────────


def test_triage_with_classifier_uses_deep_budget():
    settings = Settings()
    out = nodes.triage({}, _deps(classifier=_CLASSIFIER, settings=settings))

    assert out["budget"]["max_regions"] == settings.agent_max_regions
    assert out["budget"]["spent"] == 0
    event = out["events"][0]
    assert event["type"] == "triage"
    assert event["risk"] == "suspicious"
    assert event["depth"] == "deep"
    assert event["maxRegions"] == settings.agent_max_regions


def test_triage_without_classifier_uses_moderate_budget():
    settings = Settings()
    out = nodes.triage({}, _deps(classifier=None, settings=settings))

    assert out["budget"]["max_regions"] == min(4, settings.agent_max_regions)
    event = out["events"][0]
    assert event["risk"] == "uncertain"
    assert event["depth"] == "moderate"


def test_triage_without_classifier_clamps_below_four():
    # cap < 4 -> min(4, cap) must clamp to the cap, not a hardcoded 4.
    settings = Settings(agent_max_regions=2)
    out = nodes.triage({}, _deps(classifier=None, settings=settings))

    assert out["budget"]["max_regions"] == 2
    assert out["events"][0]["maxRegions"] == 2


# ── navigate ─────────────────────────────────────────────────────────────────


def test_navigate_first_call_runs_perception_and_emits_one_region():
    perception = FakePerception(result=_NAV)
    deps = _deps(perception=perception)
    state = {
        "cache_key": "ck", "question": "q?", "task_id": "t1",
        "budget": {"max_regions": 8, "spent": 0},
    }

    out = nodes.navigate(state, deps)

    assert len(perception.calls) == 1  # perception runs exactly once
    assert out["nav"]["regions"] == _REGIONS  # nav persisted for later calls
    assert out["visited"] == [_REGIONS[0]]  # exactly one region visited

    assert len(out["events"]) == 1
    event = out["events"][0]
    assert event["type"] == "navigate"
    assert set(event["region"]) == {"x", "y", "width", "height"}  # box only
    assert event["region"] == {"x": 512, "y": 256, "width": 256, "height": 256}
    assert event["rationale"] == "matches: invasive ductal carcinoma"


def test_navigate_second_call_reuses_nav_and_advances_index():
    perception = FakePerception(result=_NAV)
    deps = _deps(perception=perception)
    nav = {"regions": _REGIONS, "raster_extent": None, "grid_shape": [4, 4], "kb_hits": []}
    state = {
        "cache_key": "ck", "question": "q?", "task_id": "t1",
        "nav": nav, "visited": [_REGIONS[0]],
        "budget": {"max_regions": 8, "spent": 0},
    }

    out = nodes.navigate(state, deps)

    assert perception.calls == []  # nav already computed -> no perception rerun
    assert out["visited"] == [_REGIONS[1]]
    assert out["events"][0]["region"] == {"x": 0, "y": 0, "width": 256, "height": 256}


def test_navigate_respects_budget_and_emits_no_event_when_exhausted():
    perception = FakePerception(result=_NAV)
    deps = _deps(perception=perception)
    nav = {"regions": _REGIONS, "raster_extent": None, "grid_shape": [4, 4], "kb_hits": []}
    state = {
        "cache_key": "ck", "question": "q?", "task_id": "t1",
        "nav": nav, "visited": [_REGIONS[0], _REGIONS[1]],
        "budget": {"max_regions": 2, "spent": 0},
    }

    out = nodes.navigate(state, deps)

    assert perception.calls == []
    assert "visited" not in out
    assert out["events"] == []


def test_navigate_stops_on_budget_even_with_regions_remaining():
    # Budget is the ONLY binding constraint: 2 regions available, budget of 1,
    # already 1 visited -> must emit nothing (isolates the `idx < max_regions` cap).
    perception = FakePerception(result=_NAV)
    deps = _deps(perception=perception)
    nav = {"regions": _REGIONS, "raster_extent": None, "grid_shape": [4, 4], "kb_hits": []}
    state = {
        "cache_key": "ck", "question": "q?", "task_id": "t1",
        "nav": nav, "visited": [_REGIONS[0]],
        "budget": {"max_regions": 1, "spent": 0},
    }

    out = nodes.navigate(state, deps)

    assert perception.calls == []
    assert "visited" not in out
    assert out["events"] == []


def test_navigate_perception_error_degrades_without_raising():
    perception = FakePerception(raise_error=True)
    deps = _deps(perception=perception)
    state = {
        "cache_key": "ck", "question": "q?", "task_id": "t1",
        "budget": {"max_regions": 8, "spent": 0},
    }

    out = nodes.navigate(state, deps)  # must not raise

    assert out["nav"]["regions"] == []
    assert out["nav"]["error"] == "perception failed"
    assert "visited" not in out
    assert out["events"] == []


# ── describe ─────────────────────────────────────────────────────────────────


def test_describe_emits_findings_event():
    llm = FakeLLM(text="Tubule formation with high-grade nuclei.")
    deps = _deps(llm=llm)
    state = {"visited": [_REGIONS[0]]}

    out = nodes.describe(state, deps)

    assert len(llm.complete_calls) == 1
    event = out["events"][0]
    assert event["type"] == "describe"
    assert event["findings"] == "Tubule formation with high-grade nuclei."
    assert out["descriptions"][0]["findings"] == "Tubule formation with high-grade nuclei."
    assert out["descriptions"][0]["region"] == _REGIONS[0]


def test_describe_llm_error_uses_templated_fallback():
    llm = FakeLLM(raise_error=True)
    deps = _deps(llm=llm)
    state = {"visited": [_REGIONS[0]]}

    out = nodes.describe(state, deps)  # must not raise

    findings = out["descriptions"][0]["findings"]
    assert "512" in findings  # templated from the region coordinates
    assert out["events"][0]["type"] == "describe"


def test_describe_without_visited_is_noop():
    out = nodes.describe({}, _deps())

    assert out == {"events": []}


# ── diagnose ─────────────────────────────────────────────────────────────────


def test_diagnose_with_classifier_includes_both_candidates():
    llm = FakeLLM(json_obj={"answer": "ILC", "reasoning": "single-file growth"})
    deps = _deps(llm=llm, classifier=_CLASSIFIER)
    state = {"descriptions": [{"region": _REGIONS[0], "findings": "single-file cells"}]}

    out = nodes.diagnose(state, deps)

    sources = [c["source"] for c in out["candidates"]]
    assert "classifier" in sources
    assert "llm" in sources
    clf = next(c for c in out["candidates"] if c["source"] == "classifier")
    assert clf["answer"] == _CLASSIFIER["prediction"]
    assert out["prelim"] == "IDC"  # prefers the classifier answer
    assert out["events"][0]["type"] == "diagnose"


def test_diagnose_without_classifier_has_only_llm_candidate():
    llm = FakeLLM(json_obj={"answer": "IDC", "reasoning": "ductal pattern"})
    deps = _deps(llm=llm, classifier=None)

    out = nodes.diagnose({"descriptions": []}, deps)

    assert [c["source"] for c in out["candidates"]] == ["llm"]
    assert out["prelim"] == "IDC"


def test_diagnose_llm_error_degrades_but_returns_candidates():
    llm = FakeLLM(raise_error=True)
    deps = _deps(llm=llm, classifier=_CLASSIFIER)

    out = nodes.diagnose({"descriptions": []}, deps)  # must not raise

    llm_cand = next(c for c in out["candidates"] if c["source"] == "llm")
    assert llm_cand["answer"] == "IDC"  # falls back to the classifier prediction
    assert llm_cand["detail"] == "LLM unavailable"
    assert out["prelim"] == "IDC"


def test_diagnose_no_classifier_llm_error_is_uncertain():
    llm = FakeLLM(raise_error=True)
    deps = _deps(llm=llm, classifier=None)

    out = nodes.diagnose({"descriptions": []}, deps)  # must not raise

    assert [c["source"] for c in out["candidates"]] == ["llm"]
    assert out["candidates"][0]["answer"] == "uncertain"
    assert out["prelim"] == "uncertain"


def test_diagnose_survives_malformed_classifier():
    # A classifier dict missing prob keys must not raise (defensive .get access).
    llm = FakeLLM(json_obj={"answer": "ILC", "reasoning": "x"})
    out = nodes.diagnose({"descriptions": []}, _deps(llm=llm, classifier={"prediction": "ILC"}))

    clf = next(c for c in out["candidates"] if c["source"] == "classifier")
    assert clf["answer"] == "ILC"
    assert "?" in clf["detail"]  # missing probs render as '?', not a KeyError
    assert out["prelim"] == "ILC"
