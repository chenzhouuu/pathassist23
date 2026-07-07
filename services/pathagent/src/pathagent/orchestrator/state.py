"""Agent state and dependency bundle for the M3 orchestrator reasoning loop.

Defines the LangGraph ``AgentState`` (a partial-update ``TypedDict`` wired with
list-append reducers in Task 7) and the immutable ``Deps`` bundle each node
receives. Thin event-builder helpers keep the node functions terse and give the
streamed events a single, consistent shape.
"""

import operator
from dataclasses import dataclass
from typing import Annotated, TypedDict

from ..common.config import Settings
from .llm_client import LLMClient
from .perception import PerceptionRunner


class AgentState(TypedDict, total=False):
    """Shared state threaded through the reasoning graph.

    List-valued keys (``events``, ``visited``, ``descriptions``, ``candidates``,
    ``citations``) carry ``Annotated[..., operator.add]`` append-reducers, so a
    node returns only the *new* items to append and LangGraph merges them across
    the navigate<->describe loop and the parallel verifier fan-out. This is what
    makes ``visited`` grow one region per loop iteration (navigate keys off its
    length). Scalar keys (``task``, ``budget``, ``nav``, ``prelim``, the ``phi_*``
    branch scores, ...) are plain and replaced last-write-wins.
    """

    question: str
    task: str
    item_id: str
    cache_key: str
    task_id: str
    roi: dict | None
    budget: dict  # {"max_regions": int, "spent": int}
    nav: dict | None  # NavResult as a dict, or {"regions": [], ...} on failure
    visited: Annotated[list[dict], operator.add]  # regions visited (append)
    descriptions: Annotated[list[dict], operator.add]  # {region, findings} (append)
    candidates: Annotated[list[dict], operator.add]  # {source, answer, detail} (append)
    prelim: str
    phi_l: float  # internal-consistency branch score (Task 6)
    phi_k: float  # factual-alignment branch score (Task 6)
    phi_c: float  # classifier-consensus branch score (Task 6)
    consensus_note: str  # note emitted by the consensus branch (Task 6)
    scores: dict  # composed display scores (Task 6)
    citations: Annotated[list[dict], operator.add]  # KB citations (append, Task 6)
    final: dict  # final answer payload (Task 6)
    events: Annotated[list[dict], operator.add]  # streamed events (append)


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
