"""A single-consumer in-process job queue (F7).

One daemon worker thread drains the queue so GPU work (Trident feature extraction) is serialized
against the coresident CellViT + MedGemma on the one A6000. Job status (stage/progress/error) is the
worker's transient view; the gateway mirrors it into the durable Postgres slide_index row.
"""

import logging
import queue
import threading
import uuid
from collections.abc import Callable
from typing import Any

from .gpu import release_cuda_cache

logger = logging.getLogger(__name__)

# A job is `fn(report)` where report(stage: str, progress: float) updates this job's status.
Reporter = Callable[[str, float], None]
JobFn = Callable[[Reporter], Any]


class JobQueue:
    """Serialized job execution with a thread-safe status registry."""

    def __init__(self) -> None:
        self._q: queue.Queue = queue.Queue()
        self._status: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._worker = threading.Thread(target=self._run, daemon=True, name="preprocess-worker")
        self._worker.start()

    def submit(self, fn: JobFn, job_id: str | None = None) -> str:
        job_id = job_id or uuid.uuid4().hex[:12]
        with self._lock:
            self._status[job_id] = {
                "job_id": job_id, "status": "queued", "stage": None,
                "progress": 0.0, "error": None, "result": None,
            }
        self._q.put((job_id, fn))
        return job_id

    def status(self, job_id: str) -> dict | None:
        with self._lock:
            s = self._status.get(job_id)
            return dict(s) if s else None

    def _set(self, job_id: str, **kw: Any) -> None:
        with self._lock:
            if job_id in self._status:
                self._status[job_id].update(kw)

    def _run(self) -> None:
        while True:
            job_id, fn = self._q.get()
            self._set(job_id, status="running", stage="starting", progress=0.0)

            def report(stage: str, progress: float, _jid: str = job_id) -> None:
                self._set(_jid, stage=stage, progress=float(progress))

            try:
                result = fn(report)
                self._set(job_id, status="ready", stage="done", progress=1.0, result=result)
            except Exception as exc:  # noqa: BLE001 — surface any failure as job state, never crash the worker
                logger.exception("preprocess job %s failed", job_id)
                self._set(job_id, status="failed", error=str(exc))
            finally:
                self._q.task_done()
                # Reclaim at the *job* boundary, not only inside the stage. A stage's own `finally`
                # runs while the exception is still unwinding, and the live traceback strongly
                # references every frame it passed through — including the one holding the patch
                # encoder — so the model still counts as allocated and empty_cache() frees nothing
                # (measured on an OOM'd run: reserved 2.35 → 2.35 GiB). Here the handler above has
                # finished and CPython has dropped its `as exc` binding, taking the frame chain with
                # it, so an OOM'd job actually gives the GPU back before the next one starts.
                release_cuda_cache()
