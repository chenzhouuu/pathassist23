import httpx
import pytest
from starlette.testclient import TestClient

from agent.gateway import routes as routes_mod
from agent.gateway.app import create_app
from agent.gateway.auth import require_user
from agent.gateway.routes import (
    get_biomarker_url,
    get_plugin_url,
    get_preprocess_artifact_store,
    get_preprocess_url,
    get_tissue_url,
)
from agent.store import MemoryPreprocessArtifactStore

_USER = {"_id": "u1", "login": "tester"}
_BASE = "/api/copilot/slides"


@pytest.fixture
def art_store():
    return MemoryPreprocessArtifactStore()


@pytest.fixture
def client(art_store):
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_preprocess_url] = lambda: "http://preprocess:8030"
    # Pinned rather than inherited from whatever `AGENT_PATHASSIST_PLUGIN_URL` is in the
    # developer's .env. From 07 there is only this path — the direct-to-service one these tests
    # used to exercise is gone, and a run that is not a Girder job cannot appear in Runs.
    app.dependency_overrides[get_plugin_url] = lambda: "http://girder:8080/api/v1"
    return TestClient(app)


#: What the preprocess service adds to a segmentation nobody typed: the image that ran it.
_RESOLVED = {"segmentation": {"impl": "trident"}}


def test_a_segmentation_is_a_one_step_chain_and_writes_no_row(client, art_store, plan_seam):
    """D9, now for the last four kinds: dispatch names the artifact and queues the work, and the
    row waits for the bytes. Until then the run exists only as its Girder job."""
    seen = []
    plan_seam(seen=seen, extra=_RESOLVED)

    r = client.post(f"{_BASE}/item9/segment", json={"segmenter": "hest"})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "segmentation" and body["art_hash"] == "seg-1"
    assert body["status"] == "queued" and body["girder_job_id"] == "girder-job-1"
    assert [s["kind"] for s in seen[0]["steps"]] == ["segmentation"]
    assert art_store._rows == {}


def test_a_build_queues_segment_then_tile_then_encode(client, plan_seam):
    """One submission, three steps, in the order the DAG requires them."""
    seen = []
    plan_seam(seen=seen, extra=_RESOLVED)

    r = client.post(f"{_BASE}/item9/build",
                    json={"encoder": "conch_v1", "mag": 20, "patch_size": 512})
    assert r.status_code == 200
    body = r.json()
    assert body["art_hash"] == "feat-1", "the submission is named after what it is for"
    assert [s["kind"] for s in body["steps"]] == ["segmentation", "patching", "features"]
    assert seen[0]["label"] == "Feature index"


def test_each_step_is_dispatched_with_the_parent_the_step_before_it_produced(client, plan_seam):
    addressed, seen = [], []
    plan_seam(seen=seen, addressed=addressed, extra=_RESOLVED)

    client.post(f"{_BASE}/item9/build", json={"encoder": "conch_v1"})
    steps = seen[0]["steps"]
    assert steps[1]["params"]["seg_hash"] == "seg-1"
    assert steps[2]["params"]["patch_hash"] == "pat-1"
    # Nobody supplied those, and nobody could: they are what the steps before them turned out to
    # be called.
    assert addressed[1][1]["seg_hash"] == "seg-1"


def test_a_step_carries_what_the_service_resolved_not_what_was_asked_for(client, plan_seam):
    """`impl` is in the address and nobody types it, so it has to reach the row that records it."""
    seen = []
    plan_seam(seen=seen, extra=_RESOLVED)

    client.post(f"{_BASE}/item9/segment", json={"segmenter": "hest"})
    assert seen[0]["steps"][0]["params"]["impl"] == "trident"


def _built(client, art_hash, kind, item="item9", result=None):
    """Give the slide an artifact the way one really appears: a run reporting its bytes."""
    r = client.post(f"{_BASE}/{item}/artifacts/{art_hash}/result",
                    json={"status": "ready", "kind": kind, "params": {},
                          "result": result or {}})
    assert r.status_code == 200
    return r.json()


def test_a_build_queues_only_what_the_slide_is_missing(client, plan_seam):
    """The second encoder over the same tiles is one step, not three."""
    seen = []
    plan_seam(seen=seen, extra=_RESOLVED)
    _built(client, "seg-1", "segmentation")

    client.post(f"{_BASE}/item9/build", json={"encoder": "conch_v1"})
    assert [s["kind"] for s in seen[0]["steps"]] == ["patching", "features"]


def test_a_build_with_nothing_left_to_do_is_answered_rather_than_queued(client, plan_seam):
    """Content addressing makes the second identical build a no-op. Spending a queue slot to
    rediscover that, at `concurrency=1`, is a wait somebody else pays for."""
    seen = []
    plan_seam(seen=seen, extra=_RESOLVED)
    for h, kind in (("seg-1", "segmentation"), ("pat-1", "patching"), ("feat-1", "features")):
        _built(client, h, kind)

    r = client.post(f"{_BASE}/item9/build", json={"encoder": "conch_v1"})
    assert r.status_code == 200
    assert r.json()["status"] == "ready" and r.json()["steps"] == []
    assert r.json()["art_hash"] == "feat-1" and r.json()["reused"] is True
    assert seen == []


def test_a_dry_run_states_what_it_would_cost_and_queues_nothing(client, plan_seam):
    """The sentence the form shows before anyone agrees to it, computed by the function that will
    run the submission — so the statement and the run cannot disagree (Inc 6 · 08)."""
    seen = []
    plan_seam(seen=seen, extra=_RESOLVED)

    r = client.post(f"{_BASE}/item9/build?mode=plan", json={"encoder": "conch_v1"})
    body = r.json()
    assert body["status"] == "planned"
    assert [s["kind"] for s in body["steps"]] == ["segmentation", "patching", "features"]
    assert [s["title"] for s in body["steps"]][0] == "Tissue segmentation"
    assert seen == [], "a plan is a question, not a submission"


def test_a_dry_run_marks_what_the_slide_already_has(client, plan_seam):
    plan_seam(extra=_RESOLVED)
    _built(client, "seg-1", "segmentation")

    body = client.post(f"{_BASE}/item9/build?mode=plan", json={"encoder": "conch_v1"}).json()
    assert [(s["kind"], s["built"]) for s in body["plan"]] == [
        ("segmentation", True), ("patching", False), ("features", False)]
    assert [s["kind"] for s in body["steps"]] == ["patching", "features"]


def test_a_dag_run_needs_both_the_service_and_the_queue():
    """Two different absences with two different answers — one is "no model", the other is
    "nowhere to run it"."""
    for preprocess, plugin in ((None, "http://girder:8080/api/v1"),
                               ("http://preprocess:8030", None)):
        app = create_app()
        app.dependency_overrides[require_user] = lambda: _USER
        app.dependency_overrides[get_preprocess_artifact_store] = (
            lambda: MemoryPreprocessArtifactStore()
        )
        app.dependency_overrides[get_preprocess_url] = lambda url=preprocess: url
        app.dependency_overrides[get_plugin_url] = lambda url=plugin: url
        r = TestClient(app).post(f"{_BASE}/item9/segment", json={})
        assert r.status_code == 503, (preprocess, plugin)


def test_the_artifact_list_only_reads(client, monkeypatch):
    """The reconcile loop is gone (07). Nothing this route does can change a row — which is what
    stops a list nobody has open from being the reason a build never finishes."""
    def explode(*a, **kw):
        raise AssertionError("listing artifacts must not dial a worker")

    monkeypatch.setattr(routes_mod, "get_job_status", explode)
    _built(client, "seg-1", "segmentation", result={"n_contours": 12})
    r = client.get(f"{_BASE}/item9/artifacts")
    assert r.status_code == 200
    assert r.json()["artifacts"][0]["n_items"] == 12


def test_artifacts_empty_for_unknown_slide(client):
    assert client.get(f"{_BASE}/nope/artifacts").json() == {"artifacts": []}


def test_segmentation_contours_proxied(client, monkeypatch):
    gj = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"kind": "tissue"},
         "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 0]]]}},
    ]}

    async def fake_contours(*, base_url, item, seg_hash):
        return gj
    monkeypatch.setattr(routes_mod, "get_contours", fake_contours)
    r = client.get(f"{_BASE}/item9/segmentation/s1/contours")
    assert r.status_code == 200 and r.json()["type"] == "FeatureCollection"


def test_segmentation_contours_404_when_absent(client, monkeypatch):
    async def none_contours(*, base_url, item, seg_hash):
        return None
    monkeypatch.setattr(routes_mod, "get_contours", none_contours)
    assert client.get(f"{_BASE}/item9/segmentation/nope/contours").status_code == 404


# ── delete (Inc 5, ticket 04) ──────────────────────────────────────────────────────


async def _seed(store, item, kind, art_hash, parent=None, params=None):
    return await store.upsert_artifact(
        item=item, kind=kind, art_hash=art_hash, parent_hash=parent, params=params or {},
    )


def _with_map_workers(client):
    """The tissue and biomarker workers own their own kinds' bytes, so a delete of one of those
    rows only reaches a service when their URLs are configured."""
    client.app.dependency_overrides[get_tissue_url] = lambda: "http://tissue:8021"
    client.app.dependency_overrides[get_biomarker_url] = lambda: "http://biomarker:8022"
    return client


def _deleted(calls):
    """A delete_artifact double that records what it was asked to remove."""
    async def delete(*, base_url, kind, item, art_hash, client=None):
        calls.append((base_url, kind, item, art_hash))
    return delete


def _sized(n):
    async def usage(*, base_url, kind, item, art_hash, client=None):
        return n
    return usage


@pytest.mark.anyio
async def test_delete_removes_the_row_and_asks_the_owning_service_for_the_bytes(
    client, art_store, monkeypatch,
):
    await _seed(art_store, "item9", "tissue", "t1")
    calls = []
    monkeypatch.setattr(routes_mod, "delete_artifact", _deleted(calls))
    _with_map_workers(client)

    r = client.delete(f"{_BASE}/item9/artifacts/t1")
    assert r.status_code == 204
    assert await art_store.get_artifact(item="item9", art_hash="t1") is None
    assert calls and calls[0][1:] == ("tissue", "item9", "t1")


@pytest.mark.anyio
async def test_delete_is_refused_while_something_was_built_from_it(client, art_store, monkeypatch):
    await _seed(art_store, "item9", "segmentation", "s1")
    await _seed(art_store, "item9", "patching", "p1", parent="s1", params={"mag": 20})
    calls = []
    monkeypatch.setattr(routes_mod, "delete_artifact", _deleted(calls))

    r = client.delete(f"{_BASE}/item9/artifacts/s1")
    assert r.status_code == 409
    body = r.json()["detail"]
    # Named, not counted — the dialog has to say what is holding it.
    assert body["dependants"] == [{"kind": "patching", "art_hash": "p1", "params": {"mag": 20}}]
    # And nothing was touched: refusing must not have removed the row or the bytes.
    assert await art_store.get_artifact(item="item9", art_hash="s1") is not None
    assert calls == []


@pytest.mark.anyio
async def test_deleting_a_leaf_leaves_its_parent_alone(client, art_store, monkeypatch):
    await _seed(art_store, "item9", "segmentation", "s1")
    await _seed(art_store, "item9", "patching", "p1", parent="s1")
    monkeypatch.setattr(routes_mod, "delete_artifact", _deleted([]))

    assert client.delete(f"{_BASE}/item9/artifacts/p1").status_code == 204
    assert await art_store.get_artifact(item="item9", art_hash="s1") is not None


def test_deleting_an_artifact_this_slide_does_not_have_is_404(client):
    assert client.delete(f"{_BASE}/item9/artifacts/nope").status_code == 404


@pytest.mark.anyio
async def test_a_dead_worker_does_not_fail_a_delete_the_user_cannot_retry(
    client, art_store, monkeypatch,
):
    await _seed(art_store, "item9", "tissue", "t1")

    async def boom(*, base_url, kind, item, art_hash, client=None):
        raise httpx.ConnectError("worker down")
    monkeypatch.setattr(routes_mod, "delete_artifact", boom)
    _with_map_workers(client)

    # The row is already gone, so the artifact is gone as far as the app is concerned. What is left
    # is an orphan directory, which the next build of the same hash overwrites.
    assert client.delete(f"{_BASE}/item9/artifacts/t1").status_code == 204
    assert await art_store.get_artifact(item="item9", art_hash="t1") is None


@pytest.mark.anyio
async def test_usage_answers_size_and_dependants_together(client, art_store, monkeypatch):
    await _seed(art_store, "item9", "segmentation", "s1")
    await _seed(art_store, "item9", "tissue", "t1", parent="s1", params={"backend": "hover-next"})
    monkeypatch.setattr(routes_mod, "artifact_usage", _sized(304_087_040))

    r = client.get(f"{_BASE}/item9/artifacts/s1/usage")
    assert r.status_code == 200
    assert r.json() == {
        "bytes": 304_087_040,
        "dependants": [{"kind": "tissue", "art_hash": "t1", "params": {"backend": "hover-next"}}],
    }


@pytest.mark.anyio
async def test_a_size_the_worker_cannot_give_is_not_a_refusal(client, art_store, monkeypatch):
    await _seed(art_store, "item9", "tissue", "t1")
    monkeypatch.setattr(routes_mod, "artifact_usage", _sized(0))

    r = client.get(f"{_BASE}/item9/artifacts/t1/usage")
    assert r.status_code == 200 and r.json()["bytes"] == 0


# ── nuclei (Inc 5 · 05; moved out in Inc 6 · 05) ───────────────────────────────────
#
# Submitting, stopping and reconciling a nuclei build are no longer this file's subject: nuclei
# dispatches onto the Girder job queue now, and this file's client pins `plugin_url` to None. The
# nine tests that were here are in `test_dispatch_routes.py`, rewritten around what replaced each
# one — a dispatch that writes no row, a refusal raised before the run is queued, and a report that
# creates the row when the bytes exist. What stays below is the read side, which did not move.


def _with_cellvit(client):
    from agent.gateway.routes import get_cellvit_url
    client.app.dependency_overrides[get_cellvit_url] = lambda: "http://cellvit:8020"
    return client


@pytest.mark.anyio
async def test_deleting_a_nuclei_artifact_reaches_the_cellvit_worker(
    client, art_store, monkeypatch,
):
    await _seed(art_store, "item9", "nuclei", "n1")
    calls = []
    monkeypatch.setattr(routes_mod, "delete_artifact", _deleted(calls))
    _with_cellvit(client)

    assert client.delete(f"{_BASE}/item9/artifacts/n1").status_code == 204
    assert calls[0] == ("http://cellvit:8020", "nuclei", "item9", "n1")


# ── the mask (Inc 5, ticket 06) ────────────────────────────────────────────────────


def _fake_tile(seen, *, status_code=200):
    from agent.loop.nuclei_client import TileResponse

    async def get(*, base_url, path, params, client=None):
        seen.append((base_url, path, params))
        return TileResponse(body=b"\x89PNG", content_type="image/png",
                            cache_control="public, max-age=86400", etag='W/"3"',
                            status_code=status_code)
    return get


def test_a_nuclei_tile_is_proxied_with_its_query_and_cache_headers(client, monkeypatch):
    seen = []
    monkeypatch.setattr(routes_mod, "get_nuclei_tile", _fake_tile(seen))
    _with_cellvit(client)

    r = client.get(f"{_BASE}/item9/nuclei/n1/tile/classes/2/3/4.png?alpha=0.6&show=Neoplastic")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    # An unchanged (artifact, coverage, query) tile is immutable, so the worker's caching survives
    # the hop through the gateway.
    assert r.headers["cache-control"] == "public, max-age=86400"
    assert r.headers["etag"] == 'W/"3"'

    base, path, params = seen[0]
    assert base == "http://cellvit:8020"
    assert path == "/nuclei/item9/n1/tile/classes/2/3/4.png"
    # Forwarded verbatim: the gateway does not know what a class is.
    assert params == {"alpha": "0.6", "show": "Neoplastic"}


def test_a_bad_class_spec_stays_a_400_rather_than_becoming_a_502(client, monkeypatch):
    """A typo in the class list is the panel's error to show, not a broken worker."""
    seen = []
    monkeypatch.setattr(routes_mod, "get_nuclei_tile", _fake_tile(seen, status_code=400))
    _with_cellvit(client)

    r = client.get(f"{_BASE}/item9/nuclei/n1/tile/classes/0/0/0.png?show=Tumour")
    assert r.status_code == 400


def test_a_tile_without_a_configured_worker_is_503(client):
    r = client.get(f"{_BASE}/item9/nuclei/n1/tile/classes/0/0/0.png")
    assert r.status_code == 503


# ── biomarker is built on nuclei (Inc 5, ticket 09) ────────────────────────────────


def _with_biomarker(client):
    client.app.dependency_overrides[get_biomarker_url] = lambda: "http://biomarker:8022"
    return client


# The two tests that used to sit here — "a map's parent is its nuclei" and "a map built before
# the switch still names a parent" — moved to `test_biomarker_routes.py` in Inc 6 · 06 with the
# route itself. The first is now asserted on the driver's report, which is where the row is
# written; the second described a map submitted with no `nuclei_hash`, which is refused outright
# now rather than parented on the segmentation instead.


@pytest.mark.anyio
async def test_deleting_the_nuclei_a_phenotype_map_stands_on_is_refused(
    client, art_store, monkeypatch,
):
    """The parent edge is what makes ticket 04's refusal cover this at all."""
    await _seed(art_store, "item9", "nuclei", "n1")
    await _seed(art_store, "item9", "biomarker", "b1", parent="n1",
                params={"scope": "slide"})
    _with_cellvit(client)
    _with_map_workers(client)

    r = client.delete(f"{_BASE}/item9/artifacts/n1")
    assert r.status_code == 409
    dependants = r.json()["detail"]["dependants"]
    assert [d["kind"] for d in dependants] == ["biomarker"]
