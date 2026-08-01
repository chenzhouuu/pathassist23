"""Postgres implementation of ConversationStore (PathAgent v2).

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
CREATE INDEX IF NOT EXISTS turn_conversation_idx
    ON turn (conversation_id, id);
CREATE INDEX IF NOT EXISTS conversation_owner_idx
    ON conversation (girder_user, girder_item, updated_at DESC);
CREATE TABLE IF NOT EXISTS slide_index (
    id           BIGSERIAL PRIMARY KEY,
    girder_item  TEXT NOT NULL,
    params_hash  TEXT NOT NULL,
    encoder      TEXT NOT NULL,
    mag          INTEGER NOT NULL,
    patch_size   INTEGER NOT NULL,
    segmenter    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued',
    stage        TEXT,
    progress     REAL NOT NULL DEFAULT 0,
    job_id       TEXT,
    n_patches    INTEGER,
    feature_ref  TEXT,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (girder_item, params_hash)
);
CREATE INDEX IF NOT EXISTS slide_index_item_idx
    ON slide_index (girder_item, updated_at DESC);
CREATE TABLE IF NOT EXISTS preprocess_artifact (
    id           BIGSERIAL PRIMARY KEY,
    girder_item  TEXT NOT NULL,
    kind         TEXT NOT NULL,
    art_hash     TEXT NOT NULL,
    parent_hash  TEXT,
    params       JSONB NOT NULL DEFAULT '{}'::jsonb,
    status       TEXT NOT NULL DEFAULT 'queued',
    stage        TEXT,
    progress     REAL NOT NULL DEFAULT 0,
    job_id       TEXT,
    n_items      INTEGER,
    dim          INTEGER,
    artifact_ref TEXT,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (girder_item, art_hash)
);
CREATE INDEX IF NOT EXISTS preprocess_artifact_item_idx
    ON preprocess_artifact (girder_item, updated_at DESC);
-- Inc 2c: the 'prediction' kind carries an outcome, not just a pointer. `params` stays inputs-only;
-- this holds the summary (classes / probs / pred_index / n_patches / elapsed_ms) so the panel can
-- show the last call straight out of list_artifacts. Per-patch arrays never live here.
ALTER TABLE preprocess_artifact ADD COLUMN IF NOT EXISTS result JSONB;
-- Inc 6 · 05: which Girder job produced this row's bytes. Provenance, not control — it is written
-- when the run reports, points at a job that is already over, and is the link from an artifact to
-- the log of the work that made it. `job_id` above is the *service's* transient id and only means
-- anything for the kinds still on the pre-Inc-6 path.
ALTER TABLE preprocess_artifact ADD COLUMN IF NOT EXISTS girder_job_id TEXT;
"""


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

    @property
    def pool(self) -> asyncpg.Pool:
        """The shared asyncpg pool — reused by PgSlideIndexStore (same schema, one pool)."""
        return self._pool

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
        # Turns cascade via the FK ON DELETE CASCADE.
        status = await self._pool.execute(
            "DELETE FROM conversation WHERE id = $1 AND girder_user = $2",
            conversation_id,
            user,
        )
        return status.rsplit(" ", 1)[-1] != "0"  # asyncpg returns e.g. "DELETE 1"
