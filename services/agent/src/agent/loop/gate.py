"""PreToolUse guard for the SDK loop — a defense-in-depth catalog check.

``allowed_tools`` already confines the model to our two-class catalog; this hook is
belt-and-suspenders behind it, denying anything off-catalog (a built-in the model might reach
for) regardless. There is **no approval gate**: the user's ask is the consent, so both client
viewer tools and server data tools run when the model calls them. (The old per-turn
``approve_server`` policy — which forced a full turn re-run to "approve" — was removed.)
"""

from typing import Any

from .tools import get_tool

# The SDK collects hook returns as plain dicts; alias the one we build for readability.
HookOutput = dict[str, Any]


def _bare_name(name: str) -> str:
    """In-process MCP tools reach the hook as ``mcp__<server>__<tool>``; strip that prefix so
    the registry lookup matches the bare tool name."""
    return name.split("__", 2)[-1] if name.startswith("mcp__") else name


def gate_decision(tool_name: str) -> tuple[str, str]:
    """Decide one PreToolUse call as ``(permissionDecision, reason)``.

    Any tool in our catalog — client or server — is allowed; anything off-catalog is denied.
    """
    if get_tool(_bare_name(tool_name)) is None:
        return "deny", f"{tool_name} is not one of the copilot's tools."
    return "allow", ""


def make_pretooluse_guard():
    """Build a PreToolUse ``HookCallback`` that denies off-catalog tools. The SDK hands the hook
    a dict carrying ``tool_name``; it returns the decision in the SDK's PreToolUse output shape."""

    async def guard(input_data: dict, tool_use_id: str | None, context: Any) -> HookOutput:
        decision, reason = gate_decision(input_data.get("tool_name", ""))
        specific: HookOutput = {"hookEventName": "PreToolUse", "permissionDecision": decision}
        if reason:
            specific["permissionDecisionReason"] = reason
        return {"hookSpecificOutput": specific}

    return guard
