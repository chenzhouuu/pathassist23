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

import logging
from dataclasses import dataclass

from .artifacts import ArtifactHandle, ArtifactStore
from .segmenter import segment_region

logger = logging.getLogger(__name__)

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
        "run_segmentation", SERVER, "Segment nuclei",
        "Segment the nuclei in the region and count them; returns a nucleus count and "
        "their locations.",
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


# A ceiling on the region a single interactive segmentation may cover (level-0 px^2). A
# whole-slide-sized ROI would tie up the GPU for minutes; beyond this we ask the user to
# zoom in. Whole-slide / async segmentation is deferred to R12.
_MAX_SEG_AREA = 4096 * 4096


async def run_server_tool(
    tool: LoopTool, args: dict, scope: dict, ctx: ToolContext | None = None
) -> ToolOutcome:
    """Execute a server-side data tool.

    The `run_segmentation` tool calls the CellViT service (R11) when one is configured on
    the context, else returns a canned stub. The args/scope decide the region (D8); bulk
    output is written to the ArtifactStore and only a **handle** rides the event (D4).
    Without a store (unit context) the tool degrades to a summary-only result.
    """
    if tool.name == "run_segmentation":
        # region: explicit model-chosen bbox wins, else the drawn ROI (D8, gap ④).
        region = args.get("bbox") or (scope or {}).get("roi")

        # Real path: a CellViT service is configured for this turn.
        if ctx is not None and ctx.cellvit_url:
            if region is None:
                return ToolOutcome(
                    ok=False,
                    summary="Whole-slide segmentation isn't available yet — draw a region "
                            "on the slide (or pan to one) and ask again.",
                )
            slide_ref = (scope or {}).get("item_id")
            if not slide_ref:
                return ToolOutcome(
                    ok=False,
                    summary="No slide is loaded to segment — open a slide and ask again.",
                )
            area = float(region.get("width", 0)) * float(region.get("height", 0))
            if area > _MAX_SEG_AREA:
                return ToolOutcome(
                    ok=False,
                    summary="That region is too large for interactive segmentation — zoom "
                            "to a smaller area (about 4000x4000 pixels or less) and ask again.",
                )
            try:
                res = await segment_region(
                    base_url=ctx.cellvit_url, slide_ref=slide_ref,
                    bbox=region, token=ctx.girder_token,
                )
            except Exception as exc:  # noqa: BLE001 — surface the failure as a tool result
                logger.warning("run_segmentation failed", exc_info=True)
                return ToolOutcome(ok=False, summary=f"segmentation failed ({type(exc).__name__})")
            # Ground density: give the model the slide's real µm/px so it stops assuming one.
            mpp_note = f" (at {res.mpp:.3g} µm/px)" if res.mpp else ""
            summary = f"segmented {res.count:,} nuclei in the region{mpp_note}"
            if ctx.artifacts is None:
                return ToolOutcome(ok=True, summary=summary)
            geometry = {"kind": "nuclei", "count": res.count, "points": res.points}
            handle = await ctx.artifacts.put(
                owner=ctx.owner, conversation_id=ctx.conversation_id, kind="nuclei",
                bbox=region, geometry=geometry, summary=f"{res.count:,} nuclei",
                item_id=slide_ref, token=ctx.girder_token,
            )
            return ToolOutcome(ok=True, summary=summary, artifact=handle)

        # Canned stub (no service configured / unit context) — honors the bbox arg too.
        where = "in the region" if region else "across the slide"
        if ctx is None or ctx.artifacts is None:
            return ToolOutcome(ok=True, summary=f"segmented {_STUB_NUCLEI:,} nuclei {where}")
        geometry = _stub_nuclei_geometry(region)
        handle = await ctx.artifacts.put(
            owner=ctx.owner, conversation_id=ctx.conversation_id, kind="nuclei",
            bbox=region, geometry=geometry, summary=f"{geometry['count']:,} nuclei",
            item_id=(scope or {}).get("item_id"), token=ctx.girder_token,
        )
        return ToolOutcome(
            ok=True, summary=f"segmented {handle.count:,} nuclei {where}", artifact=handle
        )
    return ToolOutcome(ok=False, summary=f"no server executor for {tool.name}")


__all__ = [
    "CLIENT", "SERVER", "LoopTool", "ToolContext", "ToolOutcome",
    "get_tool", "catalog", "run_server_tool",
]
