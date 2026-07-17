"""Responder — the chat-reply seam (PathAgent v2, increment 2).

The message route streams whatever a Responder yields; it never talks to a model
directly. `ClaudeResponder` is production; `EchoResponder` is the keyless fallback
and the deterministic test double. Swapping the model later (or adding tool-use at
increment 7+) means a new Responder behind this same interface — the SSE contract
and the route stay put.
"""

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator


class Responder(ABC):
    """Streams a reply, chunk by chunk, for a chat message history.

    `messages` is `[{"role": "user"|"assistant", "content": str}, ...]`, oldest
    first, ending with the user's newest turn.
    """

    @abstractmethod
    def stream_reply(self, *, messages: list[dict]) -> AsyncIterator[str]:
        """Return an async iterator of reply text chunks (implemented as a generator)."""
