"""Dispatching a run onto Celery instead of calling the service (Inc 6 · ticket 01).

The two halves of the new path, from the gateway's side: `start_segment` naming the artifact and
handing it to the Girder plugin, and the driver reporting back how it ended.

The old direct-to-service path is not deleted and is covered in `test_dag_routes.py`; which one
runs is decided by whether `pathassist_plugin_url` is configured, and both are exercised.
"""

import httpx
import pytest
from starlette.testclient import TestClient

from agent.gateway import routes as routes_mod
from agent.gateway.app import create_app
from agent.gateway.auth import require_user
from agent.gateway.routes import (
    get_plugin_url,
    get_preprocess_artifact_store,
    get_preprocess_url,
)
from agent.loop.pathassist_dispatch import DispatchUnavailable, dispatch_run
from agent.store import MemoryPreprocessArtifactStore

_USER = {"_id": "u1", "login": "tester"}
_BASE = "/api/copilot/slides"
_ITEM = "6a6e1ca82ae96ce927e33818"  # the DEMO slide


@pytest.fixture
def art_store():
    return MemoryPreprocessArtifactStore()


@pytest.fixture
def client(art_store):
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_preprocess_url] = lambda: "http://preprocess:8030"
    app.dependency_overrides[get_plugin_url] = lambda: "http://girder:8080/api/v1"
    return TestClient(app)


def _address(art_hash="seg-abc", **params):
    """A /hash double: the service naming what a run with these params would produce."""
    async def addressed(preprocess_url, kind, item, p):
        return {"kind": kind, "art_hash": art_hash,
                "params": {"segmenter": "hest", "seg_conf_thresh": 0.5,
                           "remove_artifacts": False, "remove_holes": False,
                           "remove_penmarks": False, **params}}
    return addressed


def _dispatch(job_id="girder-job-1", seen=None):
    async def dispatch(*, plugin_url, kind, item, art_hash, params, token, **kw):
        if seen is not None:
            seen.append({"kind": kind, "item": item, "art_hash": art_hash, "params": params})
        return {"jobId": job_id, "celeryTaskId": "t1", "kind": kind,
                "item": item, "artHash": art_hash, "queue": "pathassist"}
    return dispatch


# ── start_segment, dispatching ────────────────────────────────────────────────────────


def test_the_row_carries_the_girder_job_not_the_services_own(client, art_store, monkeypatch):
    """`job_id` changes meaning under Inc 6: it is the Girder job, which is what Runs reads."""
    monkeypatch.setattr(routes_mod, "_content_address", _address())
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch("girder-job-1"))

    r = client.post(f"{_BASE}/{_ITEM}/segment", json={})
    assert r.status_code == 200
    assert r.json()["job_id"] == "girder-job-1"

    rows = client.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"]
    assert [(x["kind"], x["art_hash"], x["job_id"]) for x in rows] == [
        ("segmentation", "seg-abc", "girder-job-1")
    ]


def test_the_artifact_is_named_before_it_is_dispatched(client, monkeypatch):
    """The address goes to the plugin, so the driver can report against it later."""
    seen = []
    monkeypatch.setattr(routes_mod, "_content_address", _address("seg-xyz"))
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch(seen=seen))

    client.post(f"{_BASE}/{_ITEM}/segment", json={"segmenter": "grandqc"})
    assert seen == [{"kind": "segmentation", "item": _ITEM, "art_hash": "seg-xyz",
                     "params": {"segmenter": "grandqc", "remove_artifacts": False,
                                "remove_holes": False, "remove_penmarks": False}}]


def test_the_row_records_the_params_the_service_resolved(client, art_store, monkeypatch):
    """Defaults are the service's to fill; the row must show what will actually run, not the
    empty body that was posted."""
    monkeypatch.setattr(routes_mod, "_content_address", _address(segmenter="grandqc"))
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch())

    client.post(f"{_BASE}/{_ITEM}/segment", json={})
    row = client.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"][0]
    assert row["params"]["segmenter"] == "grandqc"
    assert row["params"]["seg_conf_thresh"] == 0.5


def test_a_failed_dispatch_leaves_no_promise_behind(client, monkeypatch):
    """No row without a job behind it. The write happens after the dispatch precisely so that a
    queued row nothing will ever pick up cannot be written in the first place."""
    monkeypatch.setattr(routes_mod, "_content_address", _address())

    async def refuse(**kw):
        raise DispatchUnavailable("the PathAssist Girder plugin refused the run (503): no worker")

    monkeypatch.setattr(routes_mod, "dispatch_run", refuse)

    r = client.post(f"{_BASE}/{_ITEM}/segment", json={})
    assert r.status_code == 502
    assert "no worker" in r.json()["detail"]
    assert client.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"] == []


def test_without_the_plugin_the_old_path_still_runs(art_store, monkeypatch):
    """A deployment whose image has not been rebuilt keeps working."""
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_preprocess_url] = lambda: "http://preprocess:8030"
    app.dependency_overrides[get_plugin_url] = lambda: None

    async def trigger(*, base_url, stage, item, params, token):
        return {"job_id": "service-job-1", "seg_hash": "s1", "segmenter": "hest"}

    monkeypatch.setattr(routes_mod, "trigger_stage", trigger)

    r = TestClient(app).post(f"{_BASE}/{_ITEM}/segment", json={})
    assert r.status_code == 200
    assert r.json()["job_id"] == "service-job-1"


def test_a_preprocess_service_that_is_down_fails_before_anything_is_written(client, monkeypatch):
    async def unreachable(preprocess_url, kind, item, p):
        raise httpx.ConnectError("no route to host")

    monkeypatch.setattr(routes_mod, "_content_address", unreachable)
    with pytest.raises(httpx.ConnectError):
        client.post(f"{_BASE}/{_ITEM}/segment", json={})
    assert client.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"] == []


# ── report_artifact_result, the driver writing back ───────────────────────────────────


@pytest.fixture
def dispatched(client, monkeypatch):
    monkeypatch.setattr(routes_mod, "_content_address", _address())
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch())
    client.post(f"{_BASE}/{_ITEM}/segment", json={})
    return client


def test_a_finished_run_lands_on_the_row(dispatched):
    r = dispatched.post(
        f"{_BASE}/{_ITEM}/artifacts/seg-abc/result",
        json={"status": "ready",
              "result": {"n_contours": 434, "contours_ref": "seg/abc/contours.geojson"}},
    )
    assert r.status_code == 200
    row = dispatched.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"][0]
    assert row["status"] == "ready"
    assert row["n_items"] == 434
    assert row["artifact_ref"] == "seg/abc/contours.geojson"
    assert row["result"]["n_contours"] == 434


def test_a_stopped_run_lands_too_and_keeps_its_tallies(dispatched):
    """Cooperative stop left bytes on disk, so the row describes the smaller artifact it made."""
    r = dispatched.post(
        f"{_BASE}/{_ITEM}/artifacts/seg-abc/result",
        json={"status": "cancelled", "result": {"n_core_tiles": 8, "covered_mm2": 0.4}},
    )
    assert r.status_code == 200
    row = dispatched.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"][0]
    assert row["status"] == "cancelled"
    assert row["n_items"] == 8
    assert row["result"]["covered_mm2"] == 0.4


def test_a_failure_is_not_an_outcome_that_leaves_an_artifact(dispatched):
    """A failed run has nothing on disk to describe; its whole story is the Girder job."""
    r = dispatched.post(f"{_BASE}/{_ITEM}/artifacts/seg-abc/result",
                        json={"status": "failed", "result": {}})
    assert r.status_code == 400
    row = dispatched.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"][0]
    assert row["status"] == "queued", "a refused report must not half-write the row"


def test_reporting_against_an_artifact_this_slide_does_not_have_is_a_404(dispatched):
    r = dispatched.post(f"{_BASE}/{_ITEM}/artifacts/never-dispatched/result",
                        json={"status": "ready", "result": {}})
    assert r.status_code == 404


# ── The wire contract with the Girder plugin ────────────────────────────────────────────────
# Every test above doubles `dispatch_run`, which is right for testing the gateway's logic and
# wrong for testing what actually goes over the wire. This is the one place the request itself is
# asserted, because the shape is Girder's rather than ours: `autoDescribeRoute`'s `.param()` reads
# the QUERY STRING, and only a `paramType="body"` jsonParam reads the body. Sending one JSON
# object for everything — the obvious thing, and what this first did — makes the plugin reject
# every scalar as missing, and no amount of mocking `dispatch_run` can catch it.


@pytest.mark.anyio
async def test_the_plugin_gets_its_scalars_in_the_query_and_the_params_in_the_body():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = request.url
        seen["body"] = request.read().decode()
        seen["token"] = request.headers.get("Girder-Token")
        return httpx.Response(200, json={"jobId": "j1", "celeryTaskId": "c1"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    ack = await dispatch_run(
        plugin_url="http://girder:8080/api/v1", kind="segmentation", item=_ITEM,
        art_hash="seg-abc", params={"segmenter": "hest", "remove_holes": True},
        token="tok-1", title="Tissue segmentation", client=client,
    )

    assert ack["jobId"] == "j1"
    assert seen["url"].path == "/api/v1/pathassist/run"
    q = dict(seen["url"].params)
    assert q == {"kind": "segmentation", "item": _ITEM, "artHash": "seg-abc",
                 "title": "Tissue segmentation"}
    assert seen["body"] == '{"segmenter":"hest","remove_holes":true}'
    assert seen["token"] == "tok-1"


@pytest.mark.anyio
async def test_a_run_with_no_params_still_sends_an_object():
    """`requireObject=True` on the plugin side: an empty body would be a 400, not an empty dict."""
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = request.read().decode()
        return httpx.Response(200, json={"jobId": "j2"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    await dispatch_run(plugin_url="http://girder:8080/api/v1", kind="nuclei", item=_ITEM,
                       art_hash="nuc-1", params={}, token=None, client=client)
    assert seen["body"] == "{}"
