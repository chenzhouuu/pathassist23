"""Two-class loop tool registry (PathAgent v2, R8 — D3).

Every tool the agent loop can call is one of two kinds:

- **client** — the effect is an OpenSeadragon command executed *in the browser*; no auth.
  The loop emits a typed `tool_call_start` (``tool_class="client"``) carrying a
  level-0-pixel bbox; the viewer executes it. Pure effects (pan/highlight) are
  fire-and-forget — they resolve as soon as the command is emitted.
- **server** — a data tool that runs in the gateway with the user's Girder token (which
  the model never sees). Stubbed here until CellViT lands at R10 and Girder reads at R11.

This is the catalog of record for the loop; R10/R11 repoint the server executors at real
models without touching the loop or the event contract.
"""

from dataclasses import dataclass

from .artifacts import ArtifactHandle, ArtifactStore

CLIENT = "client"
SERVER = "server"


@dataclass(frozen=True)
class LoopTool:
    """A tool the agent loop can call, tagged with the class that decides how it runs."""

    name: str
    tool_class: str
    title: str
    description: str


@dataclass(frozen=True)
class ToolContext:
    """Per-turn execution context for server-side data tools: who owns the turn, which
    conversation it belongs to, where bulk output is written (D4), and the server-side
    Girder token + CellViT service URL for real segmentation (R11). The token never enters
    the model (D3)."""

    owner: str
    conversation_id: int
    artifacts: ArtifactStore | None = None
    girder_token: str | None = None
    cellvit_url: str | None = None


@dataclass(frozen=True)
class ToolOutcome:
    """A server tool's grounded result — a text `summary` (all the model sees) plus an
    optional artifact **handle** for bulk output. The geometry itself is never here (D4)."""

    ok: bool
    summary: str
    artifact: ArtifactHandle | None = None


_TOOLS: dict[str, LoopTool] = {
    "pan_zoom_to_region": LoopTool(
        "pan_zoom_to_region", CLIENT, "Pan/zoom to region",
        "Move the viewer to frame a bounding box in level-0 pixels "
        "(null bbox ⇒ fit the whole slide).",
    ),
    "highlight_roi": LoopTool(
        "highlight_roi", CLIENT, "Highlight region",
        "Outline a bounding box on the slide, in level-0 pixels.",
    ),
    "run_segmentation": LoopTool(
        "run_segmentation", SERVER, "Segment nuclei (stub)",
        "Segment nuclei within the scope. Canned stub until CellViT++ lands at R10.",
    ),
}

# Canned nuclei count for the R8 stub; R10 replaces the executor with real CellViT output.
_STUB_NUCLEI = 1234


def get_tool(name: str) -> LoopTool | None:
    return _TOOLS.get(name)


def catalog() -> list[LoopTool]:
    """The full two-class catalog, in registration order."""
    return list(_TOOLS.values())


def _stub_nuclei_geometry(bbox: dict | None) -> dict:
    """A deterministic canned point set — the R10 CellViT executor returns real centroids.
    Placed inside the bbox when one is given so the geometry is spatially plausible."""
    ox = float(bbox["x"]) if bbox else 0.0
    oy = float(bbox["y"]) if bbox else 0.0
    points = [[ox + (i % 64), oy + (i // 64)] for i in range(_STUB_NUCLEI)]
    return {"kind": "nuclei", "count": len(points), "points": points}


async def run_server_tool(
    tool: LoopTool, args: dict, scope: dict, ctx: ToolContext | None = None
) -> ToolOutcome:
    """Execute a server-side data tool.

    Stubbed at R8/R9 — no Girder call and no user token yet (that seam lands at R11). The
    scope decides region-vs-whole-slide so the grounded summary matches what was analyzed.
    When an ArtifactStore is in context, bulk output is written and only a **handle** is
    returned (D4); without one (unit context) the tool degrades to a summary-only result.
    """
    if tool.name == "run_segmentation":
        roi = (scope or {}).get("roi")
        where = "in the region" if roi else "across the slide"
        if ctx is None or ctx.artifacts is None:
            return ToolOutcome(ok=True, summary=f"segmented {_STUB_NUCLEI:,} nuclei {where}")
        geometry = _stub_nuclei_geometry(roi)
        handle = await ctx.artifacts.put(
            owner=ctx.owner, conversation_id=ctx.conversation_id, kind="nuclei",
            bbox=roi, geometry=geometry, summary=f"{geometry['count']:,} nuclei",
        )
        return ToolOutcome(
            ok=True, summary=f"segmented {handle.count:,} nuclei {where}", artifact=handle
        )
    return ToolOutcome(ok=False, summary=f"no server executor for {tool.name}")


__all__ = [
    "CLIENT", "SERVER", "LoopTool", "ToolContext", "ToolOutcome",
    "get_tool", "catalog", "run_server_tool",
]
