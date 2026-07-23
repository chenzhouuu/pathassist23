"""SlideIndexStore — the durable control-plane record for Trident preprocess indexes (Inc 2b).

Kept separate from ConversationStore (and its in-memory test double) so the conversation ABC stays
untouched (review F4). Arrays (features/coords/contours) live in the preprocess service's artifact
cache — never here; this table records *which* index exists for a slide, with which params, and its
job status. Only the gateway writes it (F7): it creates the row on trigger and reconciles it against
the worker's /status. Return dicts are JSON-ready for the panel / find_regions:

  index → {"item_id": str, "params_hash": str, "encoder": str, "mag": int, "patch_size": int,
           "segmenter": str, "status": str, "stage": str|None, "progress": float,
           "job_id": str|None, "n_patches": int|None, "feature_ref": str|None, "error": str|None,
           "created_at": iso8601, "updated_at": iso8601}
"""

from abc import ABC, abstractmethod

import asyncpg

_COLS = (
    "girder_item, params_hash, encoder, mag, patch_size, segmenter, status, stage, "
    "progress, job_id, n_patches, feature_ref, error, created_at, updated_at"
)


def _row(r: asyncpg.Record | None) -> dict | None:
    if r is None:
        return None
    return {
        "item_id": r["girder_item"], "params_hash": r["params_hash"], "encoder": r["encoder"],
        "mag": r["mag"], "patch_size": r["patch_size"], "segmenter": r["segmenter"],
        "status": r["status"], "stage": r["stage"], "progress": r["progress"],
        "job_id": r["job_id"], "n_patches": r["n_patches"], "feature_ref": r["feature_ref"],
        "error": r["error"], "created_at": r["created_at"].isoformat(),
        "updated_at": r["updated_at"].isoformat(),
    }


class SlideIndexStore(ABC):
    """Persistence for slide preprocess-index records, keyed by (item, params_hash)."""

    @abstractmethod
    async def upsert_index(
        self, *, item: str, params_hash: str, encoder: str, mag: int, patch_size: int,
        segmenter: str, status: str = "queued", job_id: str | None = None,
    ) -> dict:
        """Create the index row (or reset an existing one to a fresh build), return it."""

    @abstractmethod
    async def set_status(
        self, *, item: str, params_hash: str, status: str, stage: str | None = None,
        progress: float | None = None, n_patches: int | None = None,
        feature_ref: str | None = None, error: str | None = None,
    ) -> None:
        """Update a build's live state (from the worker's /status reconciliation)."""

    @abstractmethod
    async def get_index(self, *, item: str, params_hash: str) -> dict | None:
        """The index for (item, params_hash), or None."""

    @abstractmethod
    async def list_indexes(self, *, item: str) -> list[dict]:
        """All indexes for a slide (newest first)."""


class MemorySlideIndexStore(SlideIndexStore):
    """In-process SlideIndexStore for tests (mirrors PgSlideIndexStore semantics)."""

    _TS = "2026-07-23T00:00:00+00:00"

    def __init__(self) -> None:
        self._rows: dict[tuple[str, str], dict] = {}
        self._seq = 0

    async def upsert_index(
        self, *, item, params_hash, encoder, mag, patch_size, segmenter,
        status="queued", job_id=None,
    ):
        self._seq += 1
        row = {
            "item_id": item, "params_hash": params_hash, "encoder": encoder, "mag": mag,
            "patch_size": patch_size, "segmenter": segmenter, "status": status, "stage": None,
            "progress": 0.0, "job_id": job_id, "n_patches": None, "feature_ref": None,
            "error": None, "created_at": self._TS, "updated_at": self._TS, "_seq": self._seq,
        }
        self._rows[(item, params_hash)] = row
        return self._public(row)

    async def set_status(
        self, *, item, params_hash, status, stage=None, progress=None,
        n_patches=None, feature_ref=None, error=None,
    ):
        row = self._rows.get((item, params_hash))
        if row is None:
            return
        row["status"] = status
        if stage is not None:
            row["stage"] = stage
        if progress is not None:
            row["progress"] = float(progress)
        if n_patches is not None:
            row["n_patches"] = n_patches
        if feature_ref is not None:
            row["feature_ref"] = feature_ref
        if error is not None:
            row["error"] = error

    async def get_index(self, *, item, params_hash):
        row = self._rows.get((item, params_hash))
        return self._public(row) if row else None

    async def list_indexes(self, *, item):
        rows = [r for r in self._rows.values() if r["item_id"] == item]
        rows.sort(key=lambda r: r["_seq"], reverse=True)
        return [self._public(r) for r in rows]

    @staticmethod
    def _public(row: dict) -> dict:
        return {k: v for k, v in row.items() if k != "_seq"}


class PgSlideIndexStore(SlideIndexStore):
    """SlideIndexStore backed by the shared asyncpg pool (same schema as PgStore)."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def upsert_index(
        self, *, item, params_hash, encoder, mag, patch_size, segmenter,
        status="queued", job_id=None,
    ):
        row = await self._pool.fetchrow(
            f"""
            INSERT INTO slide_index
                (girder_item, params_hash, encoder, mag, patch_size, segmenter, status, job_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (girder_item, params_hash) DO UPDATE SET
                encoder = EXCLUDED.encoder, mag = EXCLUDED.mag,
                patch_size = EXCLUDED.patch_size, segmenter = EXCLUDED.segmenter,
                status = EXCLUDED.status, job_id = EXCLUDED.job_id,
                stage = NULL, progress = 0, n_patches = NULL, feature_ref = NULL,
                error = NULL, updated_at = now()
            RETURNING {_COLS}
            """,
            item, params_hash, encoder, mag, patch_size, segmenter, status, job_id,
        )
        return _row(row)  # type: ignore[return-value]

    async def set_status(
        self, *, item, params_hash, status, stage=None, progress=None,
        n_patches=None, feature_ref=None, error=None,
    ):
        await self._pool.execute(
            """
            UPDATE slide_index SET
                status = $3,
                stage = COALESCE($4, stage),
                progress = COALESCE($5, progress),
                n_patches = COALESCE($6, n_patches),
                feature_ref = COALESCE($7, feature_ref),
                error = COALESCE($8, error),
                updated_at = now()
            WHERE girder_item = $1 AND params_hash = $2
            """,
            item, params_hash, status, stage, progress, n_patches, feature_ref, error,
        )

    async def get_index(self, *, item, params_hash):
        row = await self._pool.fetchrow(
            f"SELECT {_COLS} FROM slide_index WHERE girder_item = $1 AND params_hash = $2",
            item, params_hash,
        )
        return _row(row)

    async def list_indexes(self, *, item):
        rows = await self._pool.fetch(
            f"SELECT {_COLS} FROM slide_index WHERE girder_item = $1 ORDER BY updated_at DESC",
            item,
        )
        return [_row(r) for r in rows]  # type: ignore[misc]
