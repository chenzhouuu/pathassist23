"""Planner seam (PathAgent v2, increment 4).

Decides whether a turn warrants a runnable plan and, if so, proposes ordered steps
whose tool names are **enum-constrained to the registry** — the model literally cannot
name a tool that does not exist (TissueLab's `impl` was a free string). Returns a raw
plan ``{"steps": [...], "reason": str}`` or ``None`` (→ the turn is plain chat).

The route is the validation authority: it compiles, validates, digests, and persists
whatever the planner returns.
"""

import logging
from abc import ABC, abstractmethod

import anthropic

from ..common.config import Settings
from .registry import Registry
from .validate import validate_plan

logger = logging.getLogger(__name__)

# Keyless/deterministic heuristic: the ACTION of measuring, not mere mention of a cell
# type — so "what is a lymphocyte?" reads as chat, "count lymphocytes" as a plan.
_QUANTIFY_CUES = (
    "count", "how many", "number of", "density", "quantify", "segment",
    "measure", "detect", "proportion", "fraction",
)


class Planner(ABC):
    """Proposes a plan for a turn, or declines (returns None → chat)."""

    @abstractmethod
    async def propose(
        self, *, text: str, history: list[dict], scope: dict, registry: Registry
    ) -> dict | None:
        """Return ``{"steps": [...], "reason": str}`` or ``None`` when no plan is warranted."""


class StubPlanner(Planner):
    """Deterministic planner for keyless dev and tests: a keyword heuristic that maps a
    quantitative ask to the canned segment→count chain."""

    async def propose(self, *, text, history, scope, registry):
        low = text.lower()
        if not any(cue in low for cue in _QUANTIFY_CUES):
            return None
        cell_class = "tumor" if ("tumor" in low or "tumour" in low) else "lymphocyte"
        steps = [
            {"n": 1, "tool": "nuclei_segment_stub", "category": "NucleiSeg",
             "args": {"mpp": 0.25}},
            {"n": 2, "tool": "count_within_roi", "category": "Quantify",
             "args": {"cell_class": cell_class}},
        ]
        reason = (
            "Cell-level counting needs per-nucleus segmentation first, then a "
            "deterministic count of the requested class within the region."
        )
        return {"steps": steps, "reason": reason}


_PLANNER_SYSTEM = (
    "You are the planning stage of PathAssist Copilot, a research assistant in a "
    "whole-slide pathology viewer. Decide whether the user's message is a request to "
    "QUANTIFY or MEASURE something on the slide (counts, density, segmentation, spatial "
    "stats). If so, call `propose_plan` with the minimal ordered chain of tools from the "
    "catalog below; order them so every step's input artifacts are produced by an earlier "
    "step or supplied by the scope. If the message is a general question or discussion, "
    "do NOT call the tool — it is answered conversationally elsewhere.\n\n"
    "CRITICAL — args vs artifacts: a step's `args` object contains ONLY the tuning "
    "parameters listed under 'args' for that tool, and nothing else. Inputs and outputs "
    "(slide_ref, roi, nuclei, count, density, …) are ARTIFACTS that flow automatically "
    "between steps and from the scope — NEVER put an artifact in `args`. For example, a "
    "count step's args is exactly {\"cell_class\": \"lymphocyte\"} — not the nuclei or the "
    "roi. Research use only; never emit a count yourself — the tools compute the numbers."
)


def _plan_tool(registry: Registry) -> dict:
    return {
        "name": "propose_plan",
        "description": (
            "Propose a runnable analysis plan. Call this only for quantitative/measurement "
            "requests about the slide or region; otherwise do not call it."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            # Enum-constrained: the model cannot name a nonexistent tool.
                            "tool": {"type": "string", "enum": registry.names()},
                            "category": {"type": "string"},
                            "args": {"type": "object"},
                        },
                        "required": ["tool", "args"],
                    },
                },
                "reason": {"type": "string"},
            },
            "required": ["steps", "reason"],
        },
    }


class ClaudePlanner(Planner):
    def __init__(self, *, api_key: str, model: str, max_tokens: int) -> None:
        self._client = anthropic.AsyncAnthropic(api_key=api_key)
        self._model = model
        self._max_tokens = max_tokens

    async def propose(self, *, text, history, scope, registry):
        has_roi = bool((scope or {}).get("roi"))
        system = (
            f"{_PLANNER_SYSTEM}\n\nTOOL CATALOG:\n{registry.catalog_text()}\n\n"
            f"SCOPE: a slide is in context (slide_ref). "
            f"{'A region of interest (roi) is selected.' if has_roi else 'No region is selected.'}"
        )
        messages = history or [{"role": "user", "content": text}]
        plan = await self._call(system, messages, registry)
        if plan is None:
            return None

        # Bounded self-repair: if the plan does not validate, feed the errors back once.
        errors = validate_plan({"scope": scope, "steps": plan["steps"]}, registry)
        if errors:
            logger.info("planner self-repair (%d errors)", len(errors))
            repair_system = (
                f"{system}\n\nYOUR PREVIOUS PLAN WAS INVALID:\n- " + "\n- ".join(errors)
                + "\nReturn a corrected plan. Put ONLY the listed args in each step's args."
            )
            repaired = await self._call(repair_system, messages, registry, force=True)
            if repaired is not None:
                return repaired
        return plan

    async def _call(self, system, messages, registry, *, force=False):
        kwargs = {
            "model": self._model,
            "max_tokens": self._max_tokens,
            "system": system,
            "tools": [_plan_tool(registry)],
            "messages": messages,
        }
        if force:  # require the tool on the repair pass
            kwargs["tool_choice"] = {"type": "tool", "name": "propose_plan"}
        resp = await self._client.messages.create(**kwargs)
        for block in resp.content:
            if getattr(block, "type", None) == "tool_use" and block.name == "propose_plan":
                data = block.input or {}
                return {"steps": data.get("steps", []), "reason": data.get("reason", "")}
        return None


def build_planner(settings: Settings) -> Planner:
    """Pick the planner from config: Claude when a key is set, else the deterministic stub."""
    if settings.anthropic_api_key:
        logger.info("planner: Claude (%s)", settings.anthropic_model)
        return ClaudePlanner(
            api_key=settings.anthropic_api_key,
            model=settings.anthropic_model,
            max_tokens=settings.anthropic_max_tokens,
        )
    logger.warning("planner: stub (no AGENT_ANTHROPIC_API_KEY set)")
    return StubPlanner()
