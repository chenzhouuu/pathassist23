"""Increment 4 — tool registry, plan validation, and the plan digest (pure functions).

These gate the planner: a plan must name only real tools, satisfy each tool's
argument schema, and be a valid producer→consumer chain BEFORE a human ever sees it.
"""

from agent.plan import load_registry, plan_digest, validate_plan


def _plan(steps, roi=True):
    return {
        "scope": {"item_id": "slide-1", "roi": {"x": 10, "y": 20, "width": 30, "height": 40}
                  if roi else None},
        "steps": steps,
    }


def test_registry_loads_stub_tools():
    reg = load_registry()
    seg = reg.get("nuclei_segment_stub")
    assert seg is not None
    assert seg["category"] == "NucleiSeg"
    assert "nuclei" in seg["produces"]["artifacts"]
    assert "count_within_roi" in reg.names()
    assert reg.get("does_not_exist") is None


def test_registry_version_is_stable():
    assert load_registry().version == load_registry().version


def test_validate_accepts_a_good_chain():
    reg = load_registry()
    plan = _plan([
        {"n": 1, "tool": "nuclei_segment_stub", "args": {"mpp": 0.25}},
        {"n": 2, "tool": "count_within_roi", "args": {"cell_class": "lymphocyte"}},
    ])
    assert validate_plan(plan, reg) == []


def test_validate_rejects_unknown_tool():
    reg = load_registry()
    plan = _plan([{"n": 1, "tool": "totally_made_up", "args": {}}])
    errors = validate_plan(plan, reg)
    assert any("totally_made_up" in e for e in errors)


def test_validate_rejects_broken_dependency():
    # count_within_roi consumes `nuclei`, which no prior step produced.
    reg = load_registry()
    plan = _plan([{"n": 1, "tool": "count_within_roi", "args": {"cell_class": "lymphocyte"}}])
    errors = validate_plan(plan, reg)
    assert any("nuclei" in e for e in errors)


def test_validate_requires_roi_in_scope_when_a_tool_consumes_it():
    reg = load_registry()
    plan = _plan([
        {"n": 1, "tool": "nuclei_segment_stub", "args": {"mpp": 0.25}},
        {"n": 2, "tool": "count_within_roi", "args": {"cell_class": "lymphocyte"}},
    ], roi=False)
    errors = validate_plan(plan, reg)
    assert any("roi" in e for e in errors)


def test_validate_rejects_bad_args_against_tool_schema():
    reg = load_registry()
    # mpp must be > 0; cell_class is required for the count tool.
    bad_mpp = _plan([{"n": 1, "tool": "nuclei_segment_stub", "args": {"mpp": -1}}])
    assert validate_plan(bad_mpp, reg)
    missing_class = _plan([
        {"n": 1, "tool": "nuclei_segment_stub", "args": {"mpp": 0.25}},
        {"n": 2, "tool": "count_within_roi", "args": {}},
    ])
    assert validate_plan(missing_class, reg)


def test_validate_rejects_category_mismatch():
    reg = load_registry()
    plan = _plan([{"n": 1, "tool": "nuclei_segment_stub", "category": "Quantify",
                   "args": {"mpp": 0.25}}])
    assert any("categor" in e.lower() for e in validate_plan(plan, reg))


def test_plan_digest_is_deterministic_and_scope_sensitive():
    steps = [{"n": 1, "tool": "nuclei_segment_stub", "args": {"mpp": 0.25}}]
    scope_a = {"item_id": "s1", "roi": {"x": 1, "y": 2, "width": 3, "height": 4}}
    scope_b = {"item_id": "s1", "roi": {"x": 9, "y": 9, "width": 9, "height": 9}}
    d = plan_digest(steps, scope_a, "v1")
    assert d == plan_digest(steps, scope_a, "v1")   # deterministic
    assert d != plan_digest(steps, scope_b, "v1")   # ROI changes the digest
    assert d != plan_digest(steps, scope_a, "v2")   # registry version changes it
    assert len(d) == 12 and all(c in "0123456789abcdef" for c in d)
