"""Typed agent-loop events (PathAgent v2, R7 — the SDK-loop seam).

D5 of the orchestrator RFC: the loop emits a *typed* event family (AG-UI vocabulary)
instead of an opaque token blob, so the frontend renders a live trace — a "thinking"
strip, tool cards (args → status → result), and the final answer — all correlated by
`run_id` / `tool_call_id`. Each event serializes to a compact SSE dict via `as_event()`;
the SSE frame contract (a JSON object keyed by `type`) is unchanged from earlier
increments.

R7 emits a stub trace from one trivial tool; R10 swaps the Claude Agent SDK behind this
identical event contract, so keep these dataclasses free of any SDK types.
"""

from dataclasses import asdict, dataclass, field
from typing import Any, ClassVar


@dataclass(frozen=True)
class AgentEvent:
    """Base event: correlates to a run and renders to an SSE-ready dict.

    `type` is a class-level discriminant (not a dataclass field), so subclasses set it
    once and `as_event()` folds it into the wire dict.
    """

    run_id: str
    type: ClassVar[str] = "event"

    def as_event(self) -> dict[str, Any]:
        """The compact dict shipped in an SSE `data:` frame (adds the discriminant)."""
        return {"type": self.type, **asdict(self)}


@dataclass(frozen=True)
class RunStarted(AgentEvent):
    """Turn opened."""

    type: ClassVar[str] = "run_started"


@dataclass(frozen=True)
class ReasoningDelta(AgentEvent):
    """A chunk of the model's thinking — rendered as the muted, collapsible strip."""

    text: str = ""
    type: ClassVar[str] = "reasoning_delta"


@dataclass(frozen=True)
class ToolCallStart(AgentEvent):
    """A tool invocation began — the frontend opens a live tool card with its args.

    `tool_class` (D3) tells the frontend how to handle it: ``"client"`` ⇒ execute the
    args as an OpenSeadragon command against the viewer; ``"server"`` ⇒ a data tool the
    gateway is running, just render its card.
    """

    tool_call_id: str
    name: str
    args: dict[str, Any] = field(default_factory=dict)
    tool_class: str = "server"
    type: ClassVar[str] = "tool_call_start"


@dataclass(frozen=True)
class ToolCallResult(AgentEvent):
    """A tool invocation resolved — the card flips to its outcome. `summary` is the text
    the model sees; `artifact` (when present) is a light handle to bulk output the browser
    fetches out-of-band (D4). The geometry itself is never in the event."""

    tool_call_id: str
    ok: bool = True
    summary: str = ""
    artifact: dict | None = None
    type: ClassVar[str] = "tool_call_result"


@dataclass(frozen=True)
class TextDelta(AgentEvent):
    """A chunk of the final narrative answer."""

    text: str = ""
    type: ClassVar[str] = "text_delta"


@dataclass(frozen=True)
class RunFinished(AgentEvent):
    """Turn converged — carries the assembled final answer for persistence."""

    text: str = ""
    type: ClassVar[str] = "run_finished"


@dataclass(frozen=True)
class RunError(AgentEvent):
    """Terminal failure or hard cancel — the transcript is left well-formed."""

    message: str = ""
    type: ClassVar[str] = "run_error"


__all__ = [
    "AgentEvent",
    "RunStarted",
    "ReasoningDelta",
    "ToolCallStart",
    "ToolCallResult",
    "TextDelta",
    "RunFinished",
    "RunError",
]
