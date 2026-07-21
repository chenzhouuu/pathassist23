"""ConversationStore — the control-plane persistence seam (PathAgent v2).

Routes depend on this ABC, never on a concrete backend. `PgStore` (Postgres) is the
production implementation; tests inject an in-memory fake.

The store persists exactly two things: conversations and their turns. The turns ARE the
conversation's memory (the transcript the autonomous loop replays each turn) — there is no
separate plan / claim / blackboard read-model.

Return shapes are plain JSON-ready dicts so routes can hand them straight to the client:
  conversation → {"id": int, "item_id": str|None, "title": str|None,
                  "created_at": iso8601, "updated_at": iso8601}
                 (list rows also carry "turn_count": int)
  turn         → {"id": int, "role": "user"|"assistant", "text": str,
                  "roi": dict|None, "created_at": iso8601}
"""

from abc import ABC, abstractmethod


class ConversationStore(ABC):
    """Persistence for conversations and their turns, scoped to a Girder user."""

    @abstractmethod
    async def create_conversation(
        self, *, user: str, item: str | None, title: str | None
    ) -> dict:
        """Create a conversation owned by `user`, optionally bound to a slide `item`."""

    @abstractmethod
    async def list_conversations(self, *, user: str, item: str | None) -> list[dict]:
        """Return the user's conversations (newest first). Filter by `item` when given."""

    @abstractmethod
    async def get_conversation(self, *, user: str, conversation_id: int) -> dict | None:
        """Return the conversation iff it exists and belongs to `user`, else None."""

    @abstractmethod
    async def get_turns(self, *, conversation_id: int) -> list[dict]:
        """Return the conversation's turns in chronological order."""

    @abstractmethod
    async def add_turn(
        self, *, conversation_id: int, role: str, content: str, roi: dict | None = None
    ) -> int:
        """Append a turn (optionally bound to an ROI), bump `updated_at`, return its id."""

    @abstractmethod
    async def set_title_if_empty(self, *, conversation_id: int, title: str) -> None:
        """Set the title only if it is currently unset (first-message auto-title)."""

    @abstractmethod
    async def delete_conversation(self, *, user: str, conversation_id: int) -> bool:
        """Delete a conversation (and its turns) iff owned by `user`; True if removed."""
