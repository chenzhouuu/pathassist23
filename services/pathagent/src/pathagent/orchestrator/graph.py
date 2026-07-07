"""LangGraph wiring for the M3 merged reasoning loop + the streaming driver.

:func:`build_graph` compiles the router -> triage -> (navigate <-> describe)* ->
diagnose -> {icv, fact, consensus} -> summary topology, binding the immutable
:class:`~.state.Deps` bundle into every node with ``functools.partial``. The
navigate<->describe cycle is bounded by :func:`_route_after_describe`, which
stops as soon as the exploration budget is spent or the perception regions are
exhausted (the ``visited`` append-reducer is what advances the loop index).

:func:`run_query` drives one request through the compiled graph and yields the
stream events node-by-node so the gateway can relay them as SSE.
"""

import functools
from collections.abc import AsyncIterator

from langgraph.graph import END, START, StateGraph

from ..common.schemas import AgentQueryRequest
from . import nodes, verify
from .state import AgentState, Deps

# Backstop on graph supersteps; the exploration budget already bounds the
# navigate loop, so this only guards against an unexpected non-terminating cycle.
_RECURSION_LIMIT = 50


def build_graph(deps: Deps):
    """Compile the merged reasoning graph with ``deps`` bound into every node.

    Args:
        deps: Immutable per-request dependency bundle (llm, perception,
            settings, classifier) partial-applied to each node function.

    Returns:
        A compiled LangGraph runnable exposing ``astream``.
    """

    def bind(fn):
        """Bind ``deps`` as a keyword so nodes stay ``fn(state)`` for the graph."""
        return functools.partial(fn, deps=deps)

    g = StateGraph(AgentState)
    g.add_node("router", bind(nodes.router))
    g.add_node("triage", bind(nodes.triage))
    g.add_node("navigate", bind(nodes.navigate))
    g.add_node("describe", bind(nodes.describe))
    g.add_node("diagnose", bind(nodes.diagnose))
    g.add_node("icv", bind(verify.icv))
    g.add_node("fact", bind(verify.fact))
    g.add_node("consensus", bind(verify.consensus))
    g.add_node("summary", bind(verify.summary))

    g.add_edge(START, "router")
    g.add_edge("router", "triage")
    g.add_edge("triage", "navigate")
    g.add_edge("navigate", "describe")
    g.add_conditional_edges(
        "describe",
        _route_after_describe,
        {"navigate": "navigate", "diagnose": "diagnose"},
    )
    for branch in ("icv", "fact", "consensus"):
        g.add_edge("diagnose", branch)
        g.add_edge(branch, "summary")
    g.add_edge("summary", END)
    return g.compile()


def _route_after_describe(state: AgentState) -> str:
    """Loop back to ``navigate`` while budget + regions remain, else ``diagnose``.

    Mirrors :func:`nodes.navigate`'s own gating: continue exploring only while
    fewer regions have been visited than both the perception region count and
    the triage budget cap.
    """
    nav = state.get("nav") or {}
    regions = nav.get("regions", [])
    visited = len(state.get("visited", []))
    max_regions = (state.get("budget") or {}).get("max_regions", 0)
    if visited < len(regions) and visited < max_regions:
        return "navigate"
    return "diagnose"


async def run_query(
    request: AgentQueryRequest, deps: Deps, task_id: str
) -> AsyncIterator[dict]:
    """Run one query through the compiled graph, yielding stream events in order.

    Args:
        request: Parsed client query (question, item/cache ids, task, optional ROI).
        deps: Per-request dependency bundle bound into the graph nodes.
        task_id: Unique id for this run; names the heatmap PNG and rides on the
            ``final`` event as ``heatmapTaskId``.

    Yields:
        Stream event dicts (``route``, ``triage``, ``navigate``, ``describe``,
        ``diagnose``, ``verify``, ``final``) in emission order.
    """
    graph = build_graph(deps)
    roi = request.roi.model_dump() if request.roi else None
    initial: AgentState = {
        "question": request.question,
        "task": request.task,
        "item_id": request.item_id,
        "cache_key": request.cache_key,
        "task_id": task_id,
        "roi": roi,
        "visited": [],
        "descriptions": [],
        "candidates": [],
        "citations": [],
        "events": [],
    }
    config = {"recursion_limit": _RECURSION_LIMIT}
    async for chunk in graph.astream(initial, config=config, stream_mode="updates"):
        # Each chunk maps node name -> that node's returned partial; a superstep
        # may contain several nodes (the parallel verifier fan-out), so drain all.
        for update in chunk.values():
            if isinstance(update, dict):
                for event in update.get("events", []):
                    yield event
