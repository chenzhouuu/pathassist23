"""Unit tests for the M3 verification branches + summary (fakes only -- no network)."""

from pathagent.common.config import Settings
from pathagent.orchestrator import verify
from pathagent.orchestrator.llm_client import LLMError
from pathagent.orchestrator.state import Deps


class FakeLLM:
    """Configurable stand-in for LLMClient (no network)."""

    def __init__(self, *, text="Final answer.", json_obj=None, raise_error=False):
        self._text = text
        self._json = json_obj if json_obj is not None else {}
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


_HITS = [
    {"id": "k1", "text": "IDC infiltrates stroma.", "source": "WHO (seed)", "score": 0.8},
    {"id": "k2", "text": "ILC grows single-file.", "source": "PathOutlines (seed)", "score": 0.6},
]


def _deps(*, llm=None, classifier=None, settings=None) -> Deps:
    # perception is unused by the verify branches; None keeps the fakes minimal.
    return Deps(
        llm=llm or FakeLLM(),
        perception=None,  # type: ignore[arg-type]
        settings=settings or Settings(),
        classifier=classifier,
    )


# ── icv (phi_l) ──────────────────────────────────────────────────────────────


def test_icv_returns_llm_score():
    llm = FakeLLM(json_obj={"phiL": 0.9})
    out = verify.icv({"prelim": "IDC"}, _deps(llm=llm))

    assert out["phi_l"] == 0.9
    assert len(llm.complete_json_calls) == 1  # the LLM was actually consulted


def test_icv_llm_error_degrades_to_neutral():
    llm = FakeLLM(raise_error=True)
    out = verify.icv({"prelim": "IDC"}, _deps(llm=llm))  # must not raise

    assert out["phi_l"] == 0.5


def test_icv_clamps_high():
    llm = FakeLLM(json_obj={"phiL": 1.5})
    out = verify.icv({"prelim": "IDC"}, _deps(llm=llm))

    assert out["phi_l"] == 1.0


# ── fact (phi_k) ─────────────────────────────────────────────────────────────


def test_fact_with_hits_returns_score_and_citations():
    llm = FakeLLM(json_obj={"phiK": 0.8})
    state = {
        "candidates": [{"source": "classifier", "answer": "IDC", "detail": ""}],
        "nav": {"kb_hits": _HITS},
    }

    out = verify.fact(state, _deps(llm=llm))

    assert out["phi_k"] == 0.8
    assert len(out["citations"]) == len(_HITS)
    # citations are camelCase-dumped Citation models
    assert out["citations"][0] == {"text": "IDC infiltrates stroma.", "source": "WHO (seed)"}


def test_fact_empty_nav_is_neutral_with_no_citations():
    llm = FakeLLM(json_obj={"phiK": 0.9})

    out = verify.fact({"candidates": []}, _deps(llm=llm))

    assert out["phi_k"] == 0.5
    assert out["citations"] == []
    assert not llm.complete_json_calls  # short-circuits before the LLM


# ── consensus (phi_c) ────────────────────────────────────────────────────────


def test_consensus_agreement_uses_classifier_confidence():
    state = {"candidates": [{"source": "classifier", "answer": "ILC", "detail": ""}]}
    deps = _deps(classifier={"confidence": 70})

    out = verify.consensus(state, deps)

    assert out["phi_c"] == 0.7
    assert out["consensus_note"] == ""


def test_consensus_disagreement_lowers_confidence_and_notes():
    # Artificial divergence between the classifier candidate ("IDC", which the
    # chosen answer resolves to) and the raw prediction ("ILC") to exercise the
    # disagreement branch.
    state = {"candidates": [{"source": "classifier", "answer": "IDC", "detail": ""}]}
    deps = _deps(classifier={"confidence": 70, "prediction": "ILC"})

    out = verify.consensus(state, deps)

    assert out["phi_c"] <= 0.3
    assert out["consensus_note"]  # non-empty
    assert "ILC" in out["consensus_note"]


def test_consensus_no_classifier_candidate_is_neutral():
    state = {"candidates": [{"source": "llm", "answer": "IDC", "detail": ""}]}

    out = verify.consensus(state, _deps(classifier=None))

    assert out["phi_c"] == 0.5
    assert "no consensus source" in out["consensus_note"]


# ── summary (phi_total + final) ──────────────────────────────────────────────


_VISITED = [
    {"x": 512, "y": 256, "width": 256, "height": 256, "score": 0.9},
    {"x": 0, "y": 0, "width": 128, "height": 128, "score": 0.6},
]


def _summary_state(**overrides) -> dict:
    state = {
        "task_id": "task-123",
        "candidates": [
            {"source": "classifier", "answer": "IDC", "detail": "IDC 88%"},
            {"source": "llm", "answer": "IDC", "detail": "ductal pattern"},
        ],
        "prelim": "IDC",
        "visited": _VISITED,
        "citations": [{"text": "IDC fact", "source": "WHO (seed)"}],
        "consensus_note": "",
        "phi_l": 0.9,
        "phi_k": 0.8,
        "phi_c": 0.7,
    }
    state.update(overrides)
    return state


def test_summary_weighted_phi_total_and_events():
    llm = FakeLLM(text="This is IDC with high confidence.")
    settings = Settings()  # phi_weights default (0.34, 0.33, 0.33)

    out = verify.summary(_summary_state(), _deps(llm=llm, settings=settings))

    w_l, w_k, w_c = settings.phi_weights
    expected = (w_l * 0.9 + w_k * 0.8 + w_c * 0.7) / (w_l + w_k + w_c)
    assert abs(out["scores"]["phi_total"] - expected) < 1e-3
    assert out["final"]["confidence"] == 80
    assert out["final"]["answer"] == "This is IDC with high confidence."

    events = out["events"]
    assert [e["type"] for e in events] == ["verify", "final"]

    verify_event = events[0]
    assert set(verify_event["scores"]) == {"phiL", "phiK", "phiC", "phiTotal"}
    assert abs(verify_event["scores"]["phiTotal"] - expected) < 1e-3

    final_event = events[1]
    assert final_event["heatmapTaskId"] == "task-123"
    assert final_event["trail"]  # non-empty (built from visited)
    assert final_event["trail"][0] == {"x": 512, "y": 256, "width": 256, "height": 256}


def test_summary_llm_error_uses_templated_final():
    llm = FakeLLM(raise_error=True)

    out = verify.summary(_summary_state(), _deps(llm=llm))  # must not raise

    answer = out["final"]["answer"]
    assert "IDC" in answer  # templated from the chosen answer
    assert "80%" in answer  # templated confidence


def test_summary_renormalizes_over_present_branches():
    settings = Settings()
    state = _summary_state(phi_l=0.9, phi_c=0.6)
    state.pop("phi_k", None)  # phi_k branch did not run -> excluded from weighting

    out = verify.summary(state, _deps(settings=settings))

    w_l, w_k, w_c = settings.phi_weights
    expected = (w_l * 0.9 + w_c * 0.6) / (w_l + w_c)
    assert abs(out["scores"]["phi_total"] - expected) < 1e-3
    # missing component still gets a neutral display default
    assert out["scores"]["phi_k"] == 0.5


def test_consensus_survives_non_numeric_confidence():
    # A malformed classifier confidence must not raise (structural never-raise guarantee).
    state = {"candidates": [{"source": "classifier", "answer": "ILC"}], "prelim": "ILC"}
    out = verify.consensus(state, _deps(classifier={"prediction": "ILC", "confidence": "bad"}))

    assert 0.0 <= out["phi_c"] <= 1.0  # degraded to neutral, no exception
