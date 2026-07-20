"""Stub executor — the stateless tool-invocation seam (increment 5).

`invoke(tool, args, scope, artifacts)` runs one tool and returns the artifacts/values
it produces; increments 7–8 swap the canned bodies for CellViT++/Histolytics behind
this identical signature. These tests pin the canned contract the overlay depends on.
"""

import pytest

from agent.run.executor import ExecutionError, execute_plan, invoke

_ROI = {"kind": "rect", "x": 44145, "y": 27470, "width": 525, "height": 408}
_SCOPE = {"item_id": "slide1", "roi": _ROI}
_CHAIN = [
    {"n": 1, "tool": "nuclei_segment_stub", "args": {"mpp": 0.25}},
    {"n": 2, "tool": "count_within_roi", "args": {"cell_class": "lymphocyte"}},
]


def test_nuclei_stub_produces_points_inside_the_roi():
    res = invoke("nuclei_segment_stub", {"mpp": 0.25}, _SCOPE, {})
    nuclei = res.artifacts["nuclei"]
    assert nuclei["kind"] == "nuclei" and nuclei["geometry"] == "points"
    assert nuclei["count"] == len(nuclei["points"]) > 0
    x, y, w, h = _ROI["x"], _ROI["y"], _ROI["width"], _ROI["height"]
    for px, py in nuclei["points"]:
        assert x <= px <= x + w and y <= py <= y + h
    assert nuclei["level0"] == {k: _ROI[k] for k in ("x", "y", "width", "height")}


def test_count_reads_the_nuclei_artifact():
    seg = invoke("nuclei_segment_stub", {"mpp": 0.25}, _SCOPE, {})
    res = invoke("count_within_roi", {"cell_class": "lymphocyte"}, _SCOPE, seg.artifacts)
    assert res.values["count"] == seg.artifacts["nuclei"]["count"]
    assert res.values["cell_class"] == "lymphocyte"
    assert res.values["density"] > 0


def test_execute_plan_threads_artifacts_through_the_chain():
    out = execute_plan(_CHAIN, _SCOPE)
    assert "nuclei" in out["artifacts"]
    assert out["values"]["count"] == out["artifacts"]["nuclei"]["count"]
    assert [s["n"] for s in out["steps"]] == [1, 2]


def test_executor_is_deterministic():
    a = execute_plan(_CHAIN, _SCOPE)
    b = execute_plan(_CHAIN, _SCOPE)
    assert a["artifacts"]["nuclei"]["points"] == b["artifacts"]["nuclei"]["points"]
    assert a["values"] == b["values"]


def test_unknown_tool_raises():
    with pytest.raises(ExecutionError):
        invoke("does_not_exist", {}, _SCOPE, {})
