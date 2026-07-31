"""Worker HTTP for the downstream-task stage (Inc 2c).

``torch_available`` is patched explicitly in every test so the suite behaves identically on a CPU
box and on a GPU box; the actual model runs behind the injectable ``PREDICT`` seam, exactly like
``PIPELINE`` / ``FIND_REGIONS``.
"""

import json

import numpy as np
import pytest

from preprocess_service.artifacts import feat_paths, write_features_h5
from preprocess_service.predict import PredictResult, pred_hash, pred_paths

FEAT_HASH = "abcdef0123456789"
ITEM = "item123"
TASK = "brca_idc_ilc"
MODEL_VER = "abmil-conch-brca-fold0-v1"


@pytest.fixture
def cache(tmp_path):
    return tmp_path / "cache"


@pytest.fixture
def with_features(cache):
    """Put a features.h5 where /predict will look for it."""
    path = feat_paths(cache, ITEM, FEAT_HASH)["features"]
    coords = np.array([[0, 0], [512, 0], [0, 512]], dtype=np.int64)
    write_features_h5(
        path, np.zeros((3, 512), dtype=np.float32), coords,
        {"patch_size_level0": 512, "target_magnification": 20},
    )
    return path


def fake_result(n=3):
    return PredictResult(
        task_id=TASK, model_ver=MODEL_VER, classes=["IDC", "ILC"],
        probs=[0.93, 0.07], pred_index=0, n_patches=n, patch_px=512, elapsed_ms=7,
        coords=np.arange(n * 2, dtype=np.int64).reshape(n, 2),
        attention=np.full(n, 1.0 / n), evidence=np.linspace(-1.0, 1.0, n),
    )


@pytest.fixture
def gpu(client, monkeypatch):
    """A client whose image claims torch and whose model is a deterministic double."""
    monkeypatch.setattr("preprocess_service.app.torch_available", lambda: True)
    calls = []

    def _predict(task, features_path, weights_root):
        calls.append((task.id, features_path, weights_root))
        return fake_result()

    client.application.config["PREDICT"] = _predict
    client.calls = calls
    return client


# ── GET /tasks ──────────────────────────────────────────────────────────────────────


def test_tasks_lists_the_registry(client):
    body = client.get("/tasks").get_json()
    (task,) = body["tasks"]
    assert task["id"] == TASK
    assert task["classes"] == ["IDC", "ILC"]
    assert task["feature_spec"] == {
        "encoder": "conch_v1", "mag": 20, "patch_size": 256, "overlap": 0,
    }


def test_tasks_reports_whether_this_image_can_actually_run_one(client, monkeypatch):
    monkeypatch.setattr("preprocess_service.app.torch_available", lambda: False)
    assert client.get("/tasks").get_json()["available"] is False
    monkeypatch.setattr("preprocess_service.app.torch_available", lambda: True)
    assert client.get("/tasks").get_json()["available"] is True


def test_tasks_is_served_even_without_torch(client, monkeypatch):
    # The panel must be able to render the task card (cohort, metrics, caveat) on a CPU
    # deployment rather than showing a dead tab.
    monkeypatch.setattr("preprocess_service.app.torch_available", lambda: False)
    assert len(client.get("/tasks").get_json()["tasks"]) == 1


# ── POST /predict — refusals ────────────────────────────────────────────────────────


@pytest.mark.parametrize("body", [
    {}, {"item": ITEM}, {"item": ITEM, "feat_hash": FEAT_HASH}, {"task_id": TASK},
])
def test_predict_requires_item_feat_hash_and_task(gpu, body):
    assert gpu.post("/predict", json=body).status_code == 400


def test_predict_404s_on_an_unknown_task(gpu):
    r = gpu.post("/predict", json={"item": ITEM, "feat_hash": FEAT_HASH, "task_id": "nope"})
    assert r.status_code == 404
    assert "unknown task" in r.get_json()["detail"]


def test_predict_503s_without_torch(client, monkeypatch, with_features):
    monkeypatch.setattr("preprocess_service.app.torch_available", lambda: False)
    r = client.post("/predict", json={"item": ITEM, "feat_hash": FEAT_HASH, "task_id": TASK})
    assert r.status_code == 503
    assert r.get_json()["reason"] == "no_torch"


def test_predict_503s_before_it_checks_for_features(client, monkeypatch):
    # No features exist here; the image capability is the more useful thing to report.
    monkeypatch.setattr("preprocess_service.app.torch_available", lambda: False)
    r = client.post("/predict", json={"item": ITEM, "feat_hash": FEAT_HASH, "task_id": TASK})
    assert r.status_code == 503


def test_predict_409s_when_the_parent_features_are_missing(gpu):
    r = gpu.post("/predict", json={"item": ITEM, "feat_hash": FEAT_HASH, "task_id": TASK})
    assert r.status_code == 409
    assert r.get_json()["feat_hash"] == FEAT_HASH


# ── POST /predict — the happy path ──────────────────────────────────────────────────


def test_predict_queues_a_job_keyed_by_the_content_hash(gpu, with_features, wait):
    r = gpu.post("/predict", json={"item": ITEM, "feat_hash": FEAT_HASH, "task_id": TASK})
    assert r.status_code == 202
    body = r.get_json()
    assert body["pred_hash"] == pred_hash(FEAT_HASH, TASK, MODEL_VER)
    assert (body["kind"], body["task_id"], body["status"]) == ("prediction", TASK, "queued")

    done = wait(gpu, body["job_id"], "ready")
    assert done["pred_label"] == "IDC"
    assert done["probs"] == [0.93, 0.07]
    assert done["n_patches"] == 3
    assert done["feat_hash"] == FEAT_HASH


def test_the_status_summary_carries_no_per_patch_arrays(gpu, with_features, wait):
    body = gpu.post(
        "/predict", json={"item": ITEM, "feat_hash": FEAT_HASH, "task_id": TASK},
    ).get_json()
    done = wait(gpu, body["job_id"], "ready")
    for key in ("coords", "attention", "evidence"):
        assert key not in done


def test_predict_writes_the_document_to_the_content_addressed_cache(
    gpu, with_features, wait, cache,
):
    body = gpu.post(
        "/predict", json={"item": ITEM, "feat_hash": FEAT_HASH, "task_id": TASK},
    ).get_json()
    wait(gpu, body["job_id"], "ready")

    path = pred_paths(cache, ITEM, body["pred_hash"])["prediction"]
    doc = json.loads(path.read_text())
    assert len(doc["attention"]) == len(doc["evidence"]) == 3
    assert doc["patch_px"] == 512


def test_predict_passes_the_configured_weights_root_to_the_model(gpu, with_features, wait):
    body = gpu.post(
        "/predict", json={"item": ITEM, "feat_hash": FEAT_HASH, "task_id": TASK},
    ).get_json()
    wait(gpu, body["job_id"], "ready")
    (task_id, features_path, weights_root) = gpu.calls[0]
    assert task_id == TASK
    assert features_path.name == "features.h5"
    assert str(weights_root).endswith("/weights/mil")


def test_an_identical_request_reuses_the_cached_document(gpu, with_features, wait):
    payload = {"item": ITEM, "feat_hash": FEAT_HASH, "task_id": TASK}
    first = gpu.post("/predict", json=payload).get_json()
    wait(gpu, first["job_id"], "ready")
    second = gpu.post("/predict", json=payload).get_json()
    done = wait(gpu, second["job_id"], "ready")

    assert second["pred_hash"] == first["pred_hash"]
    assert done["pred_label"] == "IDC"
    assert len(gpu.calls) == 1          # the model ran once; the second call read the cache


def test_a_failing_model_surfaces_as_a_failed_job_not_a_500(gpu, with_features, wait):
    def boom(task, features_path, weights_root):
        raise ValueError("checkpoint for 'brca_idc_ilc' has classifier of shape (3, 256)")

    gpu.application.config["PREDICT"] = boom
    body = gpu.post(
        "/predict", json={"item": ITEM, "feat_hash": FEAT_HASH, "task_id": TASK},
    ).get_json()
    done = wait(gpu, body["job_id"], "failed")
    assert done["status"] == "failed"
    assert "classifier" in done["error"]


# ── GET /prediction ─────────────────────────────────────────────────────────────────


def test_prediction_serves_the_per_patch_arrays(gpu, with_features, wait):
    body = gpu.post(
        "/predict", json={"item": ITEM, "feat_hash": FEAT_HASH, "task_id": TASK},
    ).get_json()
    wait(gpu, body["job_id"], "ready")

    doc = gpu.get(f"/prediction?item={ITEM}&pred_hash={body['pred_hash']}").get_json()
    assert doc["coords"] == [0, 1, 2, 3, 4, 5]
    assert doc["attention"] == pytest.approx([1 / 3] * 3)
    assert doc["evidence"] == pytest.approx([-1.0, 0.0, 1.0])
    assert doc["pred_label"] == "IDC"


def test_prediction_requires_both_args(gpu):
    assert gpu.get(f"/prediction?item={ITEM}").status_code == 400
    assert gpu.get("/prediction?pred_hash=deadbeefdeadbeef").status_code == 400


def test_prediction_404s_for_an_unknown_hash(gpu):
    r = gpu.get(f"/prediction?item={ITEM}&pred_hash=deadbeefdeadbeef")
    assert r.status_code == 404
