"""Postgres implementation of ConversationStore (PathAgent v2, increment 1).

Thin asyncpg layer — no ORM, no migration tool yet. The schema is created idempotently
on connect; a real migration tool (alembic) can slot in later without touching routes.
"""

import asyncio
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
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS turn_conversation_idx
    ON turn (conversation_id, id);
CREATE INDEX IF NOT EXISTS conversation_owner_idx
    ON conversation (girder_user, girder_item, updated_at DESC);
"""

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
                pool = await asyncpg.create_pool(dsn=dsn, min_size=1, max_size=10)
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
            "SELECT role, content, created_at FROM turn "
            "WHERE conversation_id = $1 ORDER BY id",
            conversation_id,
        )
        return [
            {"role": r["role"], "text": r["content"], "created_at": r["created_at"].isoformat()}
            for r in rows
        ]

    async def add_turn(self, *, conversation_id: int, role: str, content: str) -> None:
        async with self._pool.acquire() as conn, conn.transaction():
            await conn.execute(
                "INSERT INTO turn (conversation_id, role, content) VALUES ($1, $2, $3)",
                conversation_id,
                role,
                content,
            )
            await conn.execute(
                "UPDATE conversation SET updated_at = now() WHERE id = $1",
                conversation_id,
            )

    async def set_title_if_empty(self, *, conversation_id: int, title: str) -> None:
        await self._pool.execute(
            "UPDATE conversation SET title = $2 WHERE id = $1 AND title IS NULL",
            conversation_id,
            title,
        )

    async def delete_conversation(self, *, user: str, conversation_id: int) -> bool:
        # Turns cascade via the FK ON DELETE CASCADE.
        status = await self._pool.execute(
            "DELETE FROM conversation WHERE id = $1 AND girder_user = $2",
            conversation_id,
            user,
        )
        return status.rsplit(" ", 1)[-1] != "0"  # asyncpg returns e.g. "DELETE 1"
