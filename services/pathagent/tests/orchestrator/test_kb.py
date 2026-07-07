from pathagent.common.schemas import Citation
from pathagent.orchestrator.kb import fact_score, load_seed_kb, to_citations
from pathagent.orchestrator.llm_client import LLMError

_HITS = [
    {"id": "k1", "text": "IDC infiltrates stroma.", "source": "WHO (seed)", "score": 0.8},
    {"id": "k2", "text": "ILC grows single-file.", "source": "PathOutlines (seed)", "score": 0.6},
]


class _FakeLLM:
    """Minimal stub exposing ``complete_json`` (no network)."""

    def __init__(self, result=None, exc=None):
        self._result = result
        self._exc = exc
        self.calls: list[tuple[str, str]] = []

    def complete_json(self, system: str, user: str) -> dict:
        self.calls.append((system, user))
        if self._exc is not None:
            raise self._exc
        return self._result


def test_load_seed_kb_has_enough_unique_entries():
    entries = load_seed_kb()
    assert len(entries) >= 10
    for entry in entries:
        assert entry["id"]
        assert entry["text"]
        assert entry["source"]
    ids = [entry["id"] for entry in entries]
    assert len(ids) == len(set(ids))


def test_to_citations_maps_fields():
    citations = to_citations(_HITS)
    assert len(citations) == 2
    assert all(isinstance(c, Citation) for c in citations)
    assert citations[0].text == "IDC infiltrates stroma."
    assert citations[0].source == "WHO (seed)"
    assert citations[1].source == "PathOutlines (seed)"


def test_to_citations_skips_malformed_hit():
    hits = [
        {"id": "k1", "text": "good", "source": "WHO (seed)", "score": 0.5},
        {"id": "k2", "source": "missing-text (seed)", "score": 0.4},
    ]
    citations = to_citations(hits)
    assert len(citations) == 1
    assert citations[0].text == "good"


def test_fact_score_returns_llm_score_and_citations():
    llm = _FakeLLM(result={"phiK": 0.8})
    score, citations = fact_score(llm, "This is IDC.", _HITS)
    assert score == 0.8
    assert len(citations) == len(_HITS)
    assert llm.calls  # the LLM was actually consulted


def test_fact_score_clamps_high():
    llm = _FakeLLM(result={"phiK": 1.7})
    score, _ = fact_score(llm, "candidate", _HITS)
    assert score == 1.0


def test_fact_score_clamps_low():
    llm = _FakeLLM(result={"phiK": -0.2})
    score, _ = fact_score(llm, "candidate", _HITS)
    assert score == 0.0


def test_fact_score_accepts_snake_case_key():
    llm = _FakeLLM(result={"phi_k": 0.3})
    score, _ = fact_score(llm, "candidate", _HITS)
    assert score == 0.3


def test_fact_score_llm_error_degrades_to_neutral():
    llm = _FakeLLM(exc=LLMError("boom"))
    score, citations = fact_score(llm, "candidate", _HITS)
    assert score == 0.5
    assert len(citations) == len(_HITS)


def test_fact_score_invalid_value_degrades_to_neutral():
    llm = _FakeLLM(result={"phiK": "not-a-number"})
    score, citations = fact_score(llm, "candidate", _HITS)
    assert score == 0.5
    assert len(citations) == len(_HITS)


def test_fact_score_empty_hits_is_neutral_with_no_citations():
    llm = _FakeLLM(result={"phiK": 0.9})
    score, citations = fact_score(llm, "candidate", [])
    assert score == 0.5
    assert citations == []
    assert not llm.calls  # short-circuits before calling the LLM
