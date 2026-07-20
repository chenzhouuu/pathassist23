"""The deterministic Claim builder (increment 6a).

A Claim is built from a completed run's canonical result — the LLM never emits the
number. The builder is a pure function: same run → identical Claim, evidence bound to
the produced artifacts, method versions recorded for provenance.
"""

from agent.claim import build_claim

_PLAN = {
    "digest": "abc123def456",
    "scope": {"item_id": "slideA", "roi": {"x": 10, "y": 20, "width": 300, "height": 240}},
    "steps": [
        {"n": 1, "tool": "nuclei_segment_stub", "category": "segmentation", "args": {}},
        {"n": 2, "tool": "count_within_roi", "category": "quantification",
         "args": {"cell_class": "inflammatory"}},
    ],
}
_VALUES = {"cell_class": "inflammatory", "count": 154, "density": 11503.0,
           "density_unit": "cells/mm²"}
_ARTIFACTS = {"nuclei": {"kind": "nuclei", "points": [[1, 2]], "count": 154}}


def _build():
    return build_claim(plan=_PLAN, run_id=7, values=_VALUES, artifacts=_ARTIFACTS,
                       registry_version="regv1")


def test_build_claim_shapes_run_into_an_assertion():
    c = _build()
    assert c["plan_digest"] == "abc123def456"
    assert c["subject"] == "inflammatory"      # from the counted cell_class
    assert c["predicate"] == "count"
    assert c["value"] == 154                   # the authoritative number, from the result
    assert c["unit"] == "cells"
    assert c["scope"] == _PLAN["scope"]
    assert c["metrics"] == _VALUES             # full canonical result retained
    assert c["status"] == "asserted"


def test_build_claim_binds_evidence_to_produced_artifacts():
    c = _build()
    assert c["evidence"] == [{"run_id": 7, "key": "nuclei"}]


def test_build_claim_records_method_versions_for_provenance():
    c = _build()
    assert c["method_versions"]["registry_version"] == "regv1"
    assert c["method_versions"]["tools"] == ["nuclei_segment_stub", "count_within_roi"]


def test_build_claim_is_deterministic():
    assert _build() == _build()


def test_build_claim_subject_defaults_when_no_cell_class():
    c = build_claim(plan=_PLAN, run_id=1, values={"count": 3}, artifacts={},
                    registry_version="r")
    assert c["subject"] == "cells"
    assert c["value"] == 3
    assert c["evidence"] == []
