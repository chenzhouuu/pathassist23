"""R10 — SdkAgentLoop: translating the Claude Agent SDK message stream into our typed
event family, at the unit level.

The SDK's `query` is dependency-injected, so the loop is tested against a *scripted* SDK
message stream — no `claude` CLI, no network, no API key. Real Claude is a separate
manual smoke (R10.6). This pins the translation contract: SDK message/block →
our RunStarted / ReasoningDelta / ToolCallStart / ToolCallResult / TextDelta / RunFinished,
correlated by run_id and tool_use id.
"""

import json

from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from agent.loop.events import (
    ReasoningDelta,
    RunFinished,
    RunStarted,
    TextDelta,
    ToolCallResult,
    ToolCallStart,
)
from agent.loop.sdk import SdkAgentLoop
from agent.loop.sdk_tools import ARTIFACT_MARKER


def _scripted_query(*, prompt, options=None, transport=None):
    """A fake `query` yielding one faithful assistant turn: think → call a tool → answer."""

    async def gen():
        yield SystemMessage(subtype="init", data={})
        yield AssistantMessage(
            content=[
                ThinkingBlock(thinking="I should segment the region.", signature=""),
                ToolUseBlock(id="tu_1", name="run_segmentation", input={}),
            ],
            model="claude-opus-4-8",
        )
        yield UserMessage(
            content=[ToolResultBlock(
                tool_use_id="tu_1", content="segmented 1,234 nuclei in the region", is_error=False
            )]
        )
        yield AssistantMessage(
            content=[TextBlock(text="Done — 1,234 nuclei in the region.")],
            model="claude-opus-4-8",
        )
        yield ResultMessage(
            subtype="success", duration_ms=1, duration_api_ms=1,
            is_error=False, num_turns=1, session_id="sess_1",
        )

    return gen()


async def _drain(loop, **kw) -> list:
    return [ev async for ev in loop.run(**kw)]


async def test_sdk_loop_translates_the_message_stream_to_typed_events():
    loop = SdkAgentLoop(api_key="sk-test", model="claude-opus-4-8", query=_scripted_query)
    events = await _drain(loop, text="count cells here", history=[], scope={"item_id": "s"})

    # Well-formed lifecycle.
    assert isinstance(events[0], RunStarted)
    assert isinstance(events[-1], RunFinished)

    # Thinking → reasoning strip.
    assert any(isinstance(e, ReasoningDelta) and "segment" in e.text for e in events)

    # The tool_use block and its result correlate by the SDK's tool id.
    start = next(e for e in events if isinstance(e, ToolCallStart))
    result = next(e for e in events if isinstance(e, ToolCallResult))
    assert start.tool_call_id == "tu_1" == result.tool_call_id
    assert start.name == "run_segmentation"
    assert result.ok is True and "segmented" in result.summary

    # The final answer is streamed and assembled.
    assert any(isinstance(e, TextDelta) for e in events)
    assert "Done" in events[-1].text

    # Single turn: one run_id throughout.
    run_id = events[0].run_id
    assert run_id and all(e.run_id == run_id for e in events)


async def test_sdk_loop_marks_a_tool_error_result_not_ok():
    def failing_query(*, prompt, options=None, transport=None):
        async def gen():
            yield AssistantMessage(
                content=[ToolUseBlock(id="tu_x", name="run_segmentation", input={})],
                model="claude-opus-4-8",
            )
            yield UserMessage(
                content=[ToolResultBlock(tool_use_id="tu_x", content="boom", is_error=True)]
            )
            yield ResultMessage(
                subtype="success", duration_ms=1, duration_api_ms=1,
                is_error=False, num_turns=1, session_id="s",
            )
        return gen()

    loop = SdkAgentLoop(api_key="sk-test", model="claude-opus-4-8", query=failing_query)
    events = await _drain(loop, text="go", history=[], scope={"item_id": "s"})
    result = next(e for e in events if isinstance(e, ToolCallResult))
    assert result.ok is False


async def test_sdk_loop_tags_two_tool_classes_and_normalizes_mcp_names():
    """The model calls in-process tools by their `mcp__server__tool` name; the loop
    normalizes to the bare name (matching the stub loop's contract) and tags the class from
    the two-class registry — so a client tool_call_start doubles as the viewer command."""

    def two_tools(*, prompt, options=None, transport=None):
        bbox = {"x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0}

        async def gen():
            yield AssistantMessage(
                content=[ToolUseBlock(
                    id="c1", name="mcp__pathagent__pan_zoom_to_region", input={"bbox": bbox})],
                model="m",
            )
            yield UserMessage(content=[ToolResultBlock(
                tool_use_id="c1", content="panned", is_error=False)])
            yield AssistantMessage(
                content=[ToolUseBlock(
                    id="s1", name="mcp__pathagent__run_segmentation", input={})],
                model="m",
            )
            yield UserMessage(content=[ToolResultBlock(
                tool_use_id="s1", content="segmented 1,234 nuclei", is_error=False)])
            yield ResultMessage(
                subtype="success", duration_ms=1, duration_api_ms=1,
                is_error=False, num_turns=1, session_id="s",
            )

        return gen()

    loop = SdkAgentLoop(api_key="sk-test", model="claude-opus-4-8", query=two_tools)
    events = await _drain(loop, text="count cells here", history=[], scope={"item_id": "s"})
    starts = {e.name: e for e in events if isinstance(e, ToolCallStart)}

    assert set(starts) == {"pan_zoom_to_region", "run_segmentation"}  # names normalized
    assert starts["pan_zoom_to_region"].tool_class == "client"
    assert starts["run_segmentation"].tool_class == "server"
    # the client tool's model-chosen bbox rides the args (the FE executes it against OSD)
    assert starts["pan_zoom_to_region"].args == {
        "bbox": {"x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0}
    }


async def test_sdk_loop_defaults_an_unknown_tool_to_server_class():
    """A tool not in our two-class registry (e.g. a built-in) is treated as server-side —
    never mistaken for a viewer command the browser would execute."""

    def unknown(*, prompt, options=None, transport=None):
        async def gen():
            yield AssistantMessage(
                content=[ToolUseBlock(id="u1", name="Bash", input={})], model="m")
            yield UserMessage(content=[ToolResultBlock(
                tool_use_id="u1", content="ok", is_error=False)])
            yield ResultMessage(
                subtype="success", duration_ms=1, duration_api_ms=1,
                is_error=False, num_turns=1, session_id="s",
            )

        return gen()

    loop = SdkAgentLoop(api_key="sk-test", model="claude-opus-4-8", query=unknown)
    events = await _drain(loop, text="go", history=[], scope={})
    start = next(e for e in events if isinstance(e, ToolCallStart))
    assert start.name == "Bash" and start.tool_class == "server"


def test_build_options_configures_the_sdk_run():
    """Real ClaudeAgentOptions: no gate, isolated settings, model pinned, and the toolset
    locked to our two-class in-process MCP catalog (no built-in Bash/Read/Write)."""
    loop = SdkAgentLoop(api_key="sk-test", model="claude-opus-4-8")
    opts = loop._build_options(scope={"item_id": "s", "roi": None}, viewer=None, ctx=None)

    assert opts.permission_mode == "bypassPermissions"
    assert opts.model == "claude-opus-4-8"
    assert opts.setting_sources == []
    assert "pathagent" in opts.mcp_servers
    assert set(opts.allowed_tools) == {
        "mcp__pathagent__pan_zoom_to_region",
        "mcp__pathagent__highlight_roi",
        "mcp__pathagent__run_segmentation",
        "mcp__pathagent__describe_region",
    }
    assert opts.system_prompt  # a persona is set


class _CapturingQuery:
    """A fake `query` that records the composed prompt and the run options, then yields a
    minimal valid turn. Lets a test assert on *what context and config the loop actually sent
    the model* (R10.4) — including the per-turn permission gate (R10.7)."""

    def __init__(self) -> None:
        self.prompt: str | None = None
        self.options = None

    def __call__(self, *, prompt, options=None, transport=None):
        self.prompt = prompt
        self.options = options

        async def gen():
            yield AssistantMessage(content=[TextBlock(text="ok")], model="m")
            yield ResultMessage(
                subtype="success", duration_ms=1, duration_api_ms=1,
                is_error=False, num_turns=1, session_id="s",
            )

        return gen()


async def test_sdk_loop_threads_the_conversation_history_into_the_prompt():
    """R10.4: prior turns reach the model so it has memory across the thread — the loop
    replays the transcript (which the route builds to include the current turn), not just
    the bare current text."""
    cap = _CapturingQuery()
    loop = SdkAgentLoop(api_key="sk-test", model="m", query=cap)
    history = [
        {"role": "user", "content": "how many mitoses did you find?"},
        {"role": "assistant", "content": "I counted 42 mitoses in that region."},
        {"role": "user", "content": "and in this new region?"},
    ]
    await _drain(
        loop, text="and in this new region?", history=history,
        scope={"item_id": "s", "roi": None},
    )
    assert "42 mitoses" in cap.prompt  # the prior assistant turn is in context
    assert "and in this new region?" in cap.prompt  # the current ask too


async def test_sdk_loop_grounds_the_prompt_in_the_current_viewport():
    """R10.4: with no ROI, the current viewport frames a deictic ask ('what's here') so the
    model can act on a concrete region (D8) instead of guessing coordinates."""
    cap = _CapturingQuery()
    loop = SdkAgentLoop(api_key="sk-test", model="m", query=cap)
    await _drain(
        loop, text="what's here", history=[{"role": "user", "content": "what's here"}],
        scope={"item_id": "s", "roi": None},
        viewer={"x": 10, "y": 20, "width": 4096, "height": 4096, "unit": "px"},
    )
    assert "4096" in cap.prompt  # the viewport rectangle grounds "here"


async def test_run_opens_the_gate_when_the_turn_is_approved():
    """R10.7: the per-turn approval flows into the PreToolUse policy — an approved turn lets
    the costly server tools run (the human's consent lifts the default lock)."""
    cap = _CapturingQuery()
    loop = SdkAgentLoop(api_key="sk-test", model="m", query=cap)
    await _drain(
        loop, text="count cells here",
        history=[{"role": "user", "content": "count cells here"}],
        scope={"item_id": "s", "roi": None}, approved=True,
    )
    guard = cap.options.hooks["PreToolUse"][0].hooks[0]
    out = await guard({"tool_name": "mcp__pathagent__run_segmentation"}, None, {"signal": None})
    assert out["hookSpecificOutput"]["permissionDecision"] == "allow"


async def test_run_keeps_server_tools_gated_when_the_turn_is_not_approved():
    cap = _CapturingQuery()
    loop = SdkAgentLoop(api_key="sk-test", model="m", query=cap)
    await _drain(
        loop, text="count", history=[{"role": "user", "content": "count"}],
        scope={"item_id": "s", "roi": None},  # approved defaults to False
    )
    guard = cap.options.hooks["PreToolUse"][0].hooks[0]
    out = await guard({"tool_name": "mcp__pathagent__run_segmentation"}, None, {"signal": None})
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_build_options_disallows_the_tool_search_meta_tool():
    """R10.8: the CLI's built-in `ToolSearch` meta-tool puts the model into deferred-tool mode,
    so it 'searches' for our MCP tools (which the gate then denies) before calling them —
    wasted turns + noisy cards. Disallowing ToolSearch removes deferral; the model calls our
    tools directly. Verified against real Claude (the tool_use sequence collapses to one call)."""
    loop = SdkAgentLoop(api_key="sk-test", model="m")
    opts = loop._build_options(scope={"item_id": "s", "roi": None}, viewer=None, ctx=None)
    assert "ToolSearch" in (opts.disallowed_tools or [])


def test_build_options_injects_the_api_key_into_the_subprocess_env():
    """R10.7: the spawned `claude` subprocess authenticates headlessly from the key the loop
    was built with (the gateway process holds only AGENT_ANTHROPIC_API_KEY, so the bare
    ANTHROPIC_API_KEY must be handed to the subprocess explicitly)."""
    loop = SdkAgentLoop(api_key="sk-xyz", model="m")
    opts = loop._build_options(scope={"item_id": "s", "roi": None}, viewer=None, ctx=None)
    assert opts.env.get("ANTHROPIC_API_KEY") == "sk-xyz"


async def test_build_options_wires_a_pretooluse_gate_that_denies_unapproved_server_tools():
    """R10.4b: the run config carries a PreToolUse hook (the SDK's way to gate every call
    under bypassPermissions). Under the default policy a server tool is denied until the
    human approves; a client viewer tool always passes."""
    loop = SdkAgentLoop(api_key="sk-test", model="m")  # default gate: server needs approval
    opts = loop._build_options(scope={"item_id": "s", "roi": None}, viewer=None, ctx=None)

    guard = opts.hooks["PreToolUse"][0].hooks[0]
    ctx = {"signal": None}
    denied = await guard({"tool_name": "mcp__pathagent__run_segmentation"}, None, ctx)
    allowed = await guard({"tool_name": "mcp__pathagent__pan_zoom_to_region"}, None, ctx)
    assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert allowed["hookSpecificOutput"]["permissionDecision"] == "allow"


async def test_sdk_loop_lifts_the_artifact_handle_onto_the_result():
    """D4: the server tool's tagged handle is lifted onto ToolCallResult.artifact, and the
    summary the model/UI sees is clean (marker stripped); geometry never rides the event."""
    handle = {"kind": "nuclei", "ref": "abc123", "count": 1234,
              "summary": "1,234 nuclei", "bbox": {"x": 0, "y": 0, "width": 8, "height": 8},
              "size": 100}

    def with_handle(*, prompt, options=None, transport=None):
        async def gen():
            yield AssistantMessage(
                content=[ToolUseBlock(
                    id="s1", name="mcp__pathagent__run_segmentation", input={})],
                model="m",
            )
            yield UserMessage(content=[ToolResultBlock(
                tool_use_id="s1",
                content=[
                    {"type": "text", "text": "segmented 1,234 nuclei in the region"},
                    {"type": "text", "text": ARTIFACT_MARKER + json.dumps(handle)},
                ],
                is_error=False,
            )])
            yield ResultMessage(
                subtype="success", duration_ms=1, duration_api_ms=1,
                is_error=False, num_turns=1, session_id="s",
            )

        return gen()

    loop = SdkAgentLoop(api_key="sk-test", model="claude-opus-4-8", query=with_handle)
    events = await _drain(
        loop, text="count", history=[],
        scope={"item_id": "s", "roi": {"x": 0, "y": 0, "width": 8, "height": 8}},
    )
    result = next(e for e in events if isinstance(e, ToolCallResult))

    assert result.artifact == handle
    assert result.summary == "segmented 1,234 nuclei in the region"
    assert ARTIFACT_MARKER not in result.summary


def test_system_prompt_bounds_typed_class_claims():
    from agent.loop.sdk import _SYSTEM

    assert "never invent a count" in _SYSTEM
    assert "TILs" in _SYSTEM   # must not label a PanNuke Inflammatory fraction a TILs score


def test_system_prompt_grounds_perceptor_descriptions():
    from agent.loop.sdk import _SYSTEM

    # F3: a Patho-R1 description is a hedged observation, attributed and never a verdict.
    assert "hedged observation" in _SYSTEM
    assert "describe_region" in _SYSTEM
    # F5: look before you drill.
    assert "before drilling" in _SYSTEM
