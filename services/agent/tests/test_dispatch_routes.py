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
from agent.loop.pathassist_dispatch import DispatchUnavailable, dispatch_chain
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


#: What the preprocess service adds to a segmentation nobody typed.
_RESOLVED = {"segmentation": {"segmenter": "hest", "seg_conf_thresh": 0.5, "impl": "trident"}}


# ── start_segment, dispatching ────────────────────────────────────────────────────────


def test_the_segmentation_is_named_before_it_is_queued(client, plan_seam):
    """The address goes to the plugin, so the driver can report against it later."""
    seen = []
    plan_seam(seen=seen, hashes={"segmentation": "seg-xyz"})

    r = client.post(f"{_BASE}/{_ITEM}/segment", json={"segmenter": "grandqc"})
    assert r.json()["art_hash"] == "seg-xyz"
    assert seen[0]["item"] == _ITEM
    assert [x["kind"] for x in seen[0]["steps"]] == ["segmentation"]
    assert seen[0]["steps"][0]["artHash"] == "seg-xyz"


def test_the_queued_step_carries_the_params_the_service_resolved(client, plan_seam):
    """Defaults are the service's to fill. The driver echoes these back on the report that writes
    the row, so anything the address depends on has to be here or the row cannot explain itself."""
    seen = []
    plan_seam(seen=seen, extra={"segmentation": {"segmenter": "grandqc",
                                                 "seg_conf_thresh": 0.5}})

    client.post(f"{_BASE}/{_ITEM}/segment", json={})
    assert seen[0]["steps"][0]["params"]["segmenter"] == "grandqc"
    assert seen[0]["steps"][0]["params"]["seg_conf_thresh"] == 0.5


def test_a_dispatched_segmentation_writes_no_row(client, plan_seam):
    """D9 for the last four kinds. Between submit and the last byte there is a job and no row."""
    plan_seam()

    client.post(f"{_BASE}/{_ITEM}/segment", json={})
    assert client.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"] == []


def test_a_failed_dispatch_says_what_the_plugin_said(client, monkeypatch, plan_seam):
    plan_seam()

    async def refuse(**kw):
        raise DispatchUnavailable("the PathAssist Girder plugin refused the run (503): no worker")

    monkeypatch.setattr(routes_mod, "dispatch_chain", refuse)

    r = client.post(f"{_BASE}/{_ITEM}/segment", json={})
    assert r.status_code == 502
    assert "no worker" in r.json()["detail"]
    assert client.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"] == []


def test_a_preprocess_service_that_is_down_fails_before_anything_is_queued(client, monkeypatch):
    def unreachable(urls):
        async def address(kind, params):
            raise httpx.ConnectError("no route to host")
        return address

    monkeypatch.setattr(routes_mod, "_addresser", unreachable)
    with pytest.raises(httpx.ConnectError):
        client.post(f"{_BASE}/{_ITEM}/segment", json={})
    assert client.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"] == []


# ── report_artifact_result, the driver writing back ───────────────────────────────────


@pytest.fixture
def dispatched(client, plan_seam):
    plan_seam()
    client.post(f"{_BASE}/{_ITEM}/segment", json={})
    return client


def _report(client, **body):
    """What the driver posts. `kind` is what lets it create the row it is the first write to."""
    return client.post(f"{_BASE}/{_ITEM}/artifacts/seg-1/result",
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
# every scalar as missing, and no amount of mocking `dispatch_chain` can catch it.


@pytest.mark.anyio
async def test_the_plugin_gets_its_scalars_in_the_query_and_the_steps_in_the_body():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = request.url
        seen["body"] = request.read().decode()
        seen["token"] = request.headers.get("Girder-Token")
        return httpx.Response(200, json={"chainId": "c1", "jobId": "j1"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    ack = await dispatch_chain(
        plugin_url="http://girder:8080/api/v1", item=_ITEM, token="tok-1", label="Feature index",
        steps=[{"kind": "segmentation", "artHash": "seg-abc",
                "params": {"segmenter": "hest"}, "title": "Tissue segmentation"}],
        client=client,
    )

    assert ack["jobId"] == "j1"
    assert seen["url"].path == "/api/v1/pathassist/chain"
    assert dict(seen["url"].params) == {"item": _ITEM, "label": "Feature index"}
    # An **array** body, because `steps` is a `requireArray` jsonParam. An object here is a 400.
    assert seen["body"].startswith("[") and '"artHash":"seg-abc"' in seen["body"]
    assert seen["token"] == "tok-1"


# ── nuclei, the first kind fully on this path (Inc 6 · 05, planned in 08) ──────────────
#
# Nuclei was the first kind to move the whole way, which made it the test of D9: **no row until the
# bytes exist.** Between the submit and the last tile there is a Girder job and nothing else, and
# the row is written by the report that says the run is over. Every kind is that shape now.
#
# What changed in 08 is the refusal: a whole-slide run with no segmentation used to be a 400
# telling the user to go and segment the slide first. That was a true sentence about a piece of
# work the machine could do, so the planner now queues the segmentation ahead of it.


@pytest.fixture
def nuclei_client(art_store):
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_plugin_url] = lambda: "http://girder:8080/api/v1"
    app.dependency_overrides[get_cellvit_url] = lambda: "http://cellvit:8020"
    return TestClient(app)


#: What the cellvit service resolves for itself: which checkpoint this box actually loaded.
_NUCLEI_RESOLVED = {"nuclei": {"backend": "cellvit-sam-h"}}

_REGION = {"x": 0, "y": 0, "width": 512, "height": 512}


def test_a_dispatched_nuclei_run_writes_no_row(nuclei_client, plan_seam):
    """The submit's whole output is a job. A row here would be a claim that bytes exist, and at
    this moment none do — which is the reuse check, the delete and the eye all reading a promise."""
    plan_seam(extra=_NUCLEI_RESOLVED)

    r = nuclei_client.post(f"{_BASE}/{_ITEM}/nuclei", json={"bbox": _REGION})
    assert r.status_code == 200
    assert r.json()["art_hash"] == "nuc-1"
    assert r.json()["girder_job_id"] == "girder-job-1"
    assert nuclei_client.get(f"{_BASE}/{_ITEM}/artifacts").json()["artifacts"] == []


def test_the_run_is_named_before_it_is_queued(nuclei_client, plan_seam):
    """The address has to exist first: a dispatched run never comes back through the gateway, so
    the hash it will be stored under is decided here or nowhere."""
    seen = []
    plan_seam(seen=seen, hashes={"nuclei": "nuc-xyz"}, extra=_NUCLEI_RESOLVED)

    nuclei_client.post(f"{_BASE}/{_ITEM}/nuclei", json={"bbox": None, "seg_hash": "s1"})
    assert [x["kind"] for x in seen[0]["steps"]] == ["nuclei"]
    assert seen[0]["steps"][0]["artHash"] == "nuc-xyz"
    assert seen[0]["steps"][0]["params"] == {
        "bbox": None, "seg_hash": "s1", "scope": "slide", "backend": "cellvit-sam-h"}


def test_a_region_run_carries_no_segmentation_and_plans_none(nuclei_client, plan_seam):
    """A drawn rectangle is its own mask, which is why `Need.when` exists."""
    seen = []
    plan_seam(seen=seen, extra=_NUCLEI_RESOLVED)

    nuclei_client.post(f"{_BASE}/{_ITEM}/nuclei", json={"bbox": _REGION})
    assert [x["kind"] for x in seen[0]["steps"]] == ["nuclei"]
    step = seen[0]["steps"][0]["params"]
    assert step["bbox"] == _REGION and step["seg_hash"] is None and step["scope"] == "region"


def test_a_whole_slide_run_without_a_segmentation_gets_one_planned(nuclei_client, plan_seam):
    """It used to be a 400 telling the user to go and segment the slide first (Inc 6 · 05). The
    sentence was true and the work was something the machine could do, so it does it (08)."""
    seen = []
    plan_seam(seen=seen, extra=_NUCLEI_RESOLVED)

    r = nuclei_client.post(f"{_BASE}/{_ITEM}/nuclei", json={"bbox": None})
    assert r.status_code == 200
    assert [x["kind"] for x in seen[0]["steps"]] == ["segmentation", "nuclei"]
    # And the nuclei step is dispatched against the segmentation the plan just named.
    assert seen[0]["steps"][1]["params"]["seg_hash"] == "seg-1"


def test_a_planned_upstream_is_skipped_when_the_slide_already_has_it(nuclei_client, plan_seam):
    seen = []
    plan_seam(seen=seen, extra=_NUCLEI_RESOLVED)
    nuclei_client.post(f"{_BASE}/{_ITEM}/artifacts/seg-1/result",
                       json={"status": "ready", "kind": "segmentation", "params": {}})

    nuclei_client.post(f"{_BASE}/{_ITEM}/nuclei", json={"bbox": None})
    assert [x["kind"] for x in seen[0]["steps"]] == ["nuclei"]


def test_a_second_region_is_queued_and_not_answered_as_already_built(nuclei_client, plan_seam):
    """The artifact's address does not depend on the rectangle — that is what lets two regions
    share one coverage set. So a slide that already has nuclei is a slide that covers *something*,
    and a new rectangle is work. Reading it as `ready` made the second region a silent no-op: the
    mask stayed where the first run put it, which is what a user sees as "it ran somewhere else"."""
    seen = []
    plan_seam(seen=seen, extra=_NUCLEI_RESOLVED)
    # The first region's bytes are on disk.
    nuclei_client.post(f"{_BASE}/{_ITEM}/artifacts/nuc-1/result",
                       json={"status": "ready", "kind": "nuclei", "params": {"scope": "region"},
                             "result": {"art_hash": "nuc-1", "n_nuclei": 5083}})

    r = nuclei_client.post(f"{_BASE}/{_ITEM}/nuclei",
                           json={"bbox": {"x": 11000, "y": 11000, "width": 600, "height": 500}})
    assert r.json()["status"] == "queued"
    assert [x["kind"] for x in seen[0]["steps"]] == ["nuclei"]


def test_resuming_a_stopped_whole_slide_run_is_queued_too(nuclei_client, plan_seam):
    """"Stopped … and resumed by starting the same run again" is what the panel promises, and a
    stopped run leaves a row behind."""
    seen = []
    plan_seam(seen=seen, extra=_NUCLEI_RESOLVED)
    nuclei_client.post(f"{_BASE}/{_ITEM}/artifacts/seg-1/result",
                       json={"status": "ready", "kind": "segmentation", "params": {}})
    nuclei_client.post(f"{_BASE}/{_ITEM}/artifacts/nuc-1/result",
                       json={"status": "cancelled", "kind": "nuclei", "params": {"scope": "slide"},
                             "result": {"n_nuclei": 412, "stopped": True, "remaining": 5}})

    r = nuclei_client.post(f"{_BASE}/{_ITEM}/nuclei", json={"bbox": None, "seg_hash": "seg-1"})
    assert r.json()["status"] == "queued"
    # And it does not rebuild the contours it already has.
    assert [x["kind"] for x in seen[0]["steps"]] == ["nuclei"]


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


def test_the_row_appears_when_the_run_reports_its_bytes(nuclei_client, plan_seam):
    """The report is the row's first write, so it has to say what kind it is creating."""
    plan_seam(extra=_NUCLEI_RESOLVED)
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


def test_a_stopped_nuclei_run_creates_its_row_too(nuclei_client, plan_seam):
    """A stopped build is not a failed one: it holds a complete artifact of a smaller area, with
    the tallies and the remaining count that make starting again a resume rather than a restart."""
    plan_seam(extra=_NUCLEI_RESOLVED)
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


# ── classify, the one kind that is dispatched rather than planned (Inc 7) ──────────────
#
# Its input is a *built* artifact, so there is nothing to address and nothing to skip: the run
# writes into the hash it was handed. That is why it does not go through `_plan_and_dispatch` —
# the planner would find the address already in `have` and answer `ready`.
#
# What it still has to honour is `mode`. Every native form asks what a submission would cost by
# calling its own submit with `mode="plan"` on each change, so a route that took the parameter and
# dispatched anyway ran the job three times while the user was choosing the model. A browser E2E
# counted the jobs; these tests are so that nothing has to count them again.


def _nuclei_row(client, art_hash="nuc-1"):
    client.post(f"{_BASE}/{_ITEM}/artifacts/{art_hash}/result",
                json={"status": "ready", "kind": "nuclei", "params": {"scope": "region"},
                      "result": {"art_hash": art_hash, "n_nuclei": 10}})


def test_a_classification_is_dispatched_against_the_artifact_it_names(nuclei_client, plan_seam):
    seen = []
    plan_seam(seen=seen)
    _nuclei_row(nuclei_client)

    r = nuclei_client.post(f"{_BASE}/{_ITEM}/classify",
                           json={"art_hash": "nuc-1", "taxonomy": "nucls_super"})
    assert r.status_code == 200
    assert r.json()["status"] == "queued"
    # One step, and it carries the artifact's own address — which is what joins its progress onto
    # the Nuclei row instead of making a second one.
    assert [s["kind"] for s in seen[0]["steps"]] == ["classify"]
    assert seen[0]["steps"][0]["artHash"] == "nuc-1"
    assert seen[0]["steps"][0]["params"]["taxonomy"] == "nucls_super"


def test_planning_a_classification_queues_nothing(nuclei_client, plan_seam):
    """The form asks this on every keystroke. It must be free."""
    seen = []
    plan_seam(seen=seen)
    _nuclei_row(nuclei_client)

    r = nuclei_client.post(f"{_BASE}/{_ITEM}/classify?mode=plan",
                           json={"art_hash": "nuc-1", "taxonomy": "nucls_super"})
    assert r.status_code == 200
    assert r.json()["status"] == "planned"
    assert [s["kind"] for s in r.json()["steps"]] == ["classify"]
    assert seen == []


def test_a_planned_classification_is_never_reported_as_already_built(nuclei_client, plan_seam):
    """Unlike a content-addressed build there is no `ready` answer: re-running a naming is how it
    catches up with a segmentation that has grown since."""
    plan_seam()
    _nuclei_row(nuclei_client)

    body = nuclei_client.post(f"{_BASE}/{_ITEM}/classify?mode=plan",
                              json={"art_hash": "nuc-1", "taxonomy": "nucls_super"}).json()
    assert body["reused"] is False
    assert body["plan"][0]["built"] is False


def test_classifying_something_that_is_not_a_nuclei_run_is_refused(nuclei_client, plan_seam):
    plan_seam()
    nuclei_client.post(f"{_BASE}/{_ITEM}/artifacts/tis-1/result",
                       json={"status": "ready", "kind": "tissue", "params": {},
                             "result": {"art_hash": "tis-1"}})

    r = nuclei_client.post(f"{_BASE}/{_ITEM}/classify",
                           json={"art_hash": "tis-1", "taxonomy": "nucls_super"})
    assert r.status_code == 400


def test_classifying_an_artifact_this_slide_does_not_have_is_a_404(nuclei_client, plan_seam):
    plan_seam()
    r = nuclei_client.post(f"{_BASE}/{_ITEM}/classify",
                           json={"art_hash": "nope", "taxonomy": "nucls_super"})
    assert r.status_code == 404
