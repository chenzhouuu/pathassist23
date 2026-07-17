"""EchoResponder — keyless fallback / deterministic test double.

Streams the last user message back word-by-word, preserving the increment 0/1
behaviour so the copilot keeps working (and tests stay hermetic) without Anthropic.
"""

import asyncio
from collections.abc import AsyncIterator

from .base import Responder


class EchoResponder(Responder):
    async def stream_reply(self, *, messages: list[dict]) -> AsyncIterator[str]:
        last = messages[-1]["content"] if messages else ""
        for word in last.split():
            await asyncio.sleep(0.04)
            yield f"{word} "
