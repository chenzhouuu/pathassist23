"""ConversationStore — the control-plane persistence seam (PathAgent v2, increment 1).

Routes depend on this ABC, never on a concrete backend. `PgStore` (Postgres) is the
production implementation; tests inject an in-memory fake. This is where the
case-blackboard / memory logic grows at increment 6 — behind the same interface.

Return shapes are plain JSON-ready dicts so routes can hand them straight to the
client:
  conversation → {"id": int, "item_id": str|None, "title": str|None,
                  "created_at": iso8601, "updated_at": iso8601}
                 (list rows also carry "turn_count": int)
  turn         → {"id": int, "role": "user"|"assistant", "text": str,
                  "roi": dict|None, "created_at": iso8601}
  plan         → {"digest": str, "state": str, "steps": list, "scope": dict|None,
                  "envelope": dict|None, "reason": str|None, "turn_id": int|None,
                  "created_at": iso8601, "updated_at": iso8601}
                 state ∈ {AWAITING_APPROVAL, APPROVED, REJECTED, EXPIRED}
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

    # ── Plans (increment 4) ──────────────────────────────────────────────────────

    @abstractmethod
    async def create_plan(
        self, *, conversation_id: int, turn_id: int | None, digest: str,
        steps: list, scope: dict | None, envelope: dict | None, reason: str | None,
    ) -> dict:
        """Persist a plan (state AWAITING_APPROVAL), expiring any prior live plan of the
        conversation so exactly one plan is ever runnable. Return the new plan."""

    @abstractmethod
    async def get_plans(self, *, conversation_id: int) -> list[dict]:
        """Return the conversation's plans in chronological order."""

    @abstractmethod
    async def get_plan(self, *, conversation_id: int, digest: str) -> dict | None:
        """Return the plan with `digest` in the conversation, else None."""

    @abstractmethod
    async def set_plan_state(
        self, *, conversation_id: int, digest: str, state: str, expected: tuple[str, ...]
    ) -> dict | None:
        """Transition a plan's state iff its current state is in `expected`; return the
        updated plan, or None if it is not in an expected state (state conflict)."""
