"""PreprocessArtifactStore — the durable control-plane record for the preprocess DAG (Inc 2b-3).

One row per artifact (not per full index), discriminated by ``kind`` and linked by ``parent_hash``,
so the panel can reconstruct the segment → patch → features DAG and reuse shared upstream work:

    segmentation (parent=None) → patching (parent=seg_hash) → features (parent=patch_hash)
        → prediction (parent=feat_hash)

Arrays (contours.geojson / coords.h5 / features.h5) live in the preprocess service's content-
addressed artifact cache — never here; this table records *which* artifacts exist for a slide, with
which params, and their job status. Only the gateway writes it: it creates the row on trigger and
reconciles it against the worker's /status. Return dicts are JSON-ready for the panel:

  artifact → {"item_id": str, "kind": str, "art_hash": str, "parent_hash": str|None,
              "params": dict, "status": str, "stage": str|None, "progress": float,
              "job_id": str|None, "n_items": int|None, "dim": int|None,
              "artifact_ref": str|None, "result": dict|None, "error": str|None,
              "created_at": iso8601, "updated_at": iso8601}

Distinct from ``agent.loop.artifacts.ArtifactStore`` (that one holds a *turn's* bulk tool geometry).
"""

from abc import ABC, abstractmethod

import asyncpg

_COLS = (
    "girder_item, kind, art_hash, parent_hash, params, status, stage, progress, "
    "job_id, n_items, dim, artifact_ref, result, error, created_at, updated_at"
)


def _row(r: asyncpg.Record | None) -> dict | None:
    if r is None:
        return None
    return {
        "item_id": r["girder_item"], "kind": r["kind"], "art_hash": r["art_hash"],
        "parent_hash": r["parent_hash"], "params": r["params"], "status": r["status"],
        "stage": r["stage"], "progress": r["progress"], "job_id": r["job_id"],
        "n_items": r["n_items"], "dim": r["dim"], "artifact_ref": r["artifact_ref"],
        "result": r["result"], "error": r["error"], "created_at": r["created_at"].isoformat(),
        "updated_at": r["updated_at"].isoformat(),
    }


class PreprocessArtifactStore(ABC):
    """Persistence for preprocess DAG artifacts, keyed by (item, art_hash)."""

    @abstractmethod
    async def upsert_artifact(
        self, *, item: str, kind: str, art_hash: str, parent_hash: str | None,
        params: dict, status: str = "queued", job_id: str | None = None,
    ) -> dict:
        """Create the artifact row (or reset an existing one to a fresh build), return it."""

    @abstractmethod
    async def set_status(
        self, *, item: str, art_hash: str, status: str, stage: str | None = None,
        progress: float | None = None, n_items: int | None = None, dim: int | None = None,
        artifact_ref: str | None = None, result: dict | None = None, error: str | None = None,
    ) -> None:
        """Update a build's live state (from the worker's /status reconciliation)."""

    @abstractmethod
    async def get_artifact(self, *, item: str, art_hash: str) -> dict | None:
        """The artifact for (item, art_hash), or None."""

    @abstractmethod
    async def list_artifacts(self, *, item: str) -> list[dict]:
        """All artifacts for a slide (newest first)."""

    @abstractmethod
    async def delete_artifact(self, *, item: str, art_hash: str) -> bool:
        """Remove the row. True if there was one. The directory is the owning service's to remove.

        Deliberately dumb: refusing a delete because something was built on top of this is the
        gateway's call, made against the list it already has. The store does what it is told.
        """


class MemoryPreprocessArtifactStore(PreprocessArtifactStore):
    """In-process store for tests (mirrors PgPreprocessArtifactStore semantics)."""

    _TS = "2026-07-23T00:00:00+00:00"

    def __init__(self) -> None:
        self._rows: dict[tuple[str, str], dict] = {}
        self._seq = 0

    async def upsert_artifact(
        self, *, item, kind, art_hash, parent_hash, params, status="queued", job_id=None,
    ):
        self._seq += 1
        row = {
            "item_id": item, "kind": kind, "art_hash": art_hash, "parent_hash": parent_hash,
            "params": dict(params or {}), "status": status, "stage": None, "progress": 0.0,
            "job_id": job_id, "n_items": None, "dim": None, "artifact_ref": None,
            "result": None, "error": None,
            "created_at": self._TS, "updated_at": self._TS, "_seq": self._seq,
        }
        self._rows[(item, art_hash)] = row
        return self._public(row)

    async def set_status(
        self, *, item, art_hash, status, stage=None, progress=None, n_items=None,
        dim=None, artifact_ref=None, result=None, error=None,
    ):
        row = self._rows.get((item, art_hash))
        if row is None:
            return
        row["status"] = status
        if stage is not None:
            row["stage"] = stage
        if progress is not None:
            row["progress"] = float(progress)
        if n_items is not None:
            row["n_items"] = n_items
        if dim is not None:
            row["dim"] = dim
        if artifact_ref is not None:
            row["artifact_ref"] = artifact_ref
        if result is not None:
            row["result"] = dict(result)
        if error is not None:
            row["error"] = error

    async def get_artifact(self, *, item, art_hash):
        row = self._rows.get((item, art_hash))
        return self._public(row) if row else None

    async def list_artifacts(self, *, item):
        rows = [r for r in self._rows.values() if r["item_id"] == item]
        rows.sort(key=lambda r: r["_seq"], reverse=True)
        return [self._public(r) for r in rows]

    async def delete_artifact(self, *, item, art_hash):
        return self._rows.pop((item, art_hash), None) is not None

    @staticmethod
    def _public(row: dict) -> dict:
        return {k: v for k, v in row.items() if k != "_seq"}


class PgPreprocessArtifactStore(PreprocessArtifactStore):
    """PreprocessArtifactStore backed by the shared asyncpg pool (same schema as PgStore)."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def upsert_artifact(
        self, *, item, kind, art_hash, parent_hash, params, status="queued", job_id=None,
    ):
        row = await self._pool.fetchrow(
            f"""
            INSERT INTO preprocess_artifact
                (girder_item, kind, art_hash, parent_hash, params, status, job_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (girder_item, art_hash) DO UPDATE SET
                kind = EXCLUDED.kind, parent_hash = EXCLUDED.parent_hash,
                params = EXCLUDED.params, status = EXCLUDED.status, job_id = EXCLUDED.job_id,
                stage = NULL, progress = 0, n_items = NULL, dim = NULL, artifact_ref = NULL,
                result = NULL, error = NULL, updated_at = now()
            RETURNING {_COLS}
            """,
            item, kind, art_hash, parent_hash, dict(params or {}), status, job_id,
        )
        return _row(row)  # type: ignore[return-value]

    async def set_status(
        self, *, item, art_hash, status, stage=None, progress=None, n_items=None,
        dim=None, artifact_ref=None, result=None, error=None,
    ):
        await self._pool.execute(
            """
            UPDATE preprocess_artifact SET
                status = $3,
                stage = COALESCE($4, stage),
                progress = COALESCE($5, progress),
                n_items = COALESCE($6, n_items),
                dim = COALESCE($7, dim),
                artifact_ref = COALESCE($8, artifact_ref),
                result = COALESCE($9, result),
                error = COALESCE($10, error),
                updated_at = now()
            WHERE girder_item = $1 AND art_hash = $2
            """,
            item, art_hash, status, stage, progress, n_items, dim, artifact_ref,
            dict(result) if result is not None else None, error,
        )

    async def get_artifact(self, *, item, art_hash):
        row = await self._pool.fetchrow(
            f"SELECT {_COLS} FROM preprocess_artifact WHERE girder_item = $1 AND art_hash = $2",
            item, art_hash,
        )
        return _row(row)

    async def list_artifacts(self, *, item):
        rows = await self._pool.fetch(
            f"SELECT {_COLS} FROM preprocess_artifact WHERE girder_item = $1 "
            f"ORDER BY updated_at DESC, id DESC",
            item,
        )
        return [_row(r) for r in rows]  # type: ignore[misc]

    async def delete_artifact(self, *, item, art_hash):
        tag = await self._pool.execute(
            "DELETE FROM preprocess_artifact WHERE girder_item = $1 AND art_hash = $2",
            item, art_hash,
        )
        return tag.rsplit(" ", 1)[-1] != "0"
