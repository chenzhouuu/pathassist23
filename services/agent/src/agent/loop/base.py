"""AgentLoop — the in-turn autonomous-loop seam (PathAgent v2, R7).

The turn route streams whatever an AgentLoop yields; it never talks to a model or the
SDK directly. `StubAgentLoop` is the keyless framework-on-a-stub (one trivial tool);
`SdkAgentLoop` drives the real Claude Agent SDK behind this identical interface — the
typed-event contract and the route stay put. Selection is by key (see `build_agent`).
"""

from abc import ABC, abstractmethod
from asyncio import Event
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

from .events import AgentEvent

if TYPE_CHECKING:
    from .tools import ToolContext


class AgentLoop(ABC):
    """Runs one user turn as an autonomous observe→think→act loop of typed events."""

    @abstractmethod
    def run(
        self,
        *,
        text: str,
        history: list[dict],
        scope: dict,
        viewer: dict | None = None,
        ctx: "ToolContext | None" = None,
        abort: Event | None = None,
    ) -> AsyncIterator[AgentEvent]:
        """Async-iterate the turn's typed events (implemented as a generator).

        `scope` is the spatial scope ``{item_id, roi?}``; `viewer` is the current viewport
        snapshot in level-0 pixels, injected so the loop can ground a client-side viewer
        tool on where the user is actually looking (D8). `ctx` is the server-tool execution
        context (owner, conversation, artifact store — D4); without it, server tools
        degrade to summary-only.

        `abort`, when set, ends the loop cleanly with a terminal event — an in-flight tool
        first receives a synthetic error result so the transcript stays well-formed
        (Claude Code's hard-cancel pattern).
        """
