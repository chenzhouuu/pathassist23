"""PreToolUse gating for the SDK loop (R10.4b) — the *controllable* half of the autonomous
loop.

A single-turn ``query`` runs the whole agentic loop with no pause point, so approval is a
**policy the human sets**, enforced deterministically by a PreToolUse hook — the SDK's
documented way to gate every tool call regardless of ``permission_mode`` (``bypassPermissions``
auto-approves before ``can_use_tool`` is consulted, but a PreToolUse ``deny`` still blocks).
Client viewer tools (cheap, side-effect-free, unauthenticated) always pass; costly server data
tools pass only when the turn was launched with approval; anything off-catalog is denied as
defense in depth behind ``allowed_tools``. A denied call comes back to the model as an error
tool result, which the loop already surfaces as ``ToolCallResult(ok=False)`` — no loop change.
"""

from dataclasses import dataclass
from typing import Any

from .tools import CLIENT, get_tool

# The SDK collects hook returns as plain dicts; alias the two we build for readability.
HookOutput = dict[str, Any]


@dataclass(frozen=True)
class GatePolicy:
    """Per-turn tool policy. ``approve_server`` opens the costly server (data) tools for this
    turn — the human's consent — while client viewer tools are always allowed. The default is
    locked down: server tools need explicit approval."""

    approve_server: bool = False


DEFAULT_GATE = GatePolicy()


def _bare_name(name: str) -> str:
    """In-process MCP tools reach the hook as ``mcp__<server>__<tool>``; strip that prefix so
    the two-class registry lookup matches the bare tool name."""
    return name.split("__", 2)[-1] if name.startswith("mcp__") else name


def gate_decision(tool_name: str, policy: GatePolicy) -> tuple[str, str]:
    """Decide one PreToolUse call as ``(permissionDecision, reason)``.

    Client tools allow (no reason needed); server tools allow only with approval, else deny
    with a human-readable reason; an off-catalog tool is denied whatever the policy.
    """
    tool = get_tool(_bare_name(tool_name))
    if tool is None:
        return "deny", f"{tool_name} is not one of the copilot's tools."
    if tool.tool_class == CLIENT:
        return "allow", ""
    if policy.approve_server:
        return "allow", ""
    return (
        "deny",
        f"Running {tool.name} needs your approval — it is a server-side analysis tool. "
        "Approve the analysis, then ask again.",
    )


def make_pretooluse_guard(policy: GatePolicy):
    """Build a PreToolUse ``HookCallback`` enforcing ``policy``. The SDK hands the hook a dict
    carrying ``tool_name``; it returns the decision in the SDK's PreToolUse output shape."""

    async def guard(input_data: dict, tool_use_id: str | None, context: Any) -> HookOutput:
        decision, reason = gate_decision(input_data.get("tool_name", ""), policy)
        specific: HookOutput = {"hookEventName": "PreToolUse", "permissionDecision": decision}
        if reason:
            specific["permissionDecisionReason"] = reason
        return {"hookSpecificOutput": specific}

    return guard
