"""Agent state and dependency bundle for the M3 orchestrator reasoning loop.

Defines the LangGraph ``AgentState`` (a partial-update ``TypedDict`` wired with
list-append reducers in Task 7) and the immutable ``Deps`` bundle each node
receives. Thin event-builder helpers keep the node functions terse and give the
streamed events a single, consistent shape.
"""

from dataclasses import dataclass
from typing import TypedDict

from ..common.config import Settings
from .llm_client import LLMClient
from .perception import PerceptionRunner


class AgentState(TypedDict, total=False):
    """Shared state threaded through the reasoning graph.

    List-valued keys (``events``, ``visited``, ``descriptions``, ``candidates``)
    are merged by append-reducers, so nodes return only the *new* items to
    append. Scalar keys (``task``, ``budget``, ``nav``, ``prelim`` ...) are
    replaced with the returned value.
    """

    question: str
    task: str
    item_id: str
    cache_key: str
    task_id: str
    roi: dict | None
    budget: dict  # {"max_regions": int, "spent": int}
    nav: dict | None  # NavResult as a dict, or {"regions": [], ...} on failure
    visited: list[dict]  # regions visited (append)
    descriptions: list[dict]  # {region, findings} (append)
    candidates: list[dict]  # {source, answer, detail} (append)
    prelim: str
    scores: dict  # filled in Task 6
    citations: list[dict]  # filled in Task 6
    final: dict  # filled in Task 6
    events: list[dict]  # streamed events (append)


@dataclass(frozen=True)
class Deps:
    """Immutable per-request dependencies bound into each node via ``partial()``.

    Attributes:
        llm: Reasoning LLM backend for describe/diagnose.
        perception: CONCH concept-similarity navigation runner.
        settings: Runtime configuration (budgets, encoders, ...).
        classifier: Parsed ``classifier.json`` dict, or ``None`` if absent.
    """

    llm: LLMClient
    perception: PerceptionRunner
    settings: Settings
    classifier: dict | None


def route_event(task: str, tools: list[str]) -> dict:
    """Build a ``route`` stream event."""
    return {"type": "route", "task": task, "tools": tools}


def triage_event(risk: str, depth: str, max_regions: int) -> dict:
    """Build a ``triage`` stream event."""
    return {"type": "triage", "risk": risk, "depth": depth, "maxRegions": max_regions}


def navigate_event(region: dict, zoom: float, rationale: str) -> dict:
    """Build a ``navigate`` stream event (region carries only x/y/width/height)."""
    return {"type": "navigate", "region": region, "zoom": zoom, "rationale": rationale}


def describe_event(region: dict, findings: str) -> dict:
    """Build a ``describe`` stream event."""
    return {"type": "describe", "region": region, "findings": findings}


def diagnose_event(candidates: list[dict]) -> dict:
    """Build a ``diagnose`` stream event."""
    return {"type": "diagnose", "candidates": candidates}
