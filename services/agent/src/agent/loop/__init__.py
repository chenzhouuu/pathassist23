"""The autonomous agent-loop subsystem (PathAgent v2, R7).

The Claude-Code-style in-turn loop that (from R10) replaces the plan→approve→run state
machine: one agent reasons, calls tools, and answers in a single streaming turn. R7
ships the framework on a stub loop behind a stable seam; the real Claude Agent SDK swaps
in at R10 without touching the route or the typed-event contract.
"""

import logging

from ..common.config import Settings
from .base import AgentLoop
from .sdk import SdkAgentLoop
from .stub import StubAgentLoop

logger = logging.getLogger(__name__)


def build_agent(settings: Settings) -> AgentLoop:
    """Pick the agent loop from config: the real Claude Agent SDK loop when a key is set,
    else the deterministic keyless stub — the same selection rule as the responder/planner.

    Construction is cheap either way; the SDK loop only spawns the `claude` subprocess when a
    turn runs, authenticating it from the configured key (D2 permission gate applies there).
    """
    if settings.anthropic_api_key:
        logger.info("agent loop: SDK (Claude Agent SDK, model=%s)", settings.anthropic_model)
        return SdkAgentLoop(
            api_key=settings.anthropic_api_key, model=settings.anthropic_model
        )
    logger.info("agent loop: stub (keyless)")
    return StubAgentLoop()


__all__ = ["AgentLoop", "SdkAgentLoop", "StubAgentLoop", "build_agent"]
