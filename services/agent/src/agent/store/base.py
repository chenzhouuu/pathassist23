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
  run          → {"id": int, "conversation_id": int, "plan_digest": str,
                  "status": str, "result": dict|None, "error": str|None,
                  "created_at": iso8601, "updated_at": iso8601}
                 status ∈ {RUNNING, DONE, FAILED}; produced artifacts are fetched
                 separately via get_artifact (kept off the run dict — they can be large)
  claim        → {"id": int, "conversation_id": int, "run_id": int, "plan_digest": str,
                  "subject": str, "predicate": str, "value": float|None, "unit": str,
                  "scope": dict, "metrics": dict, "evidence": list, "method_versions": dict,
                  "status": str, "created_at": iso8601}
                 the durable, evidence-bound result of a run; evidence entries are opaque
                 ArtifactRefs {"run_id": int, "key": str} for get_artifact
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

    # ── Runs (increment 5) ───────────────────────────────────────────────────────

    @abstractmethod
    async def create_run(self, *, conversation_id: int, plan_digest: str) -> dict:
        """Open a run (status RUNNING) for an approved plan; return it."""

    @abstractmethod
    async def finish_run(
        self, *, run_id: int, status: str, result: dict, artifacts: dict,
        error: str | None = None,
    ) -> dict | None:
        """Close a run: set its terminal `status`, scalar `result`, produced `artifacts`
        (stored for later fetch) and optional `error`. Return the updated run, or None if
        the run is unknown."""

    @abstractmethod
    async def get_artifact(
        self, *, conversation_id: int, run_id: int, key: str
    ) -> dict | None:
        """Return the named artifact of a run, iff the run belongs to `conversation_id`
        (owner scoping) and the key exists; else None."""

    # ── Claims (increment 6a) ────────────────────────────────────────────────────

    @abstractmethod
    async def create_claim(self, *, conversation_id: int, run_id: int, claim: dict) -> dict:
        """Persist a Claim (a run's durable, evidence-bound result) and return it with its
        id. `claim` is the dict produced by the deterministic claim builder."""

    @abstractmethod
    async def get_claims(self, *, conversation_id: int) -> list[dict]:
        """Return the conversation's claims in chronological order (for reload rehydration)."""
