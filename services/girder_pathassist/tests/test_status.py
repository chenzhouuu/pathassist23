"""Normalising what the services actually send.

The two payload shapes here are not hypothetical: the preprocess service merges its result into the
top level and the JobQueue workers nest it under "result" (`routing.Route.nested_result`), and both
are exercised below against the fields those services really emit.
"""

from girder_pathassist.status import (
    normalise,
    progress_message,
)


def test_preprocess_shape_lifts_the_result_off_the_top_level():
    payload = {
        "job_id": "abc", "status": "ready", "stage": "done", "progress": 1.0,
        "n_contours": 434, "contours_ref": "seg/xyz", "seg_hash": "deadbeef",
    }
    s = normalise(payload, nested_result=False)
    assert s.state == "ready"
    assert s.terminal
    assert s.result == {"n_contours": 434, "contours_ref": "seg/xyz", "seg_hash": "deadbeef"}
    assert s.percent == 100


def test_jobqueue_shape_reads_the_nested_result():
    payload = {
        "job_id": "abc", "status": "ready", "stage": "done", "progress": 1.0,
        "result": {"n_nuclei": 10790, "n_core_tiles": 26},
    }
    s = normalise(payload, nested_result=True)
    assert s.result == {"n_nuclei": 10790, "n_core_tiles": 26}


def test_counts_win_over_the_fraction():
    """A service that reports both gets believed about the counts.

    They can disagree — a fraction rounded at the source and a count read a moment later — and
    `142 / 338` next to `50%` on the same row is worse than either number alone.
    """
    s = normalise(
        {"status": "running", "stage": "nuclei", "progress": 0.5, "current": 142, "total": 338},
        nested_result=True,
    )
    assert (s.current, s.total) == (142, 338)
    assert s.percent == 42


def test_a_fraction_alone_still_drives_the_bar():
    s = normalise({"status": "running", "stage": "encoding", "progress": 0.37},
                  nested_result=False)
    assert (s.current, s.total) == (None, None)
    assert s.percent == 37


def test_counts_are_found_inside_the_result_too():
    """Where a service puts its counts is the service's business, not the driver's."""
    s = normalise(
        {"status": "running", "stage": "tiles", "result": {"current": 7, "total": 26}},
        nested_result=True,
    )
    assert (s.current, s.total) == (7, 26)


def test_a_stopped_run_keeps_its_tallies():
    """`cancelled` is terminal and carries a result, because a stopped run left bytes on disk."""
    s = normalise(
        {"status": "cancelled", "stage": "stopped", "progress": 0.31,
         "result": {"n_nuclei": 3120, "n_core_tiles": 8}},
        nested_result=True,
    )
    assert s.terminal
    assert s.result["n_nuclei"] == 3120
    assert s.percent == 31


def test_nonsense_counts_are_not_counts():
    s = normalise({"status": "running", "current": "many", "total": -3, "progress": 0.2},
                  nested_result=True)
    assert (s.current, s.total) == (None, None)
    assert s.percent == 20


def test_percent_is_clamped():
    assert normalise({"status": "running", "progress": 1.4}, nested_result=True).percent == 100
    assert normalise({"status": "running", "progress": -1}, nested_result=True).percent == 0


def test_an_empty_payload_is_queued_not_a_crash():
    s = normalise({}, nested_result=False)
    assert (s.state, s.percent, s.terminal) == ("queued", 0, False)


def test_the_message_never_invents_a_denominator():
    """`142 / ?` reads as a bug and `142 / 142` would be a lie."""
    with_total = normalise({"status": "running", "stage": "nuclei",
                            "current": 142, "total": 338}, nested_result=True)
    assert progress_message(with_total) == "142 / 338 · nuclei"

    no_total = normalise({"status": "running", "stage": "nuclei", "current": 142},
                         nested_result=True)
    assert progress_message(no_total) == "142 · nuclei"

    neither = normalise({"status": "running", "stage": "nuclei"}, nested_result=True)
    assert progress_message(neither) == "nuclei"


def test_the_message_falls_back_to_the_state_when_there_is_no_stage():
    assert progress_message(normalise({"status": "queued"}, nested_result=True)) == "queued"
