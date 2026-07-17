import logging

from ..common.config import Settings
from .base import Responder
from .echo import EchoResponder

logger = logging.getLogger(__name__)


def build_responder(settings: Settings) -> Responder:
    """Pick the chat backend from config: Claude when a key is set, else echo."""
    if settings.anthropic_api_key:
        from .claude import ClaudeResponder

        logger.info("chat responder: Claude (%s)", settings.anthropic_model)
        return ClaudeResponder(
            api_key=settings.anthropic_api_key,
            model=settings.anthropic_model,
            max_tokens=settings.anthropic_max_tokens,
        )
    logger.warning("chat responder: echo (no AGENT_ANTHROPIC_API_KEY set)")
    return EchoResponder()


__all__ = ["Responder", "EchoResponder", "build_responder"]
