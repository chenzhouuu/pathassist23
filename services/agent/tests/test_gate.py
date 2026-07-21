"""R10.4b — PreToolUse gating: the *controllable* half of the autonomous loop.

A single-turn `query` runs the whole agentic loop with no pause point, so approval is a
policy the human sets, enforced deterministically by a PreToolUse hook (the SDK's documented
way to gate every tool call regardless of permission_mode). These pin the pure decision and
the exact SDK output shape the guard returns; the real SDK honoring the deny is a manual
smoke (R10.6).
"""

from agent.loop.gate import GatePolicy, gate_decision, make_pretooluse_guard


def test_client_viewer_tools_are_always_allowed():
    """Viewer tools (pan/zoom/highlight) are cheap, side-effect-free, and unauthenticated —
    they never need approval, even under the default (locked-down) policy."""
    decision, _ = gate_decision("mcp__pathagent__pan_zoom_to_region", GatePolicy())
    assert decision == "allow"


def test_server_tools_are_denied_without_approval():
    """The costly server data tools are gated by default: the human must opt in per turn."""
    decision, reason = gate_decision("mcp__pathagent__run_segmentation", GatePolicy())
    assert decision == "deny"
    assert "approval" in reason.lower()  # the reason tells the model/UI why


def test_server_tools_pass_once_approved():
    decision, _ = gate_decision(
        "mcp__pathagent__run_segmentation", GatePolicy(approve_server=True)
    )
    assert decision == "allow"


def test_off_catalog_tools_are_denied_even_when_approved():
    """A tool outside our two-class catalog (a built-in the model might reach for) is denied
    regardless of approval — defense in depth behind allowed_tools."""
    decision, reason = gate_decision("Bash", GatePolicy(approve_server=True))
    assert decision == "deny"
    assert "Bash" in reason


async def test_guard_returns_the_sdk_pretooluse_output_shape():
    """The guard adapts the pure decision into the SDK's PreToolUse hook output dict."""
    guard = make_pretooluse_guard(GatePolicy())
    out = await guard(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "mcp__pathagent__run_segmentation",
            "tool_input": {},
            "tool_use_id": "tu_1",
        },
        "tu_1",
        {"signal": None},
    )
    hso = out["hookSpecificOutput"]
    assert hso["hookEventName"] == "PreToolUse"
    assert hso["permissionDecision"] == "deny"
    assert hso["permissionDecisionReason"]


async def test_guard_allows_a_client_tool_without_a_reason():
    guard = make_pretooluse_guard(GatePolicy())
    out = await guard(
        {"tool_name": "mcp__pathagent__pan_zoom_to_region"}, None, {"signal": None}
    )
    hso = out["hookSpecificOutput"]
    assert hso["permissionDecision"] == "allow"
    assert "permissionDecisionReason" not in hso  # nothing to explain on an allow
