import threading
import time

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
