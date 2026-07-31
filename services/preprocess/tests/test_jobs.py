import gc
import logging
import threading
import time
import weakref

from preprocess_service import jobs
from preprocess_service.jobs import JobQueue


def _wait_until(pred, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.01)
    return False


def test_job_runs_to_ready_with_progress_and_result():
    q = JobQueue()

    def fn(report):
        report("segmentation", 0.5)
        report("features", 1.0)
        return {"n_patches": 7}

    jid = q.submit(fn)
    assert _wait_until(lambda: q.status(jid)["status"] == "ready")
    s = q.status(jid)
    assert s["progress"] == 1.0 and s["result"] == {"n_patches": 7} and s["error"] is None


def test_jobs_run_serially():
    q = JobQueue()
    release = threading.Event()
    started = threading.Event()

    def blocking(report):
        started.set()
        release.wait(timeout=3.0)
        return "a"

    def quick(report):
        return "b"

    jid_a = q.submit(blocking)
    jid_b = q.submit(quick)
    assert _wait_until(lambda: started.is_set())
    # single consumer: while A blocks, B must still be queued (not running)
    assert q.status(jid_a)["status"] == "running"
    assert q.status(jid_b)["status"] == "queued"
    release.set()
    assert _wait_until(lambda: q.status(jid_b)["status"] == "ready")


def test_raising_job_is_failed_with_message():
    q = JobQueue()

    def boom(report):
        raise RuntimeError("resolver exploded")

    jid = q.submit(boom)
    assert _wait_until(lambda: q.status(jid)["status"] == "failed")
    assert "resolver exploded" in q.status(jid)["error"]


def test_unknown_job_id_is_none():
    assert JobQueue().status("nope") is None


# ── GPU reclaim at the job boundary ─────────────────────────────────────────────────


def test_every_job_releases_the_gpu_cache(monkeypatch):
    """Both outcomes reclaim: a finished job must not leave the allocator pool squatted."""
    seen: list[str] = []
    monkeypatch.setattr(jobs, "release_cuda_cache", lambda: seen.append("released"))
    q = JobQueue()

    def ok(report):
        return "fine"

    def boom(report):
        raise RuntimeError("CUDA out of memory")

    jid_ok = q.submit(ok)
    assert _wait_until(lambda: q.status(jid_ok)["status"] == "ready")
    jid_bad = q.submit(boom)
    assert _wait_until(lambda: q.status(jid_bad)["status"] == "failed")
    assert _wait_until(lambda: len(seen) == 2)


def test_failed_job_frees_what_its_frames_held():
    """The reason the reclaim lives here and not in the stage's own ``finally``.

    While an exception unwinds, its traceback strongly references every frame it passed through —
    so a model allocated inside the failing call is still *live* when the stage's ``finally`` runs,
    and empty_cache() reclaims nothing. By the time the queue's handler is done the frame chain is
    gone. This asserts that property directly with a sentinel standing in for the patch encoder.
    """
    ref: list = []

    class FakeEncoder:
        """Stands in for the CUDA-resident encoder held by the failing frame."""

    def load_and_die(report):
        encoder = FakeEncoder()          # noqa: F841 — held by this frame's traceback on the way out
        ref.append(weakref.ref(encoder))
        raise RuntimeError("CUDA out of memory")

    # pytest's log capture keeps every LogRecord for the whole test — including the ``exc_info``
    # the queue logs on failure, whose traceback pins the very frames this test is about. Production
    # streams and drops those records; silence the capture so we measure the code, not the harness.
    logging.disable(logging.CRITICAL)
    try:
        q = JobQueue()
        jid = q.submit(load_and_die)
        assert _wait_until(lambda: q.status(jid)["status"] == "failed")
        # One more job, so the worker loop rebinds its locals past the failed one before we collect.
        jid2 = q.submit(lambda report: None)
        assert _wait_until(lambda: q.status(jid2)["status"] == "ready")
    finally:
        logging.disable(logging.NOTSET)

    gc.collect()
    assert ref[0]() is None, "the failed job's frame is still pinning its encoder"
