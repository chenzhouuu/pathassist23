"""The one job queue, and what a stop request actually promises (Inc 6 · 09).

There were four copies of this module and three of this suite. This is the one that is left,
and it lives beside the module rather than in any service, because a shared module tested from
one service's suite is a shared module whose owner is unclear.

A whole-slide run is hours of work holding the only worker thread, so "stop" has to be real —
but it also has to be honest: a job is not stopped when someone asks, it is stopped when it
gets to a boundary where stopping leaves the artifact intact.
"""

import threading

import pytest

from pathassist_jobs import JobQueue


@pytest.fixture
def jobs():
    return JobQueue(name="test-jobs")


def _wait(jobs, job_id, predicate, timeout=5.0):
    """Poll the job's status until `predicate` holds — threads make this the only honest wait."""
    deadline = threading.Event()
    timer = threading.Timer(timeout, deadline.set)
    timer.start()
    try:
        while not deadline.is_set():
            st = jobs.status(job_id)
            if st and predicate(st):
                return st
            deadline.wait(0.01)
        raise AssertionError(f"timed out; last status was {jobs.status(job_id)}")
    finally:
        timer.cancel()


def test_a_job_that_never_looks_still_finishes_normally(jobs):
    job_id = jobs.submit(lambda report: report("only", 0.5) or "done")
    st = _wait(jobs, job_id, lambda s: s["status"] == "ready")
    assert st["result"] == "done"
    assert st["progress"] == 1.0


def test_cancelling_a_running_job_leaves_it_running_until_it_stops_itself(jobs):
    started, release = threading.Event(), threading.Event()

    def work(report):
        started.set()
        while not report.stopping():
            release.wait(0.01)
        return {"partial": True}

    job_id = jobs.submit(work)
    started.wait(5)

    st = jobs.cancel(job_id)
    # Reporting it as stopped here would be a lie the panel then shows to the user.
    assert st["status"] == "running"
    assert st["stage"] == "stopping"

    st = _wait(jobs, job_id, lambda s: s["status"] == "cancelled")
    assert st["stage"] == "stopped"
    # Whatever it computed before stopping is real, so it is kept.
    assert st["result"] == {"partial": True}


def test_a_stopped_job_does_not_claim_to_be_complete(jobs):
    def work(report):
        report("tiles", 0.25)
        while not report.stopping():
            threading.Event().wait(0.01)
        return None

    job_id = jobs.submit(work)
    _wait(jobs, job_id, lambda s: s["progress"] == 0.25)
    jobs.cancel(job_id)
    st = _wait(jobs, job_id, lambda s: s["status"] == "cancelled")
    assert st["progress"] == 0.25


def test_a_job_cancelled_before_it_starts_never_runs(jobs):
    blocking, release = threading.Event(), threading.Event()
    jobs.submit(lambda _r: (blocking.set(), release.wait(5)))
    blocking.wait(5)

    ran = threading.Event()
    queued = jobs.submit(lambda _r: ran.set())
    assert jobs.cancel(queued)["status"] == "cancelled"

    release.set()
    _wait(jobs, queued, lambda s: s["status"] == "cancelled")
    assert not ran.is_set()


def test_cancelling_a_finished_job_reports_it_finished_rather_than_raising(jobs):
    """Clicking Stop in the half-second after the last tile lands must not produce an error."""
    job_id = jobs.submit(lambda _r: "done")
    _wait(jobs, job_id, lambda s: s["status"] == "ready")
    assert jobs.cancel(job_id)["status"] == "ready"


def test_cancelling_an_unknown_job_is_distinguishable_from_cancelling_a_known_one(jobs):
    assert jobs.cancel("nope") is None


def test_a_failure_is_still_a_failure_not_a_cancellation(jobs):
    def work(_report):
        raise ValueError("boom")

    job_id = jobs.submit(work)
    st = _wait(jobs, job_id, lambda s: s["status"] == "failed")
    assert "boom" in st["error"]
