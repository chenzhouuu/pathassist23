"""In-process (SDK) two-class tools + the tool-result handle contract (PathAgent v2, R10.3).

The agent loop registers our two-class tools (D3) as an in-process MCP server so the SDK
model calls them by name (`mcp__pathagent__<tool>`). Two classes, two behaviours:

- **client** (viewer) tools are thin acks — the real OpenSeadragon effect is emitted by the
  loop from the observed `tool_use` (R10.2), so the in-process side only confirms dispatch.
- **server** (data) tools execute with the per-turn `ToolContext` and return the model-facing
  text summary plus, as a marker-tagged content line, the artifact **handle** (D4). The loop
  lifts the handle onto `ToolCallResult.artifact`; the dense geometry never enters the
  model's context (it is written out-of-band to the artifact store).

The `input_schema`s live here (the SDK path is the only consumer); R11 repoints the server
executors at real CellViT/Girder without changing this contract.
"""

import json
from typing import Any

from claude_agent_sdk import SdkMcpTool, create_sdk_mcp_server, tool

from .tools import CLIENT, ToolContext, catalog, get_tool, run_server_tool

TOOL_SERVER = "pathagent"

# A tool-result content line that begins with this marker carries the artifact handle as
# JSON; the loop strips it from the summary and lifts it onto the event (D4).
ARTIFACT_MARKER = "artifact::"

_BBOX_SCHEMA = {
    "type": ["object", "null"],
    "properties": {
        "x": {"type": "number"}, "y": {"type": "number"},
        "width": {"type": "number"}, "height": {"type": "number"},
    },
    "description": "A bounding box in level-0 pixels, or null for the whole slide.",
}

_SCHEMAS: dict[str, dict] = {
    "pan_zoom_to_region": {
        "type": "object", "properties": {"bbox": _BBOX_SCHEMA}, "required": ["bbox"],
    },
    "highlight_roi": {
        "type": "object", "properties": {"bbox": _BBOX_SCHEMA}, "required": ["bbox"],
    },
    "run_segmentation": {
        "type": "object",
        "properties": {
            "bbox": {
                **_BBOX_SCHEMA,
                "description": "Optional region to segment, in level-0 pixels. Omit to use "
                               "the region already drawn on the slide.",
            },
        },
        "additionalProperties": False,
    },
    "describe_region": {
        "type": "object",
        "properties": {
            "bbox": {
                **_BBOX_SCHEMA,
                "description": "Region to describe, in level-0 pixels — pass the coordinates of "
                               "the box you want read (e.g. a candidate box returned by "
                               "find_regions). It reads exactly this box, not wherever the viewer "
                               "was last panned. Omit it only when the user has drawn a region on "
                               "the slide.",
            },
            "magnification": {
                "type": ["integer", "null"],
                "description": "Objective power to view the region at (e.g. 5, 10, 20, 40). "
                               "Higher = more detail, smaller field of view; clamped to the "
                               "slide's native magnification. Omit for the default.",
            },
            "focus": {
                "type": ["string", "null"],
                "description": "The specific morphological question to answer, derived from the "
                               "user's request (e.g. 'degree of nuclear atypia', 'mitotic "
                               "figures per HPF', 'gland formation'). Steers what the read "
                               "addresses; omit for a general description.",
            },
        },
        "additionalProperties": False,
    },
    "find_regions": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "A short free-text description of the tissue to find (e.g. "
                               "'invasive tumor', 'lymphocyte-rich stroma', 'necrosis').",
            },
            "k": {
                "type": ["integer", "null"],
                "description": "How many candidate regions to return (default 8).",
            },
        },
        "required": ["query"],
        "additionalProperties": False,
    },
    "phenotype_cells": {
        "type": "object",
        "properties": {
            "bbox": {
                **_BBOX_SCHEMA,
                "description": "Region to phenotype, in level-0 pixels — pass the coordinates of "
                               "the box you want (e.g. a candidate box from find_regions). It "
                               "reads exactly this box. Omit it only when the user has drawn a "
                               "region on the slide; a whole-slide (null) request isn't ready yet.",
            },
            "focus": {
                "type": ["string", "null"],
                "description": "What the user cares about, to steer the summary (e.g. 'immune "
                               "infiltrate', 'proliferation', 'PD-L1'); omit for a general read.",
            },
        },
        "additionalProperties": False,
    },
}


def _text(s: str) -> dict:
    return {"type": "text", "text": s}


async def run_client_tool(name: str, args: dict) -> dict:
    """A viewer command's in-process side is a no-op ack — the browser executes the real
    effect from the loop's client `tool_call_start` (R10.2)."""
    return {"content": [_text(f"{name} dispatched to the viewer")]}


async def run_data_tool(name: str, args: dict, scope: dict, ctx: ToolContext | None) -> dict:
    """Execute a server-side data tool; return the model-facing summary plus a marker-tagged
    handle line the loop lifts onto ToolCallResult.artifact (bulk geometry stays out of band)."""
    outcome = await run_server_tool(get_tool(name), args, scope, ctx)
    content = [_text(outcome.summary)]
    if outcome.artifact is not None:
        content.append(_text(ARTIFACT_MARKER + json.dumps(outcome.artifact.to_dict())))
    return {"content": content, "is_error": not outcome.ok}


def sdk_tool_names() -> list[str]:
    """The fully-qualified in-process MCP tool names — the loop's `allowed_tools`, so the
    model is confined to our two-class catalog (no built-in Bash/Read/Write)."""
    return [f"mcp__{TOOL_SERVER}__{spec.name}" for spec in catalog()]


def make_sdk_tools(ctx: ToolContext | None, scope: dict) -> list[SdkMcpTool]:
    """Wrap the two-class catalog as in-process SDK tools, closing over the per-turn context
    (which never enters the model — it holds the owner, artifact store, and later the token)."""
    tools: list[SdkMcpTool] = []
    for spec in catalog():
        schema = _SCHEMAS.get(spec.name, {"type": "object"})
        handler = (
            _client_handler(spec.name) if spec.tool_class == CLIENT
            else _data_handler(spec.name, scope, ctx)
        )
        tools.append(tool(spec.name, spec.description, schema)(handler))
    return tools


def build_tool_server(ctx: ToolContext | None, scope: dict) -> dict:
    """The in-process MCP server config for this turn's two-class tools."""
    return create_sdk_mcp_server(TOOL_SERVER, "1.0.0", make_sdk_tools(ctx, scope))


def parse_tool_result(content: Any) -> tuple[str, dict | None]:
    """Split an SDK tool result into ``(summary, artifact_handle)``: plain text blocks form
    the summary; a marker-tagged block yields the handle the loop lifts out (D4)."""
    if content is None:
        return "", None
    if isinstance(content, str):
        return content, None
    summary_parts: list[str] = []
    artifact: dict | None = None
    for text in _iter_texts(content):
        if text.startswith(ARTIFACT_MARKER):
            try:
                artifact = json.loads(text[len(ARTIFACT_MARKER):])
            except json.JSONDecodeError:
                pass
        elif text:
            summary_parts.append(text)
    return " ".join(summary_parts), artifact


def _iter_texts(content: Any):
    """Yield the text of each content block (dicts with a ``text`` key, bare strings, or
    objects with a ``.text`` attribute)."""
    for item in content if isinstance(content, list) else [content]:
        if isinstance(item, str):
            yield item
        elif isinstance(item, dict):
            yield item.get("text", "")
        else:
            yield getattr(item, "text", "")


def _client_handler(name: str):
    async def handler(args: dict) -> dict:
        return await run_client_tool(name, args)

    return handler


def _data_handler(name: str, scope: dict, ctx: ToolContext | None):
    async def handler(args: dict) -> dict:
        return await run_data_tool(name, args, scope, ctx)

    return handler
