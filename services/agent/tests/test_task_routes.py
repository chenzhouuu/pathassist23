"""Gateway control plane for the downstream-task stage (Inc 2c, moved onto the queue in Inc 6 · 07).

The prediction is the fourth DAG node, parented on its feature index. What changed in 07 is where
the run lives: it is a Girder job, its row is written by the driver's report, and "run this task on
this slide" is one submission whether the index exists or has to be built first.

Per-patch arrays never touch the row — they come from the heatmap proxy.
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
from agent.store import MemoryPreprocessArtifactStore

_USER = {"_id": "u1", "login": "tester"}
_BASE = "/api/copilot"
_ITEM = "item9"
_FEAT, _PRED = "feat-1", "pred-1"

_ACK = {
    "job_id": "j4", "pred_hash": _PRED, "feat_hash": _FEAT, "kind": "prediction",
    "task_id": "brca_idc_ilc", "model_ver": "abmil-conch-brca-fold0-v1", "status": "queued",
}

_READY = {
    "status": "ready", "stage": "done", "progress": 1.0,
    "task_id": "brca_idc_ilc", "model_ver": "abmil-conch-brca-fold0-v1",
    "classes": ["IDC", "ILC"], "probs": [0.93, 0.07], "pred_index": 0, "pred_label": "IDC",
    "n_patches": 2731, "elapsed_ms": 118,
    "pred_hash": _PRED, "feat_hash": _FEAT,
    "prediction_ref": "/cache/item9/pred/pr1/prediction.json",
}

_DOC = {
    "task_id": "brca_idc_ilc", "pred_label": "IDC", "probs": [0.93, 0.07], "patch_px": 512,
    "coords": [0, 0, 512, 0], "attention": [0.5, 0.5], "evidence": [-0.4, 1.2],
}


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


#: The registry as `GET /tasks` serves it. `feature_spec` is the whole reason this route can plan:
#: it is the build the weights were fitted on, declared by the task rather than guessed at.
_SPEC = {"encoder": "conch_v1", "mag": 20, "patch_size": 512, "overlap": 0}
_TASK = {"id": "brca_idc_ilc", "label": "BRCA IDC vs ILC", "classes": ["IDC", "ILC"],
         "model_ver": "abmil-conch-brca-fold0-v1", "feature_spec": _SPEC}


@pytest.fixture(autouse=True)
def registry(monkeypatch):
    async def fake(*, base_url, **kw):
        return {"tasks": [_TASK], "available": True}
    monkeypatch.setattr(routes_mod, "list_tasks", fake)
    return fake


def _built(client, art_hash, kind, params=None, item=_ITEM):
    """Give the slide an artifact the way one really appears: a run reporting its bytes."""
    r = client.post(f"{_BASE}/slides/{item}/artifacts/{art_hash}/result",
                    json={"status": "ready", "kind": kind, "params": params or {}, "result": {}})
    assert r.status_code == 200
    return r.json()


# ── GET /tasks ──────────────────────────────────────────────────────────────────────


def test_tasks_proxies_the_worker_registry(client, monkeypatch):
    async def fake(*, base_url, **kw):
        return {"tasks": [{"id": "brca_idc_ilc", "classes": ["IDC", "ILC"]}], "available": True}
    monkeypatch.setattr(routes_mod, "list_tasks", fake)

    body = client.get(f"{_BASE}/tasks").json()
    assert body["available"] is True
    assert body["tasks"][0]["id"] == "brca_idc_ilc"


def test_tasks_reports_a_cpu_worker_as_unavailable(client, monkeypatch):
    async def fake(*, base_url, **kw):
        return {"tasks": [{"id": "brca_idc_ilc"}], "available": False}
    monkeypatch.setattr(routes_mod, "list_tasks", fake)

    # The registry still comes through — the panel renders the task card and explains itself.
    body = client.get(f"{_BASE}/tasks").json()
    assert body["available"] is False and len(body["tasks"]) == 1


def test_tasks_502s_when_the_worker_is_unreachable(client, monkeypatch):
    async def boom(*, base_url, **kw):
        raise httpx.ConnectError("no route to host")
    monkeypatch.setattr(routes_mod, "list_tasks", boom)

    assert client.get(f"{_BASE}/tasks").status_code == 502


def test_tasks_503s_when_preprocess_is_not_configured(art_store, monkeypatch):
    app = create_app()
    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[get_preprocess_artifact_store] = lambda: art_store
    app.dependency_overrides[get_preprocess_url] = lambda: None
    assert TestClient(app).get(f"{_BASE}/tasks").status_code == 503


# ── POST /slides/{item}/predict ─────────────────────────────────────────────────────


def test_a_named_feature_index_is_a_one_step_submission(client, plan_seam):
    seen = []
    plan_seam(seen=seen)

    r = client.post(f"{_BASE}/slides/{_ITEM}/predict",
                    json={"feat_hash": _FEAT, "task_id": "brca_idc_ilc"})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "prediction" and body["art_hash"] == _PRED
    assert [x["kind"] for x in body["steps"]] == ["prediction"]
    assert seen[0]["steps"][0]["params"]["feat_hash"] == _FEAT
    assert seen[0]["label"] == "BRCA IDC vs ILC"


def test_the_steps_above_a_named_index_are_never_even_addressed(client, plan_seam):
    """Naming an index asserts it exists. Reconstructing the segmentation params it happened to be
    built with would be work in service of a question nobody asked."""
    addressed = []
    plan_seam(addressed=addressed)

    client.post(f"{_BASE}/slides/{_ITEM}/predict",
                json={"feat_hash": _FEAT, "task_id": "brca_idc_ilc"})
    assert [kind for kind, _ in addressed] == ["prediction"]


def test_an_index_matching_the_task_spec_is_found_without_being_named(client, plan_seam):
    """What Inc 2c earned: the task declares the build its weights want, and the slide is searched
    for it. Nobody has to know which of four hashes on this slide is the right one."""
    seen = []
    plan_seam(seen=seen)
    _built(client, "pat-1", "patching", {"mag": 20, "patch_size": 512, "overlap": 0})
    _built(client, _FEAT, "features", {"encoder": "conch_v1", "patch_hash": "pat-1"})

    r = client.post(f"{_BASE}/slides/{_ITEM}/predict", json={"task_id": "brca_idc_ilc"})
    assert [x["kind"] for x in r.json()["steps"]] == ["prediction"]


def test_a_slide_with_nothing_built_reaches_a_call_in_one_submission(client, plan_seam):
    """The whole point of 07: four steps, one click, in order."""
    seen = []
    plan_seam(seen=seen)

    r = client.post(f"{_BASE}/slides/{_ITEM}/predict", json={"task_id": "brca_idc_ilc"})
    assert [x["kind"] for x in r.json()["steps"]] == [
        "segmentation", "patching", "features", "prediction"]
    # The tiling geometry comes off the task's declared spec, not off a default.
    tiling = next(x for x in seen[0]["steps"] if x["kind"] == "patching")
    assert tiling["params"]["patch_size"] == 512 and tiling["params"]["mag"] == 20


def test_an_index_the_task_was_not_fitted_on_is_not_used(client, plan_seam):
    """An ABMIL head fitted on CONCH will consume UNI vectors of the same width and return a
    confident number, and nothing downstream would say it was nonsense.

    The tiles underneath it *are* reused — they are the same 512 px at 20× either encoder reads,
    which is why encoding a second index over one patch grid is two steps and not four.
    """
    plan_seam()
    _built(client, "pat-1", "patching", {"mag": 20, "patch_size": 512, "overlap": 0})
    _built(client, "other", "features", {"encoder": "uni_v2", "patch_hash": "pat-1"})

    r = client.post(f"{_BASE}/slides/{_ITEM}/predict", json={"task_id": "brca_idc_ilc"})
    assert [x["kind"] for x in r.json()["steps"]] == ["features", "prediction"]


def test_a_build_planned_for_a_task_reuses_the_slides_own_segmentation(client, plan_seam):
    """A task says nothing about segmentation, correctly. But cutting a second set of contours over
    a slide that already has one is minutes of GPU spent arriving back where it started."""
    seen = []
    plan_seam(addressed=seen)
    _built(client, "seg-1", "segmentation", {"segmenter": "grandqc", "seg_conf_thresh": 0.7})

    client.post(f"{_BASE}/slides/{_ITEM}/predict", json={"task_id": "brca_idc_ilc"})
    assert seen[0] == ("segmentation", {"segmenter": "grandqc", "seg_conf_thresh": 0.7})


def test_predict_requires_a_task(client):
    assert client.post(f"{_BASE}/slides/{_ITEM}/predict", json={}).status_code == 422


def test_a_task_this_deployment_does_not_have_is_a_404(client, plan_seam):
    plan_seam()
    r = client.post(f"{_BASE}/slides/{_ITEM}/predict", json={"task_id": "nope"})
    assert r.status_code == 404 and "nope" in r.json()["detail"]


def test_a_prediction_that_already_exists_is_not_queued_again(client, plan_seam):
    seen = []
    plan_seam(seen=seen)
    _built(client, _PRED, "prediction", {"task_id": "brca_idc_ilc"})

    r = client.post(f"{_BASE}/slides/{_ITEM}/predict",
                    json={"feat_hash": _FEAT, "task_id": "brca_idc_ilc"})
    assert r.json()["status"] == "ready" and r.json()["steps"] == []
    assert seen == []


def test_a_refused_dispatch_writes_no_row(client, art_store, plan_seam, monkeypatch):
    plan_seam()

    async def refuse(**kw):
        raise routes_mod.DispatchUnavailable("no worker")

    monkeypatch.setattr(routes_mod, "dispatch_chain", refuse)
    r = client.post(f"{_BASE}/slides/{_ITEM}/predict",
                    json={"feat_hash": _FEAT, "task_id": "brca_idc_ilc"})
    assert r.status_code == 502
    assert art_store._rows == {}


def test_the_result_the_driver_reports_lands_in_the_result_column(client, plan_seam):
    """The summary the Workspace row reads. It arrives on the report now, not on a status poll."""
    plan_seam()
    client.post(f"{_BASE}/slides/{_ITEM}/predict",
                json={"feat_hash": _FEAT, "task_id": "brca_idc_ilc"})

    client.post(f"{_BASE}/slides/{_ITEM}/artifacts/{_PRED}/result", json={
        "status": "ready", "kind": "prediction",
        "params": {"task_id": "brca_idc_ilc", "feat_hash": _FEAT},
        "result": {"pred_label": "IDC", "probs": [0.93, 0.07], "n_patches": 2731,
                   "elapsed_ms": 118, "prediction_ref": "/cache/item9/pred/pr1/prediction.json"},
    })

    (row,) = client.get(f"{_BASE}/slides/{_ITEM}/artifacts").json()["artifacts"]
    assert row["kind"] == "prediction" and row["parent_hash"] == _FEAT
    assert row["n_items"] == 2731
    assert row["artifact_ref"].endswith("prediction.json")
    assert row["result"]["pred_label"] == "IDC"


# ── GET heatmap ─────────────────────────────────────────────────────────────────────


def test_heatmap_proxies_the_per_patch_arrays(client, monkeypatch):
    async def fake(*, base_url, item, pred_hash, **kw):
        assert (item, pred_hash) == (_ITEM, _PRED)
        return _DOC
    monkeypatch.setattr(routes_mod, "get_prediction", fake)

    doc = client.get(f"{_BASE}/slides/{_ITEM}/prediction/{_PRED}/heatmap").json()
    assert doc["evidence"] == [-0.4, 1.2]
    assert doc["patch_px"] == 512


def test_heatmap_404s_for_an_unknown_hash(client, monkeypatch):
    async def fake(*, base_url, item, pred_hash, **kw):
        return None
    monkeypatch.setattr(routes_mod, "get_prediction", fake)

    r = client.get(f"{_BASE}/slides/{_ITEM}/prediction/nope/heatmap")
    assert r.status_code == 404


def test_heatmap_502s_when_the_worker_is_unreachable(client, monkeypatch):
    async def boom(*, base_url, item, pred_hash, **kw):
        raise httpx.ConnectError("no route to host")
    monkeypatch.setattr(routes_mod, "get_prediction", boom)

    assert client.get(f"{_BASE}/slides/{_ITEM}/prediction/{_PRED}/heatmap").status_code == 502
