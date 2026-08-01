"""The polling loop, against a doubled-out analysis service.

`httpx.MockTransport` rather than monkeypatched functions, so the tests exercise the real request
construction — a wrong path or a wrong method fails here rather than reaching a queue.
"""

import httpx
import pytest

from girder_pathassist.runner import (
    ServiceRefused,
    drive,
    read_status,
    request_cancel,
    submit,
)


def client_for(handler, base="http://svc"):
    return httpx.Client(transport=httpx.MockTransport(handler), base_url=base)


def json_response(status_code, payload):
    return httpx.Response(status_code, json=payload)


# ── submit ────────────────────────────────────────────────────────────────────────────


def test_submit_posts_to_the_route_the_service_serves():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["method"] = request.method
        return json_response(202, {"job_id": "j1", "seg_hash": "abc"})

    with client_for(handler) as c:
        assert submit(c, "segmentation", {"item": "i1"}) == "j1"
    assert seen == {"url": "http://svc/segment", "method": "POST"}


def test_nuclei_and_segmentation_do_not_share_a_route():
    """The route table is the only thing that differs between kinds; a mix-up must fail loudly."""
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return json_response(202, {"job_id": "j"})

    with client_for(handler) as c:
        submit(c, "segmentation", {})
        submit(c, "nuclei", {})
    assert seen == ["http://svc/segment", "http://svc/nuclei"]


def test_a_refusal_carries_the_services_own_words():
    def handler(request):
        return json_response(409, {"detail": "build this slide's feature index first"})

    with client_for(handler) as c, pytest.raises(ServiceRefused) as exc:
        submit(c, "features", {})
    assert "409" in str(exc.value)
    assert "feature index first" in str(exc.value)


def test_an_ack_without_a_job_id_is_a_refusal():
    """Accepting the request and returning nothing to poll is not success."""
    def handler(request):
        return json_response(202, {"seg_hash": "abc"})

    with client_for(handler) as c, pytest.raises(ServiceRefused):
        submit(c, "segmentation", {})


# ── read_status ───────────────────────────────────────────────────────────────────────


def test_status_path_differs_per_service_shape():
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return json_response(200, {"status": "running", "progress": 0.1})

    with client_for(handler) as c:
        read_status(c, "segmentation", "j1")
        read_status(c, "nuclei", "j1")
    assert seen == ["http://svc/status?job_id=j1", "http://svc/nuclei/status/j1"]


def test_a_forgotten_job_fails_with_a_nameable_cause():
    """A 404 is a restarted service. Polling it forever is the defect this increment removes."""
    def handler(request):
        return json_response(404, {"detail": "unknown job_id"})

    with client_for(handler) as c:
        s = read_status(c, "nuclei", "j1")
    assert s.state == "failed"
    assert s.terminal
    assert "restarted" in s.error


def test_a_server_error_is_raised_not_swallowed():
    """500 is transient; turning it into `failed` would kill a job over one bad reply."""
    def handler(request):
        return json_response(500, {"detail": "boom"})

    with client_for(handler) as c, pytest.raises(httpx.HTTPStatusError):
        read_status(c, "nuclei", "j1")


# ── cancel ────────────────────────────────────────────────────────────────────────────


def test_cancel_is_delivered_where_the_service_has_a_stop():
    seen = []

    def handler(request):
        seen.append((request.method, str(request.url)))
        return json_response(200, {"status": "running", "stage": "stopping"})

    with client_for(handler) as c:
        assert request_cancel(c, "nuclei", "j1") is True
    assert seen == [("POST", "http://svc/nuclei/cancel/j1")]


def test_cancel_is_refused_where_the_service_has_none():
    """False, and no request. Faking it would let the Runs list report a job that still holds the
    GPU as stopped."""
    def handler(request):  # pragma: no cover — must not be called
        raise AssertionError("no cancel route exists for this kind")

    with client_for(handler) as c:
        assert request_cancel(c, "segmentation", "j1") is False
        assert request_cancel(c, "biomarker", "j1") is False


# ── drive ─────────────────────────────────────────────────────────────────────────────


def scripted(replies, seen=None):
    """A service that answers submit once, then walks `replies` for each status poll."""
    state = {"i": 0}

    def handler(request):
        if seen is not None:
            seen.append((request.method, request.url.path))
        if request.method == "POST" and request.url.path in ("/segment", "/nuclei"):
            return json_response(202, {"job_id": "j1"})
        if request.method == "POST":  # a cancel
            return json_response(200, {})
        reply = replies[min(state["i"], len(replies) - 1)]
        state["i"] += 1
        return json_response(200, reply)

    return handler


def test_drive_polls_until_terminal_and_reports_every_reading():
    reports = []
    handler = scripted([
        {"status": "running", "stage": "tiles", "progress": 0.2},
        {"status": "running", "stage": "tiles", "progress": 0.8},
        {"status": "ready", "stage": "done", "progress": 1.0, "n_contours": 434},
    ])
    with client_for(handler) as c:
        final = drive(c, "segmentation", {}, report=lambda s, j: reports.append(s),
                      is_canceled=lambda: False, sleep=lambda _: None)

    assert final.state == "ready"
    assert final.result["n_contours"] == 434
    # The 'starting' report plus one per poll — the bar moves before the first status lands.
    assert [r.state for r in reports] == ["running", "running", "running", "ready"]
    assert [r.percent for r in reports] == [0, 20, 80, 100]


def test_a_revoked_job_is_asked_to_stop_exactly_once():
    seen = []
    handler = scripted([
        {"status": "running", "stage": "nuclei", "progress": 0.3},
        {"status": "running", "stage": "stopping", "progress": 0.3},
        {"status": "running", "stage": "stopping", "progress": 0.3},
        {"status": "cancelled", "stage": "stopped", "progress": 0.3,
         "result": {"n_nuclei": 3120}},
    ], seen)
    with client_for(handler) as c:
        final = drive(c, "nuclei", {}, report=lambda s, j: None,
                      is_canceled=lambda: True, sleep=lambda _: None)

    assert final.state == "cancelled"
    assert final.result["n_nuclei"] == 3120
    cancels = [p for m, p in seen if m == "POST" and "cancel" in p]
    assert cancels == ["/nuclei/cancel/j1"], "the stop is cooperative — ask once, then wait"


def test_a_revoked_job_on_a_service_without_a_stop_runs_to_completion():
    """Nothing is faked. The job finishes, and `runner` logs why it could not be stopped."""
    handler = scripted([
        {"status": "running", "progress": 0.5},
        {"status": "ready", "progress": 1.0, "seg_hash": "abc"},
    ])
    with client_for(handler) as c:
        final = drive(c, "segmentation", {}, report=lambda s, j: None,
                      is_canceled=lambda: True, sleep=lambda _: None)
    assert final.state == "ready"


def test_a_service_that_restarts_mid_run_ends_the_loop():
    state = {"n": 0}

    def handler(request):
        if request.method == "POST":
            return json_response(202, {"job_id": "j1"})
        state["n"] += 1
        if state["n"] == 1:
            return json_response(200, {"status": "running", "progress": 0.4})
        return json_response(404, {"detail": "unknown job_id"})

    with client_for(handler) as c:
        final = drive(c, "nuclei", {}, report=lambda s, j: None,
                      is_canceled=lambda: False, sleep=lambda _: None)
    assert final.state == "failed"
    assert "restarted" in final.error


# ── report_terminal ───────────────────────────────────────────────────────────────────


def test_the_gateway_hears_the_outcome_at_the_artifact_it_named():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["token"] = request.headers.get("Girder-Token")
        seen["body"] = request.read().decode()
        return json_response(200, {})

    transport = httpx.MockTransport(handler)
    # report_terminal builds its own client, so patch at the transport seam.
    import girder_pathassist.runner as runner

    real_post = httpx.post
    httpx.post = lambda url, **kw: httpx.Client(transport=transport).post(url, **kw)
    try:
        assert runner.report_terminal("http://gw/api", "tok", "item1", "hash1",
                                      _ready_status()) is True
    finally:
        httpx.post = real_post

    assert seen["url"] == "http://gw/api/slides/item1/artifacts/hash1/result"
    assert seen["token"] == "tok"
    assert '"status": "ready"' in seen["body"] or '"status":"ready"' in seen["body"]


def test_a_gateway_that_is_down_does_not_fail_the_run():
    """The bytes are on disk. Losing the row's result is recoverable; losing the run is not."""
    import girder_pathassist.runner as runner

    real_post = httpx.post

    def boom(url, **kw):
        raise httpx.ConnectError("gateway is down")

    httpx.post = boom
    try:
        assert runner.report_terminal("http://gw/api", "tok", "i", "h", _ready_status()) is False
    finally:
        httpx.post = real_post


def _ready_status():
    from girder_pathassist.status import normalise

    return normalise({"status": "ready", "progress": 1.0, "n_contours": 434},
                     nested_result=False)
