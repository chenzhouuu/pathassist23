"""A single-consumer in-process job queue — the same shape preprocess and biomarker use.

One daemon thread drains the queue so GPU work is serialised against the coresident CellViT,
GigaTIME and Trident models on the one A6000. Job status here is the worker's transient view; the
gateway mirrors it into the durable ``preprocess_artifacts`` row.
"""

import logging
import queue
import threading
import uuid
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

Reporter = Callable[[str, float], None]
JobFn = Callable[[Reporter], Any]


class JobQueue:
    """Serialized job execution with a thread-safe status registry."""

    def __init__(self, name: str = "tissue-worker") -> None:
        self._q: queue.Queue = queue.Queue()
        self._status: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._worker = threading.Thread(target=self._run, daemon=True, name=name)
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

    def join(self, timeout: float | None = None) -> None:
        """Block until the queue drains — tests only; the service never calls this."""
        self._q.join()

    def _run(self) -> None:
        while True:
            job_id, fn = self._q.get()
            self._set(job_id, status="running", stage="starting", progress=0.0)

            def report(stage: str, progress: float, _jid: str = job_id) -> None:
                self._set(_jid, stage=stage, progress=float(progress))

            try:
                result = fn(report)
                self._set(job_id, status="ready", stage="done", progress=1.0, result=result)
            except Exception as exc:  # noqa: BLE001 — a failure is job state, never a dead worker
                logger.exception("tissue job %s failed", job_id)
                self._set(job_id, status="failed", error=str(exc))
            finally:
                self._q.task_done()
                _release_cuda_cache()


def _release_cuda_cache() -> None:
    """Give the GPU back at the *job* boundary (mirrors preprocess.gpu / biomarker.jobs)."""
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001 — no torch (base image) or no GPU is not an error here
        pass
