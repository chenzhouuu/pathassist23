"""ClaudeResponder — streams replies from Anthropic's Messages API."""

import logging
from collections.abc import AsyncIterator

import anthropic

from .base import Responder

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are PathAssist Copilot, a research assistant embedded in a whole-slide "
    "image (WSI) pathology viewer. You help pathologists and researchers reason "
    "about tissue morphology, staining, and analysis workflows.\n\n"
    "Ground rules:\n"
    "- Research use only. You are NOT a diagnostic device; never give a definitive "
    "clinical diagnosis. Frame observations as hypotheses and suggest how to confirm.\n"
    "- Be concise and precise; use correct histopathology terminology.\n"
    "- You cannot yet run image analysis on the slide (nuclei detection, "
    "quantification, ROI measurement) — those tools are coming in a later release. "
    "If asked to run analysis, say it isn't available yet and outline what you would do.\n"
    "- If you are unsure, say so rather than guessing."
)


class ClaudeResponder(Responder):
    def __init__(self, *, api_key: str, model: str, max_tokens: int) -> None:
        self._client = anthropic.AsyncAnthropic(api_key=api_key)
        self._model = model
        self._max_tokens = max_tokens

    async def stream_reply(self, *, messages: list[dict]) -> AsyncIterator[str]:
        async with self._client.messages.stream(
            model=self._model,
            max_tokens=self._max_tokens,
            system=SYSTEM_PROMPT,
            messages=messages,
        ) as stream:
            async for text in stream.text_stream:
                yield text
