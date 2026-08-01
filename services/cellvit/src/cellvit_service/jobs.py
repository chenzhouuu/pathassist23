"""A single-consumer in-process job queue — copied from ``tissue/jobs.py`` (Inc 5, ticket 05).

Third copy of this module, and knowingly so: the plan (R2) accepts the duplication for now and
defers extracting a shared package until there are three call sites to extract *from*. This is
that third one. Keep it a copy — a divergence here is a bug that will not reach the other two.

One daemon thread drains the queue so GPU work is serialised against the coresident tissue,
GigaTIME and Trident models on the one A6000. Job status here is the worker's transient view; the
gateway mirrors it into the durable ``preprocess_artifact`` row.

Cancellation is **cooperative**. A thread cannot be killed mid-tensor, and a whole-slide nuclei run
is hours of work holding the only worker, so the job itself is handed a way to notice it has been
asked to stop and picks a boundary where stopping is clean. What "clean" means is the job's
business (for nuclei it is the core-tile boundary, where coverage has just been persisted); what
this module guarantees is only that the request is delivered and that the outcome is reported as
``cancelled`` rather than ``ready``.
"""

import logging
import queue
import threading
import uuid
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

Emit = Callable[[str, float, "int | None", "int | None"], None]

# Terminal states: a cancel against one of these is a no-op, not an error (see JobQueue.cancel).
TERMINAL = frozenset({"ready", "failed", "cancelled"})


class Progress:
    """What a running job is handed: report where it is, and notice when it should stop.

    Callable with the same ``(stage, progress)`` signature the reporter always had, so a job that
    does not care about cancellation or about counts needs no changes at all.

    ``current`` and ``total`` are optional because not every stage has them: a job that walks core
    tiles knows it is on tile 142 of 338, while Trident's segmentation is one call over the whole
    slide and can only say "about a fifth of the way". Passing the counts where they exist is what
    lets a progress bar read ``142 / 338`` instead of ``42 %`` — the numbers were always being
    computed at the report site and thrown away one line later (Inc 6 · plan §3).
    """

    def __init__(self, emit: Emit, stop: threading.Event) -> None:
        self._emit = emit
        self._stop = stop

    def __call__(self, stage: str, progress: float,
                 current: int | None = None, total: int | None = None) -> None:
        self._emit(stage, progress, current, total)

    def stopping(self) -> bool:
        """True once someone has asked this job to stop."""
        return self._stop.is_set()


JobFn = Callable[[Progress], Any]


class JobQueue:
    """Serialized job execution with a thread-safe status registry."""

    def __init__(self, name: str = "cellvit-worker") -> None:
        self._q: queue.Queue = queue.Queue()
        self._status: dict[str, dict] = {}
        self._stops: dict[str, threading.Event] = {}
        self._lock = threading.Lock()
        self._worker = threading.Thread(target=self._run, daemon=True, name=name)
        self._worker.start()

    def submit(self, fn: JobFn, job_id: str | None = None) -> str:
        job_id = job_id or uuid.uuid4().hex[:12]
        with self._lock:
            self._status[job_id] = {
                "job_id": job_id, "status": "queued", "stage": None,
                "progress": 0.0, "error": None, "result": None,
                # Present from the start so /status has a stable shape; None until a stage that
                # actually counts something reports.
                "current": None, "total": None,
            }
            self._stops[job_id] = threading.Event()
        self._q.put((job_id, fn))
        return job_id

    def status(self, job_id: str) -> dict | None:
        with self._lock:
            s = self._status.get(job_id)
            return dict(s) if s else None

    def cancel(self, job_id: str) -> dict | None:
        """Ask a job to stop; returns its status, or None when the id is unknown.

        A job that has not started yet is dropped outright. A running one stays ``running`` with
        stage ``stopping`` until it reaches its own clean boundary — reporting it as stopped while
        it is still computing would be a lie the panel then shows to the user.

        Deliberately idempotent against an already-finished job: clicking Stop in the half-second
        after the last tile lands should not raise, it should just report that it is done.
        """
        with self._lock:
            s = self._status.get(job_id)
            if s is None:
                return None
            self._stops.setdefault(job_id, threading.Event()).set()
            if s["status"] == "queued":
                s.update(status="cancelled", stage="stopped")
            elif s["status"] == "running":
                s["stage"] = "stopping"
            return dict(s)

    def _set(self, job_id: str, **kw: Any) -> None:
        with self._lock:
            if job_id in self._status:
                self._status[job_id].update(kw)

    def _stop_event(self, job_id: str) -> threading.Event:
        with self._lock:
            return self._stops.setdefault(job_id, threading.Event())

    def join(self, timeout: float | None = None) -> None:
        """Block until the queue drains — tests only; the service never calls this."""
        self._q.join()

    def _run(self) -> None:
        while True:
            job_id, fn = self._q.get()
            stop = self._stop_event(job_id)
            if stop.is_set():                     # cancelled while it was still waiting its turn
                self._set(job_id, status="cancelled", stage="stopped")
                self._q.task_done()
                continue

            self._set(job_id, status="running", stage="starting", progress=0.0)

            def report(stage: str, progress: float, current: int | None = None,
                       total: int | None = None, _jid: str = job_id) -> None:
                # `current`/`total` are cleared when a stage does not carry them, so a bar can
                # never show one stage's denominator against the next stage's numerator.
                self._set(_jid, stage=stage, progress=float(progress),
                          current=current, total=total)

            try:
                result = fn(Progress(report, stop))
                if stop.is_set():
                    # The job stopped where it chose to, so whatever it produced is real and
                    # partial — keep it. Progress stays wherever the job left it: a stopped job
                    # reporting 100 % would misdescribe the map that is now on disk.
                    self._set(job_id, status="cancelled", stage="stopped", result=result)
                else:
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
