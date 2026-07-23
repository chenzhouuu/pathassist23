"""PreToolUse guard: a defense-in-depth catalog check (no approval gate).

The approval gate was removed — the user's ask is the consent, so both client viewer tools and
server data tools run. The hook's only job now is to deny anything off our two-class catalog
(belt-and-suspenders behind allowed_tools). These pin the pure decision and the exact SDK
output shape the guard returns.
"""

from agent.loop.gate import gate_decision, make_pretooluse_guard


def test_client_viewer_tools_are_allowed():
    decision, _ = gate_decision("mcp__pathagent__pan_zoom_to_region")
    assert decision == "allow"


def test_server_data_tools_are_allowed_without_approval():
    """Server tools run when the model calls them — the user's ask is the consent."""
    decision, reason = gate_decision("mcp__pathagent__run_segmentation")
    assert decision == "allow"
    assert reason == ""


def test_off_catalog_tools_are_denied():
    """A tool outside our two-class catalog (a built-in the model might reach for) is denied —
    defense in depth behind allowed_tools."""
    decision, reason = gate_decision("Bash")
    assert decision == "deny"
    assert "Bash" in reason


async def test_guard_denies_an_off_catalog_tool_in_the_sdk_output_shape():
    """The guard adapts the pure decision into the SDK's PreToolUse hook output dict."""
    guard = make_pretooluse_guard()
    out = await guard({"tool_name": "Bash"}, "tu_1", {"signal": None})
    hso = out["hookSpecificOutput"]
    assert hso["hookEventName"] == "PreToolUse"
    assert hso["permissionDecision"] == "deny"
    assert hso["permissionDecisionReason"]


async def test_guard_allows_a_catalog_tool_without_a_reason():
    guard = make_pretooluse_guard()
    out = await guard(
        {"tool_name": "mcp__pathagent__run_segmentation"}, None, {"signal": None}
    )
    hso = out["hookSpecificOutput"]
    assert hso["permissionDecision"] == "allow"
    assert "permissionDecisionReason" not in hso  # nothing to explain on an allow
