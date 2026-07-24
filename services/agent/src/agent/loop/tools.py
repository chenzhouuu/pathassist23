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
from typing import TYPE_CHECKING

from .artifacts import ArtifactHandle, ArtifactStore
from .biomarker_client import phenotype_cells as biomarker_phenotype
from .pannuke import PANNUKE_NAMES
from .pathvlm_client import describe_region as pathvlm_describe
from .preprocess_client import find_regions as preprocess_find_regions
from .segmenter import segment_region

if TYPE_CHECKING:
    from ..store import PreprocessArtifactStore

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
    conversation it belongs to, where bulk output is written (D4), the server-side Girder
    token, and the CellViT (segmentation) + pathvlm (Perceptor) service URLs. The token never
    enters the model (D3)."""

    owner: str
    conversation_id: int
    artifacts: ArtifactStore | None = None
    girder_token: str | None = None
    cellvit_url: str | None = None
    pathvlm_url: str | None = None
    preprocess_url: str | None = None
    biomarker_url: str | None = None
    preprocess_artifacts: "PreprocessArtifactStore | None" = None


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
    "describe_region": LoopTool(
        "describe_region", SERVER, "Describe region",
        "Read the tissue morphology in a region at a chosen magnification (objective power, "
        "e.g. 20). Pass `bbox` with the level-0 coordinates of the region to read (e.g. a "
        "candidate box from find_regions); it reads exactly that box, not wherever the viewer "
        "was last panned. Pass `focus` with the specific morphological question the user is after "
        "(e.g. 'degree of nuclear atypia', 'gland architecture') so the read answers it; omit "
        "focus for a general morphology read.",
    ),
    "find_regions": LoopTool(
        "find_regions", SERVER, "Find regions",
        "Search the whole slide for regions matching a free-text description (e.g. 'invasive "
        "tumor', 'lymphocyte-rich stroma') and return the top candidate regions as level-0 "
        "bounding boxes ranked by similarity. Candidates locate where to look — confirm "
        "morphology with describe_region before asserting a finding. Requires the slide to be "
        "preprocessed for text search first.",
    ),
    "phenotype_cells": LoopTool(
        "phenotype_cells", SERVER, "Phenotype cells",
        "Phenotype the individual cells in a region: predicts virtual biomarkers (GigaTIME) and "
        "assigns each nucleus a lineage (e.g. Tumour, Cytotoxic T, Macrophage) plus functional "
        "flags (Ki67 proliferating, PD-1/PD-L1). Pass `bbox` with the level-0 coordinates of the "
        "region to phenotype; it reads exactly that box. Returns per-lineage counts. The "
        "biomarkers are a research-only, PREDICTED signal and positivity is relative to the "
        "region — report the counts, don't treat them as a clinical marker readout.",
    ),
}

# Canned nuclei count for the R8 stub; R10 replaces the executor with real CellViT output.
_STUB_NUCLEI = 1234


def get_tool(name: str) -> LoopTool | None:
    return _TOOLS.get(name)


def catalog() -> list[LoopTool]:
    """The full two-class catalog, in registration order."""
    return list(_TOOLS.values())


def _counts_by_type(classes: list[str]) -> dict[str, int]:
    """Per-class tally (by name) — the summary's numbers are always this, never model-computed."""
    counts: dict[str, int] = {}
    for name in classes:
        if name:
            counts[name] = counts.get(name, 0) + 1
    return counts


def _typed_summary(count: int, counts_by_type: dict[str, int]) -> str:
    """Format a typed breakdown, e.g. '195 nuclei — 142 Neoplastic, 31 Inflammatory'.

    Sorted desc by count; no classes → just the total. Numbers are always tool-derived."""
    head = f"{count:,} nuclei"
    if not counts_by_type:
        return head
    parts = [f"{n:,} {name}" for name, n in
             sorted(counts_by_type.items(), key=lambda kv: (-kv[1], kv[0]))]
    return f"{head} — {', '.join(parts)}"


def _stub_nuclei_geometry(bbox: dict | None) -> dict:
    """A deterministic canned point set with a deterministic PanNuke class (name) per point.
    Placed inside the bbox when one is given so the geometry is spatially plausible."""
    ox = float(bbox["x"]) if bbox else 0.0
    oy = float(bbox["y"]) if bbox else 0.0
    points = [[ox + (i % 64), oy + (i // 64)] for i in range(_STUB_NUCLEI)]
    classes = [PANNUKE_NAMES[i % 5] for i in range(_STUB_NUCLEI)]
    return {"kind": "nuclei", "count": len(points), "points": points, "classes": classes}


# A ceiling on the region a single interactive segmentation may cover (level-0 px^2). A
# whole-slide-sized ROI would tie up the GPU for minutes; beyond this we ask the user to
# zoom in. Whole-slide / async segmentation is deferred to R12.
_MAX_SEG_AREA = 4096 * 4096


# Encoders whose patch features live in a text space (mirrors the preprocess worker's
# is_text_capable): only these back find_regions text search.
_TEXT_ENCODERS = frozenset({"conch_v1_text", "musk"})


async def _resolve_text_features(ctx: ToolContext, item: str) -> tuple[str | None, str | None]:
    """Newest ready, text-capable DAG features artifact for a slide → (feat_hash, encoder).

    Returns (None, None) when the slide has no such DAG row (a legacy flat index or an
    unprocessed slide), so find_regions keeps its legacy resolution path for back-compat.
    """
    store = ctx.preprocess_artifacts
    if store is None:
        return None, None
    try:
        rows = await store.list_artifacts(item=item)
    except Exception:  # noqa: BLE001 — a store hiccup just means "no DAG hint"; fall back
        logger.warning("could not list preprocess artifacts for %s", item, exc_info=True)
        return None, None
    for r in rows:
        if r.get("kind") == "features" and r.get("status") == "ready":
            enc = (r.get("params") or {}).get("encoder")
            if enc in _TEXT_ENCODERS:
                return r.get("art_hash"), enc
    return None, None


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
            summary = f"segmented {_typed_summary(res.count, res.counts_by_type)}{mpp_note}"
            if ctx.artifacts is None:
                return ToolOutcome(ok=True, summary=summary)
            geometry = {"kind": "nuclei", "count": res.count, "points": res.points,
                        "classes": res.classes}
            try:
                handle = await ctx.artifacts.put(
                    owner=ctx.owner, conversation_id=ctx.conversation_id, kind="nuclei",
                    bbox=region, geometry=geometry, summary=f"{res.count:,} nuclei",
                    item_id=slide_ref, token=ctx.girder_token,
                )
            except Exception:  # noqa: BLE001 — persisting the overlay must not sink the count
                logger.warning("persisting nuclei annotation failed", exc_info=True)
                return ToolOutcome(ok=True, summary=summary)
            return ToolOutcome(ok=True, summary=summary, artifact=handle)

        # Canned stub (no service configured / unit context) — honors the bbox arg too.
        where = "in the region" if region else "across the slide"
        geometry = _stub_nuclei_geometry(region)
        counts = _counts_by_type(geometry["classes"])
        summary = f"segmented {_typed_summary(geometry['count'], counts)} {where}"
        if ctx is None or ctx.artifacts is None:
            return ToolOutcome(ok=True, summary=summary)
        try:
            handle = await ctx.artifacts.put(
                owner=ctx.owner, conversation_id=ctx.conversation_id, kind="nuclei",
                bbox=region, geometry=geometry, summary=f"{geometry['count']:,} nuclei",
                item_id=(scope or {}).get("item_id"), token=ctx.girder_token,
            )
        except Exception:  # noqa: BLE001 — persisting the overlay must not sink the count
            logger.warning("persisting nuclei annotation failed", exc_info=True)
            return ToolOutcome(ok=True, summary=summary)
        return ToolOutcome(ok=True, summary=summary, artifact=handle)

    if tool.name == "describe_region":
        # Perceptor (MedGemma) morphology read. Summary-only in Inc 2a — the regions overlay
        # (a rectangle artifact) is Inc 2c.
        region = args.get("bbox") or (scope or {}).get("roi")
        if region is None:
            return ToolOutcome(
                ok=False,
                summary="Tell me which region to describe — draw one on the slide, pan to it, "
                        "or pass a bounding box.",
            )
        if ctx is None or not ctx.pathvlm_url:
            return ToolOutcome(
                ok=False,
                summary="The Perceptor service isn't configured, so I can't describe the region.",
            )
        slide_ref = (scope or {}).get("item_id")
        if not slide_ref:
            return ToolOutcome(
                ok=False, summary="No slide is loaded to describe — open a slide and ask again."
            )
        try:
            res = await pathvlm_describe(
                base_url=ctx.pathvlm_url, slide_ref=slide_ref, bbox=region,
                magnification=args.get("magnification"), focus=args.get("focus"),
                token=ctx.girder_token,
            )
        except Exception as exc:  # noqa: BLE001 — surface the failure as a tool result
            logger.warning("describe_region failed", exc_info=True)
            return ToolOutcome(ok=False, summary=f"description failed ({type(exc).__name__})")
        # Ground the read to the region + magnification it actually saw — NOT the tool name.
        # The trace/overlay already shows the source; the model only needs the morphology and
        # where/at-what-mag it was read, to weigh it as evidence (it must not re-narrate the
        # tool in its answer — see _SYSTEM).
        at_mag = f" at {res.magnification:g}x" if res.magnification else ""
        x, y = int(region.get("x", 0)), int(region.get("y", 0))
        summary = f"Morphology of region ({x},{y}){at_mag}: {res.description}"
        # Inc 2c: echo the region MedGemma actually read as a lightweight rectangle artifact.
        # The bbox rides inline (no store/fetch, unlike nuclei) — the RegionOverlay draws it and
        # the trace card re-shows it, tagged with the clamped magnification the Perceptor saw.
        region_bbox = {
            "x": x, "y": y,
            "width": int(region.get("width", 0)), "height": int(region.get("height", 0)),
        }
        artifact = ArtifactHandle(
            kind="region", ref="", count=1, summary=f"described{at_mag}",
            bbox=region_bbox, meta={"magnification": res.magnification, "mpp": res.mpp},
        )
        return ToolOutcome(ok=True, summary=summary, artifact=artifact)

    if tool.name == "find_regions":
        # Whole-slide text→patch retrieval over a Trident/CONCH index (Inc 2b-3). Candidates,
        # not verified findings — the model must confirm with describe_region (see _SYSTEM).
        query = (args.get("query") or "").strip()
        if not query:
            return ToolOutcome(
                ok=False,
                summary="Tell me what to look for — a short description like 'invasive tumor' "
                        "or 'lymphocyte-rich stroma'.",
            )
        if ctx is None or not ctx.preprocess_url:
            return ToolOutcome(
                ok=False,
                summary="Region search isn't configured, so I can't search this slide.",
            )
        slide_ref = (scope or {}).get("item_id")
        if not slide_ref:
            return ToolOutcome(
                ok=False, summary="No slide is loaded to search — open a slide and ask again."
            )
        k = int(args.get("k") or 8)
        # Point the worker at the DAG feature index the 3-stage panel built
        # (feat/{hash}/features.h5). Without this hint the worker falls back to the legacy flat
        # cache the DAG never writes, so every DAG-built slide reads as "not indexed".
        feat_hash, feat_encoder = await _resolve_text_features(ctx, slide_ref)
        try:
            res = await preprocess_find_regions(
                base_url=ctx.preprocess_url, item=slide_ref, query=query, k=k,
                token=ctx.girder_token, feat_hash=feat_hash, encoder=feat_encoder,
            )
        except Exception as exc:  # noqa: BLE001 — surface the failure as a tool result
            logger.warning("find_regions failed", exc_info=True)
            return ToolOutcome(ok=False, summary=f"region search failed ({type(exc).__name__})")
        if res is None:
            return ToolOutcome(
                ok=False,
                summary="This slide isn't preprocessed for text search yet — build a conch_v1_text "
                        "index for it first, then I can search it.",
            )
        if not res.regions:
            return ToolOutcome(
                ok=True, summary=f"No regions on this slide matched '{query}'."
            )
        n = len(res.regions)
        # Candidate generator only: return the top-K boxes ranked by similarity. These are leads,
        # not findings — precision comes from verifying each with describe_region, not from a
        # retrieval-side confidence score (on real CONCH the cosine doesn't separate signal from
        # noise). The model reads the candidates' coordinates off the handle meta.
        summary = (
            f"Found {n} candidate region(s) for '{query}', ranked by similarity. These are leads "
            f"to check, not findings — read the top ones and report each that holds up, with its "
            f"location."
        )
        artifact = ArtifactHandle(
            kind="regions", ref="", count=n, summary=summary,
            meta={"query": query, "encoder": res.encoder, "regions": res.regions},
        )
        return ToolOutcome(ok=True, summary=summary, artifact=artifact)

    if tool.name == "phenotype_cells":
        # Virtual-biomarker × CellViT-nuclei fusion (Inc 3a). One region → per-cell phenotypes.
        region = args.get("bbox") or (scope or {}).get("roi")
        if region is None:  # whole-slide phenotyping is the Inc 3b job, not this route (review S5)
            return ToolOutcome(
                ok=False,
                summary="Whole-slide phenotyping isn't available yet — draw a region on the "
                        "slide (or pan to one) and ask again.",
            )
        if ctx is None or not ctx.biomarker_url:
            return ToolOutcome(
                ok=False,
                summary="Cell phenotyping isn't configured, so I can't phenotype cells here.",
            )
        slide_ref = (scope or {}).get("item_id")
        if not slide_ref:
            return ToolOutcome(
                ok=False, summary="No slide is loaded — open a slide and ask again."
            )
        area = float(region.get("width", 0)) * float(region.get("height", 0))
        if area > _MAX_SEG_AREA:
            return ToolOutcome(
                ok=False,
                summary="That region is too large for interactive phenotyping — zoom to a smaller "
                        "area (about 4000x4000 pixels or less) and ask again.",
            )
        try:
            res = await biomarker_phenotype(
                base_url=ctx.biomarker_url, slide_ref=slide_ref, bbox=region,
                focus=args.get("focus"), token=ctx.girder_token,
            )
        except Exception as exc:  # noqa: BLE001 — surface the failure as a tool result
            logger.warning("phenotype_cells failed", exc_info=True)
            return ToolOutcome(ok=False, summary=f"cell phenotyping failed ({type(exc).__name__})")
        summary = _phenotype_summary(res, args.get("focus"))
        if ctx.artifacts is None:
            return ToolOutcome(ok=True, summary=summary)
        geometry = {
            "kind": "phenotype", "count": res.count,
            "points": [[c["x"], c["y"]] for c in res.cells],
            "classes": [c["phenotype"] for c in res.cells],  # lets the overlay colour by lineage
            "cells": res.cells,  # per-cell flags + gate-deciding markers, for the tooltip
        }
        try:
            handle = await ctx.artifacts.put(
                owner=ctx.owner, conversation_id=ctx.conversation_id, kind="phenotype",
                bbox=region, geometry=geometry, summary=f"{res.count:,} cells phenotyped",
                item_id=slide_ref, token=ctx.girder_token,
            )
        except Exception:  # noqa: BLE001 — persisting the overlay must not sink the counts
            logger.warning("persisting phenotype annotation failed", exc_info=True)
            return ToolOutcome(ok=True, summary=summary)
        return ToolOutcome(ok=True, summary=summary, artifact=handle)

    return ToolOutcome(ok=False, summary=f"no server executor for {tool.name}")


def _phenotype_summary(res, focus: str | None = None) -> str:
    """A tool-derived phenotype summary — counts only (never model-invented), framed as predicted
    and region-relative so the model reports it honestly (design §7, review B1). ``focus`` (the
    user's stated interest) is echoed so the model tailors its answer to it."""
    if res.count == 0:
        return "No nuclei to phenotype in that region."
    parts = [
        f"{n:,} {name}" for name, n in
        sorted(res.counts_by_phenotype.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    body = f" — {', '.join(parts)}" if parts else ""
    flags = sorted(res.flag_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    flag_str = f"; {', '.join(f'{n:,} {name}' for name, n in flags)}" if flags else ""
    focus_str = f" Focus requested: {focus}." if focus else ""
    return (
        f"{res.count:,} cells{body}{flag_str}.{focus_str} These are predicted virtual biomarkers "
        f"and positivity is relative to this region (research-only, not a clinical marker readout)."
    )


__all__ = [
    "CLIENT", "SERVER", "LoopTool", "ToolContext", "ToolOutcome",
    "get_tool", "catalog", "run_server_tool",
]
