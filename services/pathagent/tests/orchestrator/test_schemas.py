def test_agent_query_request_parses_camelcase():
    from pathagent.common.schemas import AgentQueryRequest

    req = AgentQueryRequest.model_validate(
        {"itemId": "item1", "cacheKey": "item1-abc", "question": "What is this?"}
    )
    assert req.item_id == "item1"
    assert req.cache_key == "item1-abc"
    assert req.question == "What is this?"
    # optional/defaults
    assert req.roi is None
    assert req.task == "auto"


def test_agent_query_request_parses_snakecase():
    from pathagent.common.schemas import AgentQueryRequest

    req = AgentQueryRequest.model_validate(
        {"item_id": "item1", "cache_key": "item1-abc", "question": "hi"}
    )
    assert req.item_id == "item1"
    assert req.cache_key == "item1-abc"


def test_agent_query_request_parses_nested_roi():
    from pathagent.common.schemas import AgentQueryRequest

    req = AgentQueryRequest.model_validate(
        {
            "itemId": "item1",
            "cacheKey": "item1-abc",
            "question": "focus here",
            "task": "Diagnosis",
            "roi": {"x": 10, "y": 20, "width": 256, "height": 512},
        }
    )
    assert req.task == "Diagnosis"
    assert req.roi is not None
    assert req.roi.x == 10
    assert req.roi.y == 20
    assert req.roi.width == 256
    assert req.roi.height == 512


def test_verify_scores_round_trips_camelcase():
    from pathagent.common.schemas import VerifyScores

    dumped = VerifyScores(phi_l=0.5, phi_k=0.3, phi_c=0.2, phi_total=0.9).model_dump(by_alias=True)
    assert dumped["phiL"] == 0.5
    assert dumped["phiK"] == 0.3
    assert dumped["phiC"] == 0.2
    assert dumped["phiTotal"] == 0.9


def test_candidate_default_detail():
    from pathagent.common.schemas import Candidate

    cand = Candidate(source="classifier", answer="IDC")
    assert cand.detail == ""


def test_citation_requires_text_and_source():
    import pytest
    from pydantic import ValidationError

    from pathagent.common.schemas import Citation

    cite = Citation(text="ILC shows single-file pattern", source="seed-kb")
    assert cite.text == "ILC shows single-file pattern"
    assert cite.source == "seed-kb"
    with pytest.raises(ValidationError):
        Citation(text="missing source")
