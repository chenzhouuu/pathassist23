"""The five reasoning nodes of the M3 merged loop.

Each node is a plain function ``node(state, deps) -> dict`` returning a partial
state update (LangGraph merges it via the reducers configured in Task 7; the
graph binds ``deps`` with ``functools.partial``). Nodes **never raise** on an
LLM or perception failure -- they degrade gracefully and emit an event, because
abstention is a feature of the agent, not a bug. Only the specific domain errors
:class:`LLMError` and :class:`PerceptionError` are caught.
"""

import logging

from .llm_client import LLMError
from .perception import PerceptionError
from .state import (
    AgentState,
    Deps,
    describe_event,
    diagnose_event,
    navigate_event,
    route_event,
    triage_event,
)

logger = logging.getLogger(__name__)

_DESCRIBE_SYSTEM = (
    "You are a terse breast-pathology assistant. Given a region's coordinates "
    "and its concept affinity, say in 1-2 sentences what morphology a "
    "pathologist would examine there. Be specific and concise."
)

_DIAGNOSE_SYSTEM = (
    "You are a careful breast-pathology assistant. Given region findings and an "
    "optional classifier prediction, name the single most likely diagnosis. "
    'Reply with one JSON object and nothing else: {"answer": "<subtype>", '
    '"reasoning": "<1-2 sentences>"}.'
)


def router(state: AgentState, deps: Deps) -> dict:
    """Entry node: rule-based task routing (deterministic, no LLM call).

    v1 scope is Diagnosis only, so we always route to the Diagnosis task with
    the full tool set. Kept deterministic to avoid an LLM round-trip at the
    graph entry.
    """
    tools = ["navigate", "classifier", "kb", "verify"]
    return {"task": "Diagnosis", "events": [route_event("Diagnosis", tools)]}


def triage(state: AgentState, deps: Deps) -> dict:
    """Set the exploration budget from the classifier risk (deterministic, no LLM).

    Triage stays cheap and rule-based: the BRCA classifier only ever predicts a
    malignant subtype (IDC/ILC), so its presence implies a suspicious case that
    warrants a deep look; its absence leaves us uncertain and we probe less.
    """
    max_cap = deps.settings.agent_max_regions
    if deps.classifier is not None:
        risk, depth, max_regions = "suspicious", "deep", max_cap
    else:
        risk, depth, max_regions = "uncertain", "moderate", min(4, max_cap)
    return {
        "budget": {"max_regions": max_regions, "spent": 0},
        "events": [triage_event(risk, depth, max_regions)],
    }


def navigate(state: AgentState, deps: Deps) -> dict:
    """Emit ONE next region to visit; runs perception once on the first call.

    The navigate<->describe cycle advances one region per invocation. The graph's
    conditional edge (Task 7) decides when to stop, so this must be a safe no-op
    when the budget is spent or no regions remain. Perception runs only when
    ``nav`` has not been computed yet, and a failed run yields an empty nav dict
    (never raises).
    """
    nav = state.get("nav")
    update: dict = {}
    if nav is None:
        nav = _run_perception(state, deps)
        update["nav"] = nav

    regions = nav.get("regions", [])
    idx = len(state.get("visited", []))
    max_regions = state.get("budget", {}).get(
        "max_regions", deps.settings.agent_max_regions
    )

    if idx < len(regions) and idx < max_regions:
        region = regions[idx]
        box = _region_box(region)
        event = navigate_event(box, _zoom_for(region), region.get("rationale", ""))
        update["visited"] = [region]
        update["events"] = [event]
    else:
        # Budget spent or regions exhausted: no region to visit.
        update.setdefault("events", [])
    return update


def describe(state: AgentState, deps: Deps) -> dict:
    """Describe the most recently visited region (guidance-level, no pixels).

    NOTE: v1 does NOT fetch the region's pixels -- Girder crop fetch is deferred
    to M4 / live-ROI. The description is guidance derived from the region's
    coordinates and concept affinity, not from an actual image read. Degrades to
    a templated finding when the LLM is unavailable (never raises).
    """
    visited = state.get("visited", [])
    if not visited:
        return {"events": []}
    region = visited[-1]

    try:
        findings = deps.llm.complete(_DESCRIBE_SYSTEM, _describe_user(region))
    except LLMError:
        logger.warning("describe LLM failed; using templated fallback", exc_info=True)
        findings = (
            f"Region at ({region.get('x', 0)}, {region.get('y', 0)}); "
            f"concept affinity {region.get('score', 0)}."
        )

    return {
        "descriptions": [{"region": region, "findings": findings}],
        "events": [describe_event(region, findings)],
    }


def diagnose(state: AgentState, deps: Deps) -> dict:
    """Synthesize candidate answers from the classifier and the LLM.

    Produces a classifier candidate (when present) plus an LLM candidate, and a
    preliminary answer that prefers the classifier. Degrades to a templated LLM
    candidate (classifier prediction, else "uncertain") when the reasoning LLM
    is unavailable (never raises).
    """
    classifier = deps.classifier
    candidates: list[dict] = []

    if classifier is not None:
        candidates.append(
            {
                "source": "classifier",
                "answer": classifier["prediction"],
                "detail": (
                    f"IDC {classifier['idc_prob']}% / ILC {classifier['ilc_prob']}% "
                    f"(confidence {classifier['confidence']}%)"
                ),
            }
        )

    try:
        obj = deps.llm.complete_json(_DIAGNOSE_SYSTEM, _diagnose_user(state, classifier))
        llm_answer = str(obj.get("answer", ""))
        reasoning = str(obj.get("reasoning", ""))
    except LLMError:
        logger.warning("diagnose LLM failed; using fallback candidate", exc_info=True)
        llm_answer = classifier["prediction"] if classifier is not None else "uncertain"
        reasoning = "LLM unavailable"
    candidates.append({"source": "llm", "answer": llm_answer, "detail": reasoning})

    prelim = classifier["prediction"] if classifier is not None else llm_answer
    return {
        "candidates": candidates,
        "prelim": prelim,
        "events": [diagnose_event(candidates)],
    }


# ── helpers ──────────────────────────────────────────────────────────────────


def _run_perception(state: AgentState, deps: Deps) -> dict:
    """Run perception once; degrade to an empty nav dict on failure (never raises)."""
    try:
        result = deps.perception.run(
            state["cache_key"],
            state["question"],
            state["task_id"],
            state.get("roi"),
        )
    except PerceptionError:
        logger.warning("perception failed; navigating with no regions", exc_info=True)
        return {
            "regions": [],
            "raster_extent": None,
            "grid_shape": [],
            "kb_hits": [],
            "error": "perception failed",
        }
    return {
        "regions": result.regions,
        "raster_extent": result.raster_extent,
        "grid_shape": result.grid_shape,
        "kb_hits": result.kb_hits,
    }


def _region_box(region: dict) -> dict:
    """Strip a perception region down to just its x/y/width/height box."""
    return {k: region.get(k, 0) for k in ("x", "y", "width", "height")}


def _zoom_for(region: dict) -> int:
    """Pick a display magnification for a region (simple v1 heuristic).

    Smaller regions get a higher magnification so fine morphology is legible.
    """
    width = region.get("width", 0)
    return 40 if 0 < width <= 512 else 20


def _describe_user(region: dict) -> str:
    """Render the describe prompt from a region's coords + concept affinity."""
    affinity = region.get("rationale") or f"score {region.get('score', 0)}"
    return (
        f"Region at level-0 ({region.get('x', 0)}, {region.get('y', 0)}), "
        f"size {region.get('width', 0)}x{region.get('height', 0)} px. "
        f"Concept affinity: {affinity}. In 1-2 sentences, what morphology "
        f"would you examine here?"
    )


def _diagnose_user(state: AgentState, classifier: dict | None) -> str:
    """Summarize visited descriptions + optional classifier for the diagnose LLM."""
    lines: list[str] = []
    descriptions = state.get("descriptions", [])
    if descriptions:
        lines.append("Region findings:")
        lines.extend(
            f"{i}. {desc.get('findings', '')}"
            for i, desc in enumerate(descriptions, start=1)
        )
    else:
        lines.append("No region findings were gathered.")
    if classifier is not None:
        lines.append(
            f"\nClassifier prediction: {classifier.get('prediction', 'unknown')} "
            f"(IDC {classifier.get('idc_prob', 0)}% / ILC {classifier.get('ilc_prob', 0)}%)."
        )
    lines.append('\nReturn only {"answer": "<subtype>", "reasoning": "<1-2 sentences>"}.')
    return "\n".join(lines)
