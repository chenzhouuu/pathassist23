"""SdkAgentLoop — the real autonomous loop on the Claude Agent SDK (PathAgent v2, R10).

Drives `claude_agent_sdk.query` and **translates its message stream into our typed event
family** (D5), so the frontend and persistence contracts are unchanged from the stub loop.
The SDK's `query` is dependency-injected, so the translation is unit-tested against a
scripted message stream without the `claude` CLI, the network, or a key (real Claude is a
manual smoke). Two-class dispatch, real `ClaudeAgentOptions`, and the Pre/PostToolUse
hooks land in the following R10 sub-steps behind this same seam.
"""

import uuid
from asyncio import Event
from collections.abc import AsyncIterator
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    HookMatcher,
    ResultMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    query,
)

from .base import AgentLoop
from .events import (
    AgentEvent,
    ReasoningDelta,
    RunFinished,
    RunStarted,
    TextDelta,
    ToolCallResult,
    ToolCallStart,
)
from .gate import make_pretooluse_guard
from .sdk_tools import TOOL_SERVER, build_tool_server, parse_tool_result, sdk_tool_names
from .tools import ToolContext, get_tool

# The copilot persona. It never invents numbers — every quantitative claim comes from a
# tool result (D6) — and it is confined to the two-class tools (allowed_tools below).
_SYSTEM = (
    "You are PathAssist Copilot, a research assistant embedded in a whole-slide pathology "
    "viewer. Act on the slide only through your tools: viewer tools (pan/zoom/highlight) to "
    "direct attention, and data tools — segmentation and counting to measure, region "
    "description to read morphology. "
    "Treat the tools as your own instruments, not as sources to quote: absorb what they return "
    "and answer in a single voice, as the pathologist who examined the slide. Your tool calls "
    "and their results are already shown to the user in a separate trace, so do not narrate "
    "them — don't name the tool you used or attribute a finding to it, just state what you "
    "found. "
    "Every quantitative claim MUST come from a tool result — never invent a count or a "
    "density. You may report class breakdowns and fractions of tool-reported counts (e.g. "
    "'~16% of the cells here are Inflammatory'), but do not rename a class fraction into a "
    "clinical score — a PanNuke Inflammatory fraction is not a TILs score. "
    "A region description reads morphology from one region at one magnification; weigh it "
    "against your other evidence rather than treating it as a slide-level conclusion, and "
    "prefer a low-magnification overview before drilling to a higher magnification — a few "
    "well-chosen describe_region reads beat many. "
    "All coordinates are image / level-0 pixels; when a request needs a region and none is "
    "given, use the current viewport or the whole slide as appropriate."
)

# Safety bound on the in-turn loop (Risk #3: context growth / runaway).
_MAX_TURNS = 16

# The CLI's built-in `ToolSearch` meta-tool switches the model into deferred-tool mode: our
# in-process MCP tools land in a "search first" pool, so the model burns turns calling
# ToolSearch to discover them (which the PreToolUse gate then denies as off-catalog) before
# calling the real tool. Disallowing ToolSearch removes deferral — the model calls our tools
# directly, first try. (Verified against real Claude: the tool_use sequence collapses to one.)
_DISALLOWED_TOOLS = ["ToolSearch"]


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _num(v: Any) -> str:
    """Render whole floats without a trailing .0 (viewport pixel coords are integral)."""
    return str(int(v)) if float(v).is_integer() else str(v)


_ROLE_LABEL = {"user": "User", "assistant": "Assistant"}


def _render_transcript(history: list[dict]) -> str:
    """Replay the conversation as a labelled transcript. The route builds ``history`` to
    already include the current turn (with any ROI folded into its content), so this is the
    turn's full context — the loop opens a fresh SDK ``query`` each turn and holds no
    server-side session, so memory must be replayed here."""
    return "\n\n".join(
        f"{_ROLE_LABEL.get(t.get('role'), 'User')}: {t.get('content', '')}" for t in history
    )


def _context_preamble(scope: dict, viewer: dict | None) -> str:
    """A compact grounding note prepended to the turn: where the viewer is currently looking,
    so a deictic ask ('what's here') resolves to a concrete region (D8). The ROI, when set,
    already rides the transcript (folded into the user message upstream), so it is not
    repeated here."""
    if not viewer:
        return ""
    return (
        "[Viewer context] The viewer is currently showing image region "
        f"x={_num(viewer['x'])}, y={_num(viewer['y'])}, "
        f"width={_num(viewer['width'])}, height={_num(viewer['height'])} (level-0 pixels)."
    )


def _compose_prompt(text: str, history: list[dict], scope: dict, viewer: dict | None) -> str:
    """Assemble the model input for one turn: the viewport grounding note, then the replayed
    transcript (falling back to the bare current text when there is no history)."""
    transcript = _render_transcript(history) if history else text
    preamble = _context_preamble(scope, viewer)
    return f"{preamble}\n\n{transcript}" if preamble else transcript


def _tool_key(name: str) -> str:
    """The bare tool name. In-process MCP tools reach the model as ``mcp__<server>__<tool>``;
    strip that prefix so the emitted event name and the two-class registry lookup match the
    stub loop's contract (the frontend dispatches on the bare name)."""
    if name.startswith("mcp__"):
        return name.split("__", 2)[-1]
    return name


class SdkAgentLoop(AgentLoop):
    """Runs one turn through the Claude Agent SDK, emitting our typed events."""

    def __init__(self, *, api_key: str, model: str, query=query) -> None:
        self._api_key = api_key
        self._model = model
        self._query = query

    def _build_options(
        self,
        scope: dict,
        viewer: dict | None,
        ctx: ToolContext | None,
    ) -> ClaudeAgentOptions:
        """Assemble the SDK run config: isolated settings, the model pinned, the toolset locked
        to our two-class in-process MCP catalog (no built-ins), and a PreToolUse hook that only
        denies anything off-catalog. No approval gate — the user's ask is the consent, so client
        and server tools both run."""
        guard = make_pretooluse_guard()
        return ClaudeAgentOptions(
            model=self._model,
            system_prompt=_SYSTEM,
            mcp_servers={TOOL_SERVER: build_tool_server(ctx, scope)},
            allowed_tools=sdk_tool_names(),
            disallowed_tools=_DISALLOWED_TOOLS,
            permission_mode="bypassPermissions",
            setting_sources=[],
            max_turns=_MAX_TURNS,
            # The gateway process holds only AGENT_ANTHROPIC_API_KEY; hand the spawned
            # `claude` subprocess the bare ANTHROPIC_API_KEY it needs to authenticate.
            env={"ANTHROPIC_API_KEY": self._api_key} if self._api_key else {},
            # bypassPermissions auto-approves before can_use_tool; the PreToolUse hook still
            # runs, and we use it only to deny anything off our catalog (belt-and-suspenders
            # behind allowed_tools). Catalog tools — client and server — all run.
            hooks={"PreToolUse": [HookMatcher(hooks=[guard])]},
        )

    async def run(
        self,
        *,
        text: str,
        history: list[dict],
        scope: dict,
        viewer: dict | None = None,
        ctx: ToolContext | None = None,
        abort: Event | None = None,
    ) -> AsyncIterator[AgentEvent]:
        run_id = _new_id()
        yield RunStarted(run_id=run_id)

        options = self._build_options(scope, viewer, ctx)
        prompt = _compose_prompt(text, history, scope, viewer)
        final = ""
        async for message in self._query(prompt=prompt, options=options):
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, ThinkingBlock):
                        yield ReasoningDelta(run_id=run_id, text=block.thinking)
                    elif isinstance(block, TextBlock):
                        final += block.text
                        yield TextDelta(run_id=run_id, text=block.text)
                    elif isinstance(block, ToolUseBlock):
                        # Two-class dispatch (D3): look the tool up in our registry to tag
                        # its class. A client tool_call_start doubles as the viewer command
                        # (its args carry the model-chosen bbox); an unknown tool (a built-in)
                        # defaults to server so it is never executed against the viewer.
                        key = _tool_key(block.name)
                        known = get_tool(key)
                        yield ToolCallStart(
                            run_id=run_id, tool_call_id=block.id, name=key,
                            args=block.input or {},
                            tool_class=known.tool_class if known else "server",
                        )
            elif isinstance(message, UserMessage):
                for block in _blocks(message.content):
                    if isinstance(block, ToolResultBlock):
                        # Lift the artifact handle out of the tool result; the model/UI sees
                        # only the clean summary, the geometry stays out of band (D4).
                        summary, artifact = parse_tool_result(block.content)
                        yield ToolCallResult(
                            run_id=run_id, tool_call_id=block.tool_use_id,
                            ok=not bool(block.is_error), summary=summary, artifact=artifact,
                        )
            elif isinstance(message, ResultMessage):
                yield RunFinished(run_id=run_id, text=final or (message.result or ""))


def _blocks(content: Any) -> list:
    """A UserMessage's content is a list of blocks (or a bare string for plain text)."""
    return content if isinstance(content, list) else []
