"""Gateway control plane for the downstream-task stage (Inc 2c).

The prediction is a fourth DAG node: one job → one ``preprocess_artifact`` row of
``kind='prediction'`` parented on its feature index, whose summary lands in the new ``result``
column. Per-patch arrays never touch the row — they come from the heatmap proxy.
"""

import httpx
import pytest
from starlette.testclient import TestClient

from agent.gateway import routes as routes_mod
from agent.gateway.app import create_app
from agent.gateway.auth import require_user
from agent.gateway.routes import get_preprocess_artifact_store, get_preprocess_url
from agent.store import MemoryPreprocessArtifactStore

_USER = {"_id": "u1", "login": "tester"}
_BASE = "/api/copilot"
_ITEM = "item9"
_FEAT, _PRED = "f1", "pr1"

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
    return TestClient(app)


def _ok_predict(ack=None):
    async def trigger(*, base_url, stage, item, params, token):
        assert stage == "predict"
        return ack or _ACK
    return trigger


def _refuse(code, detail):
    req = httpx.Request("POST", "http://preprocess:8030/predict")
    resp = httpx.Response(code, json={"detail": detail}, request=req)

    async def trigger(*, base_url, stage, item, params, token):
        raise httpx.HTTPStatusError("refused", request=req, response=resp)
    return trigger


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


def test_predict_records_a_prediction_row_parented_on_the_features(client, art_store, monkeypatch):
    monkeypatch.setattr(routes_mod, "trigger_stage", _ok_predict())

    r = client.post(
        f"{_BASE}/slides/{_ITEM}/predict", json={"feat_hash": _FEAT, "task_id": "brca_idc_ilc"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "prediction"
    assert body["art_hash"] == _PRED and body["parent_hash"] == _FEAT
    assert body["status"] == "queued" and body["job_id"] == "j4"
    assert body["params"] == {
        "task_id": "brca_idc_ilc", "model_ver": "abmil-conch-brca-fold0-v1",
    }
    assert body["result"] is None
    assert (_ITEM, _PRED) in art_store._rows


def test_predict_requires_both_fields(client):
    for payload in ({}, {"feat_hash": _FEAT}, {"task_id": "brca_idc_ilc"}):
        r = client.post(f"{_BASE}/slides/{_ITEM}/predict", json=payload)
        assert r.status_code == 422


def test_predict_forwards_the_workers_409_for_missing_features(client, monkeypatch):
    monkeypatch.setattr(
        routes_mod, "trigger_stage", _refuse(409, "extract features for this slide first")
    )
    r = client.post(
        f"{_BASE}/slides/{_ITEM}/predict", json={"feat_hash": _FEAT, "task_id": "brca_idc_ilc"}
    )
    assert r.status_code == 409
    assert "extract features" in r.json()["detail"]


def test_predict_forwards_the_workers_503_for_a_cpu_image(client, monkeypatch):
    monkeypatch.setattr(
        routes_mod, "trigger_stage", _refuse(503, "this preprocess image ships without torch")
    )
    r = client.post(
        f"{_BASE}/slides/{_ITEM}/predict", json={"feat_hash": _FEAT, "task_id": "brca_idc_ilc"}
    )
    # Not a 502: the panel must be able to tell "no GPU worker" from "gateway broke".
    assert r.status_code == 503
    assert "torch" in r.json()["detail"]


def test_predict_forwards_the_workers_404_for_an_unknown_task(client, monkeypatch):
    monkeypatch.setattr(routes_mod, "trigger_stage", _refuse(404, "unknown task 'nope'"))
    r = client.post(f"{_BASE}/slides/{_ITEM}/predict", json={"feat_hash": _FEAT, "task_id": "nope"})
    assert r.status_code == 404


def test_predict_502s_on_an_unexpected_worker_error(client, monkeypatch):
    monkeypatch.setattr(routes_mod, "trigger_stage", _refuse(500, "boom"))
    r = client.post(
        f"{_BASE}/slides/{_ITEM}/predict", json={"feat_hash": _FEAT, "task_id": "brca_idc_ilc"}
    )
    assert r.status_code == 502


def test_a_refusal_writes_no_artifact_row(client, art_store, monkeypatch):
    monkeypatch.setattr(routes_mod, "trigger_stage", _refuse(503, "no torch"))
    client.post(
        f"{_BASE}/slides/{_ITEM}/predict", json={"feat_hash": _FEAT, "task_id": "brca_idc_ilc"}
    )
    assert art_store._rows == {}


# ── reconciliation into `result` ────────────────────────────────────────────────────


def _queue_prediction(client, monkeypatch):
    monkeypatch.setattr(routes_mod, "trigger_stage", _ok_predict())
    client.post(
        f"{_BASE}/slides/{_ITEM}/predict", json={"feat_hash": _FEAT, "task_id": "brca_idc_ilc"}
    )


def test_a_ready_prediction_lands_its_summary_in_the_result_column(client, monkeypatch):
    _queue_prediction(client, monkeypatch)

    async def status(*, base_url, job_id, **kw):
        return _READY
    monkeypatch.setattr(routes_mod, "get_job_status", status)

    (row,) = client.get(f"{_BASE}/slides/{_ITEM}/artifacts").json()["artifacts"]
    assert row["status"] == "ready" and row["n_items"] == 2731
    assert row["artifact_ref"].endswith("prediction.json")
    assert row["result"]["pred_label"] == "IDC"
    assert row["result"]["probs"] == [0.93, 0.07]
    assert row["result"]["elapsed_ms"] == 118


def test_the_result_column_never_carries_per_patch_arrays(client, monkeypatch):
    _queue_prediction(client, monkeypatch)

    async def status(*, base_url, job_id, **kw):
        return {**_READY, "coords": [0, 0], "attention": [1.0], "evidence": [0.5]}
    monkeypatch.setattr(routes_mod, "get_job_status", status)

    (row,) = client.get(f"{_BASE}/slides/{_ITEM}/artifacts").json()["artifacts"]
    for key in ("coords", "attention", "evidence"):
        assert key not in row["result"]


def test_a_failed_prediction_records_the_error_and_no_result(client, monkeypatch):
    _queue_prediction(client, monkeypatch)

    async def status(*, base_url, job_id, **kw):
        return {"status": "failed", "error": "weights for 'brca_idc_ilc' not found"}
    monkeypatch.setattr(routes_mod, "get_job_status", status)

    (row,) = client.get(f"{_BASE}/slides/{_ITEM}/artifacts").json()["artifacts"]
    assert row["status"] == "failed" and "weights" in row["error"]
    assert row["result"] is None


def test_a_features_row_is_not_given_a_result(client, art_store, monkeypatch):
    # Only kind='prediction' has an outcome; a features build stays a pointer.
    async def fake_features(*, base_url, stage, item, params, token):
        return {
            "job_id": "j5", "feat_hash": _FEAT, "patch_hash": "p1", "encoder": "conch_v1",
            "kind": "features", "status": "queued",
        }
    monkeypatch.setattr(routes_mod, "trigger_stage", fake_features)
    client.post(f"{_BASE}/slides/{_ITEM}/features", json={"patch_hash": "p1"})

    async def status(*, base_url, job_id, **kw):
        return {**_READY, "features_ref": "/cache/features.h5"}
    monkeypatch.setattr(routes_mod, "get_job_status", status)

    (row,) = client.get(f"{_BASE}/slides/{_ITEM}/artifacts").json()["artifacts"]
    assert row["kind"] == "features" and row["result"] is None


def test_rerunning_a_prediction_clears_the_previous_result(client, art_store, monkeypatch):
    _queue_prediction(client, monkeypatch)

    async def status(*, base_url, job_id, **kw):
        return _READY
    monkeypatch.setattr(routes_mod, "get_job_status", status)
    client.get(f"{_BASE}/slides/{_ITEM}/artifacts")
    assert art_store._rows[(_ITEM, _PRED)]["result"]["pred_label"] == "IDC"

    _queue_prediction(client, monkeypatch)      # upsert resets the row to a fresh build
    row = art_store._rows[(_ITEM, _PRED)]
    assert row["status"] == "queued" and row["result"] is None


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
