"""Postgres implementation of ConversationStore (PathAgent v2, increment 1).

Thin asyncpg layer — no ORM, no migration tool yet. The schema is created idempotently
on connect; a real migration tool (alembic) can slot in later without touching routes.
"""

import asyncio
import json
import logging

import asyncpg

from .base import ConversationStore

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversation (
    id           BIGSERIAL PRIMARY KEY,
    girder_user  TEXT NOT NULL,
    girder_item  TEXT,
    title        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS turn (
    id              BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    roi             JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE turn ADD COLUMN IF NOT EXISTS roi JSONB;
CREATE TABLE IF NOT EXISTS plan (
    id              BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    turn_id         BIGINT REFERENCES turn(id) ON DELETE SET NULL,
    digest          TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'AWAITING_APPROVAL',
    steps           JSONB NOT NULL,
    scope           JSONB,
    envelope        JSONB,
    reason          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS run (
    id              BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    plan_digest     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'RUNNING',
    result          JSONB,
    artifacts       JSONB NOT NULL DEFAULT '{}'::jsonb,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS turn_conversation_idx
    ON turn (conversation_id, id);
CREATE INDEX IF NOT EXISTS conversation_owner_idx
    ON conversation (girder_user, girder_item, updated_at DESC);
CREATE INDEX IF NOT EXISTS plan_conversation_idx
    ON plan (conversation_id, id);
CREATE INDEX IF NOT EXISTS plan_digest_idx
    ON plan (conversation_id, digest);
CREATE INDEX IF NOT EXISTS run_conversation_idx
    ON run (conversation_id, id);
"""

_PLAN_COLS = "digest, state, steps, scope, envelope, reason, turn_id, created_at, updated_at"
_RUN_COLS = "id, conversation_id, plan_digest, status, result, error, created_at, updated_at"


def _run(row: asyncpg.Record | None) -> dict | None:
    if row is None:
        return None
    return {
        "id": row["id"],
        "conversation_id": row["conversation_id"],
        "plan_digest": row["plan_digest"],
        "status": row["status"],
        "result": row["result"],
        "error": row["error"],
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
    }


def _plan(row: asyncpg.Record | None) -> dict | None:
    if row is None:
        return None
    return {
        "digest": row["digest"],
        "state": row["state"],
        "steps": row["steps"],
        "scope": row["scope"],
        "envelope": row["envelope"],
        "reason": row["reason"],
        "turn_id": row["turn_id"],
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
    }


async def _init_conn(conn: asyncpg.Connection) -> None:
    """Decode JSONB columns to/from Python objects (asyncpg returns raw text by default)."""
    await conn.set_type_codec(
        "jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
    )

_CONV_COLS = "id, girder_item, title, created_at, updated_at"


def _conv(row: asyncpg.Record | None) -> dict | None:
    if row is None:
        return None
    out = {
        "id": row["id"],
        "item_id": row["girder_item"],
        "title": row["title"],
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
    }
    if "turn_count" in row.keys():
        out["turn_count"] = row["turn_count"]
    return out


class PgStore(ConversationStore):
    """ConversationStore backed by a shared asyncpg connection pool."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    @classmethod
    async def connect(cls, dsn: str, *, retries: int = 10, delay: float = 1.0) -> "PgStore":
        """Open a pool (retrying while Postgres finishes booting) and ensure the schema."""
        last_exc: Exception | None = None
        for attempt in range(1, retries + 1):
            try:
                pool = await asyncpg.create_pool(
                    dsn=dsn, min_size=1, max_size=10, init=_init_conn
                )
                break
            except (OSError, asyncpg.PostgresError) as exc:
                last_exc = exc
                logger.warning("Postgres not ready (attempt %d/%d): %s", attempt, retries, exc)
                await asyncio.sleep(delay)
        else:
            raise RuntimeError("could not connect to Postgres") from last_exc

        async with pool.acquire() as conn:
            await conn.execute(_SCHEMA)
        logger.info("copilot Postgres store ready")
        return cls(pool)

    async def close(self) -> None:
        await self._pool.close()

    async def create_conversation(
        self, *, user: str, item: str | None, title: str | None
    ) -> dict:
        row = await self._pool.fetchrow(
            f"INSERT INTO conversation (girder_user, girder_item, title) "
            f"VALUES ($1, $2, $3) RETURNING {_CONV_COLS}",
            user,
            item,
            title,
        )
        return _conv(row)  # type: ignore[return-value]

    async def list_conversations(self, *, user: str, item: str | None) -> list[dict]:
        select = (
            "SELECT c.id, c.girder_item, c.title, c.created_at, c.updated_at, "
            "COUNT(t.id) AS turn_count "
            "FROM conversation c LEFT JOIN turn t ON t.conversation_id = c.id "
        )
        tail = "GROUP BY c.id ORDER BY c.updated_at DESC"
        if item is None:
            rows = await self._pool.fetch(
                f"{select} WHERE c.girder_user = $1 {tail}", user
            )
        else:
            rows = await self._pool.fetch(
                f"{select} WHERE c.girder_user = $1 AND c.girder_item = $2 {tail}", user, item
            )
        return [_conv(r) for r in rows]  # type: ignore[misc]

    async def get_conversation(self, *, user: str, conversation_id: int) -> dict | None:
        row = await self._pool.fetchrow(
            f"SELECT {_CONV_COLS} FROM conversation WHERE id = $1 AND girder_user = $2",
            conversation_id,
            user,
        )
        return _conv(row)

    async def get_turns(self, *, conversation_id: int) -> list[dict]:
        rows = await self._pool.fetch(
            "SELECT id, role, content, roi, created_at FROM turn "
            "WHERE conversation_id = $1 ORDER BY id",
            conversation_id,
        )
        return [
            {
                "id": r["id"],
                "role": r["role"],
                "text": r["content"],
                "roi": r["roi"],
                "created_at": r["created_at"].isoformat(),
            }
            for r in rows
        ]

    async def add_turn(
        self, *, conversation_id: int, role: str, content: str, roi: dict | None = None
    ) -> int:
        async with self._pool.acquire() as conn, conn.transaction():
            turn_id = await conn.fetchval(
                "INSERT INTO turn (conversation_id, role, content, roi) "
                "VALUES ($1, $2, $3, $4) RETURNING id",
                conversation_id,
                role,
                content,
                roi,
            )
            await conn.execute(
                "UPDATE conversation SET updated_at = now() WHERE id = $1",
                conversation_id,
            )
        return turn_id

    async def set_title_if_empty(self, *, conversation_id: int, title: str) -> None:
        await self._pool.execute(
            "UPDATE conversation SET title = $2 WHERE id = $1 AND title IS NULL",
            conversation_id,
            title,
        )

    async def delete_conversation(self, *, user: str, conversation_id: int) -> bool:
        # Turns and plans cascade via the FK ON DELETE CASCADE.
        status = await self._pool.execute(
            "DELETE FROM conversation WHERE id = $1 AND girder_user = $2",
            conversation_id,
            user,
        )
        return status.rsplit(" ", 1)[-1] != "0"  # asyncpg returns e.g. "DELETE 1"

    async def create_plan(
        self, *, conversation_id: int, turn_id: int | None, digest: str,
        steps: list, scope: dict | None, envelope: dict | None, reason: str | None,
    ) -> dict:
        async with self._pool.acquire() as conn, conn.transaction():
            # Exactly one live plan per conversation: expire any prior one first.
            await conn.execute(
                "UPDATE plan SET state = 'EXPIRED', updated_at = now() "
                "WHERE conversation_id = $1 AND state IN ('AWAITING_APPROVAL', 'APPROVED')",
                conversation_id,
            )
            row = await conn.fetchrow(
                "INSERT INTO plan "
                "(conversation_id, turn_id, digest, state, steps, scope, envelope, reason) "
                f"VALUES ($1, $2, $3, 'AWAITING_APPROVAL', $4, $5, $6, $7) RETURNING {_PLAN_COLS}",
                conversation_id, turn_id, digest, steps, scope, envelope, reason,
            )
        return _plan(row)  # type: ignore[return-value]

    async def get_plans(self, *, conversation_id: int) -> list[dict]:
        rows = await self._pool.fetch(
            f"SELECT {_PLAN_COLS} FROM plan WHERE conversation_id = $1 ORDER BY id",
            conversation_id,
        )
        return [_plan(r) for r in rows]  # type: ignore[misc]

    async def get_plan(self, *, conversation_id: int, digest: str) -> dict | None:
        row = await self._pool.fetchrow(
            f"SELECT {_PLAN_COLS} FROM plan WHERE conversation_id = $1 AND digest = $2 "
            "ORDER BY id DESC LIMIT 1",
            conversation_id,
            digest,
        )
        return _plan(row)

    async def set_plan_state(
        self, *, conversation_id: int, digest: str, state: str, expected: tuple[str, ...]
    ) -> dict | None:
        # Updates only when the current state is one of `expected` → None means either
        # the plan is absent or in a conflicting state (the route disambiguates with 404).
        row = await self._pool.fetchrow(
            f"UPDATE plan SET state = $3, updated_at = now() "
            f"WHERE conversation_id = $1 AND digest = $2 AND state = ANY($4::text[]) "
            f"RETURNING {_PLAN_COLS}",
            conversation_id,
            digest,
            state,
            list(expected),
        )
        return _plan(row)

    async def create_run(self, *, conversation_id: int, plan_digest: str) -> dict:
        row = await self._pool.fetchrow(
            f"INSERT INTO run (conversation_id, plan_digest) VALUES ($1, $2) "
            f"RETURNING {_RUN_COLS}",
            conversation_id,
            plan_digest,
        )
        return _run(row)  # type: ignore[return-value]

    async def finish_run(
        self, *, run_id: int, status: str, result: dict, artifacts: dict,
        error: str | None = None,
    ) -> dict | None:
        row = await self._pool.fetchrow(
            f"UPDATE run SET status = $2, result = $3, artifacts = $4, error = $5, "
            f"updated_at = now() WHERE id = $1 RETURNING {_RUN_COLS}",
            run_id,
            status,
            result,
            artifacts,
            error,
        )
        return _run(row)

    async def get_artifact(
        self, *, conversation_id: int, run_id: int, key: str
    ) -> dict | None:
        # Owner scoping: the run must belong to this conversation (which the route has
        # already verified the caller owns).
        artifacts = await self._pool.fetchval(
            "SELECT artifacts FROM run WHERE id = $1 AND conversation_id = $2",
            run_id,
            conversation_id,
        )
        if not artifacts:
            return None
        return artifacts.get(key)
