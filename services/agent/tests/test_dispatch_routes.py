"""Dispatching a run onto Celery instead of calling the service (Inc 6 · ticket 01).

The two halves of the new path, from the gateway's side: `start_segment` naming the artifact and
handing it to the Girder plugin, and the driver reporting back how it ended.

The direct-to-service path these tests once shared the file with is gone (07): there is one way a
run exists now, and it is a Girder job. What is left here is the report — the driver writing back
the only thing that turns a finished run into a row.
"""

import httpx
import pytest
from starlette.testclient import TestClient

from agent.gateway import routes as routes_mod
from agent.gateway.app import create_app
from agent.gateway.auth import require_user
from agent.gateway.routes import (
    get_cellvit_url,
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
    """A `dispatch_run` double — the single-run route the three JobQueue kinds still use."""
    async def dispatch(*, plugin_url, kind, item, art_hash, params, token, **kw):
        if seen is not None:
            seen.append({"kind": kind, "item": item, "art_hash": art_hash, "params": params})
        return {"jobId": job_id, "celeryTaskId": "t1", "kind": kind,
                "item": item, "artHash": art_hash, "queue": "pathassist"}
    return dispatch


def _chain(job_id="girder-job-1", seen=None):
    async def dispatch(*, plugin_url, item, steps, token, label=None, **kw):
        if seen is not None:
            seen.append({"item": item, "label": label, "steps": steps})
        return {"chainId": "c1", "jobId": job_id, "queue": "pathassist",
                "steps": [{"kind": x["kind"], "artHash": x["artHash"]} for x in steps]}
    return dispatch


# ── start_segment, dispatching ────────────────────────────────────────────────────────


def test_the_segmentation_is_named_before_it_is_queued(client, monkeypatch):
    """The address goes to the plugin, so the driver can report against it later."""
    seen = []
    monkeypatch.setattr(routes_mod, "_content_address", _address("seg-xyz"))
    monkeypatch.setattr(routes_mod, "dispatch_chain", _chain(seen=seen))

    r = client.post(f"{_BASE}/{_ITEM}/segment", json={"segmenter": "grandqc"})
    assert r.json()["art_hash"] == "seg-xyz"
    assert seen[0]["item"] == _ITEM
    assert [x["kind"] for x in seen[0]["steps"]] == ["segmentation"]
    assert seen[0]["steps"][0]["artHash"] == "seg-xyz"


def test_the_queued_step_carries_the_params_the_service_resolved(client, monkeypatch):
    """Defaults are the service's to fill. The driver echoes these back on the report that writes
    the row, so anything the address depends on has to be here or the row cannot explain itself."""
    seen = []
    monkeypatch.setattr(routes_mod, "_content_address", _address(segmenter="grandqc"))
    monkeypatch.setattr(routes_mod, "dispatch_chain", _chain(seen=seen))

    client.post(f"{_BASE}/{_ITEM}/segment", json={})
    assert seen[0]["steps"][0]["params"]["segmenter"] == "grandqc"
    assert seen[0]["steps"][0]["params"]["seg_conf_thresh"] == 0.5


def test_a_dispatched_segmentation_writes_no_row(client, monkeypatch):
    """D9 for the last four kinds. Between submit and the last byte there is a job and no row."""
    monkeypatch.setattr(routes_mod, "_content_address", _address())
    monkeypatch.setattr(routes_mod, "dispatch_chain", _chain())

    client.post(f"{_BASE}/{_ITEM}/segment", json={})
    assert client.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"] == []


def test_a_failed_dispatch_says_what_the_plugin_said(client, monkeypatch):
    monkeypatch.setattr(routes_mod, "_content_address", _address())

    async def refuse(**kw):
        raise DispatchUnavailable("the PathAssist Girder plugin refused the run (503): no worker")

    monkeypatch.setattr(routes_mod, "dispatch_chain", refuse)

    r = client.post(f"{_BASE}/{_ITEM}/segment", json={})
    assert r.status_code == 502
    assert "no worker" in r.json()["detail"]
    assert client.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"] == []


def test_a_preprocess_service_that_is_down_fails_before_anything_is_queued(client, monkeypatch):
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
    monkeypatch.setattr(routes_mod, "dispatch_chain", _chain())
    client.post(f"{_BASE}/{_ITEM}/segment", json={})
    return client


def _report(client, **body):
    """What the driver posts. `kind` is what lets it create the row it is the first write to."""
    return client.post(f"{_BASE}/{_ITEM}/artifacts/seg-abc/result",
                       json={"kind": "segmentation", "params": {"segmenter": "hest"}, **body})


def test_a_finished_run_creates_the_row(dispatched):
    r = _report(dispatched, status="ready",
                result={"n_contours": 434, "contours_ref": "seg/abc/contours.geojson"})
    assert r.status_code == 200
    row = dispatched.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"][0]
    assert row["status"] == "ready"
    assert row["n_items"] == 434
    assert row["artifact_ref"] == "seg/abc/contours.geojson"
    assert row["result"]["n_contours"] == 434


def test_a_stopped_run_lands_too_and_keeps_its_tallies(dispatched):
    """Cooperative stop left bytes on disk, so the row describes the smaller artifact it made."""
    r = _report(dispatched, status="cancelled",
                result={"n_core_tiles": 8, "covered_mm2": 0.4})
    assert r.status_code == 200
    row = dispatched.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"][0]
    assert row["status"] == "cancelled"
    assert row["n_items"] == 8
    assert row["result"]["covered_mm2"] == 0.4


def test_a_failure_is_not_an_outcome_that_leaves_an_artifact(dispatched):
    """A failed run has nothing on disk to describe; its whole story is the Girder job."""
    r = _report(dispatched, status="failed", result={})
    assert r.status_code == 400
    assert dispatched.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"] == [], (
        "a refused report must not create the row it was refused for"
    )


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


# ── nuclei, the first kind fully on this path (Inc 6 · 05) ─────────────────────────────
#
# Segmentation above still writes a row when it dispatches — its four sibling kinds share that row
# and reconcile against it, so the column cannot go until the last of them moves (07). Nuclei has
# no siblings and moved the whole way, which is what makes it the test of D9: **no row until the
# bytes exist.** Between the submit and the last tile there is a Girder job and nothing else, and
# the row is written by the report that says the run is over.
#
# These nine replace nine in `test_dag_routes.py` that described the direct-to-worker path.


@pytest.fixture
def nuclei_client(art_store):
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_plugin_url] = lambda: "http://girder:8080/api/v1"
    app.dependency_overrides[get_cellvit_url] = lambda: "http://cellvit:8020"
    return TestClient(app)


def _nuclei_address(art_hash="nuc-1", backend="cellvit-sam-h"):
    """A `/nuclei/hash` double: the service naming what a run would produce, enqueuing nothing."""
    async def addressed(cellvit_url):
        return {"kind": "nuclei", "art_hash": art_hash, "backend": backend}
    return addressed


_REGION = {"x": 0, "y": 0, "width": 512, "height": 512}


def test_a_dispatched_nuclei_run_writes_no_row(nuclei_client, monkeypatch):
    """The submit's whole output is a job. A row here would be a claim that bytes exist, and at
    this moment none do — which is the reuse check, the delete and the eye all reading a promise."""
    monkeypatch.setattr(routes_mod, "_nuclei_address", _nuclei_address())
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch("girder-job-9"))

    r = nuclei_client.post(f"{_BASE}/{_ITEM}/nuclei", json={"bbox": _REGION})
    assert r.status_code == 200
    assert r.json()["art_hash"] == "nuc-1"
    assert r.json()["girder_job_id"] == "girder-job-9"
    assert nuclei_client.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"] == []


def test_the_run_is_named_before_it_is_queued(nuclei_client, monkeypatch):
    """The address has to exist first: a dispatched run never comes back through the gateway, so
    the hash it will be stored under is decided here or nowhere."""
    seen = []
    monkeypatch.setattr(routes_mod, "_nuclei_address", _nuclei_address("nuc-xyz"))
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch(seen=seen))

    nuclei_client.post(f"{_BASE}/{_ITEM}/nuclei", json={"bbox": None, "seg_hash": "s1"})
    assert seen == [{"kind": "nuclei", "item": _ITEM, "art_hash": "nuc-xyz",
                     "params": {"bbox": None, "seg_hash": "s1",
                                "scope": "slide", "backend": "cellvit-sam-h"}}]


def test_a_region_run_says_so_and_carries_no_segmentation(nuclei_client, monkeypatch):
    seen = []
    monkeypatch.setattr(routes_mod, "_nuclei_address", _nuclei_address())
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch(seen=seen))

    r = nuclei_client.post(f"{_BASE}/{_ITEM}/nuclei", json={"bbox": _REGION})
    assert r.json()["scope"] == "region"
    assert seen[0]["params"]["bbox"] == _REGION and seen[0]["params"]["seg_hash"] is None


def test_a_whole_slide_run_without_a_segmentation_is_refused_before_it_is_queued(
    nuclei_client, monkeypatch,
):
    """The one refusal the caller can act on. Left to the worker it would become a job that fails
    a second after it starts, which is a refusal nobody sees until they go looking for it."""
    dispatched = []
    monkeypatch.setattr(routes_mod, "_nuclei_address", _nuclei_address())
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch(seen=dispatched))

    r = nuclei_client.post(f"{_BASE}/{_ITEM}/nuclei", json={"bbox": None})
    assert r.status_code == 400
    assert "segment the slide first" in r.json()["detail"]
    assert dispatched == []


def test_nuclei_without_the_job_queue_is_refused(art_store):
    """There is no direct-to-worker fallback left for this kind: the queue is the path."""
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_plugin_url] = lambda: None

    r = TestClient(app).post(f"{_BASE}/{_ITEM}/nuclei", json={"bbox": _REGION})
    assert r.status_code == 503


def test_nuclei_without_a_configured_worker_is_503(art_store):
    """Nothing can name the artifact, so nothing is dispatched."""
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_plugin_url] = lambda: "http://girder:8080/api/v1"

    r = TestClient(app).post(f"{_BASE}/{_ITEM}/nuclei", json={"bbox": _REGION})
    assert r.status_code == 503


def test_the_row_appears_when_the_run_reports_its_bytes(nuclei_client, monkeypatch):
    """The report is the row's first write, so it has to say what kind it is creating."""
    monkeypatch.setattr(routes_mod, "_nuclei_address", _nuclei_address())
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch("girder-job-9"))
    nuclei_client.post(f"{_BASE}/{_ITEM}/nuclei", json={"bbox": None, "seg_hash": "s1"})

    r = nuclei_client.post(
        f"{_BASE}/{_ITEM}/artifacts/nuc-1/result",
        json={"status": "ready", "kind": "nuclei", "girder_job_id": "girder-job-9",
              "params": {"scope": "slide", "seg_hash": "s1", "backend": "cellvit-sam-h"},
              "result": {"art_hash": "nuc-1", "n_nuclei": 15180, "n_tiles": 77,
                         "area_mm2": 20.62,
                         "counts_by_class": {"Neoplastic": 3836, "Connective": 10955}}},
    )
    assert r.status_code == 200

    row = nuclei_client.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"][0]
    assert row["kind"] == "nuclei" and row["art_hash"] == "nuc-1"
    assert row["n_items"] == 15180
    assert row["result"]["counts_by_class"]["Neoplastic"] == 3836
    # A nucleus outline does not depend on a segmentation — a tissue mask is coverage, not
    # identity — so the seg_hash rides in params and leaves no DAG edge to refuse a delete on.
    assert row["parent_hash"] is None
    assert row["params"]["seg_hash"] == "s1"
    # Which run made these bytes. Provenance: the job it names is already over.
    assert row["girder_job_id"] == "girder-job-9"


def test_a_stopped_nuclei_run_creates_its_row_too(nuclei_client, monkeypatch):
    """A stopped build is not a failed one: it holds a complete artifact of a smaller area, with
    the tallies and the remaining count that make starting again a resume rather than a restart."""
    monkeypatch.setattr(routes_mod, "_nuclei_address", _nuclei_address())
    monkeypatch.setattr(routes_mod, "dispatch_run", _dispatch())
    nuclei_client.post(f"{_BASE}/{_ITEM}/nuclei", json={"bbox": None, "seg_hash": "s1"})

    nuclei_client.post(
        f"{_BASE}/{_ITEM}/artifacts/nuc-1/result",
        json={"status": "cancelled", "kind": "nuclei", "params": {"scope": "slide"},
              "result": {"n_nuclei": 412, "n_tiles": 2, "stopped": True, "remaining": 5,
                         "counts_by_class": {"Neoplastic": 300, "Connective": 112}}},
    )

    row = nuclei_client.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"][0]
    assert row["status"] == "cancelled"
    assert row["n_items"] == 412
    assert row["result"]["remaining"] == 5


def test_a_report_for_a_missing_row_that_does_not_name_its_kind_is_still_a_404(nuclei_client):
    """The 404 did not go away — it narrowed. A report that cannot say what to create still has
    nothing to write against, which is what a stale driver reporting a deleted artifact looks
    like."""
    r = nuclei_client.post(f"{_BASE}/{_ITEM}/artifacts/never-dispatched/result",
                           json={"status": "ready", "result": {}})
    assert r.status_code == 404
