import pytest

from agent.store import MemoryPreprocessArtifactStore


@pytest.fixture
def store():
    return MemoryPreprocessArtifactStore()


async def test_upsert_creates_then_resets_in_place(store):
    a = await store.upsert_artifact(
        item="i", kind="segmentation", art_hash="s1", parent_hash=None,
        params={"segmenter": "hest", "seg_conf_thresh": 0.5}, job_id="j1",
    )
    assert a["kind"] == "segmentation" and a["parent_hash"] is None and a["status"] == "queued"
    assert a["params"]["segmenter"] == "hest" and a["job_id"] == "j1"
    # same (item, art_hash) → same row, reset for a fresh build (unique key)
    b = await store.upsert_artifact(
        item="i", kind="segmentation", art_hash="s1", parent_hash=None,
        params={"segmenter": "hest"}, job_id="j2",
    )
    assert b["job_id"] == "j2"
    assert len(await store.list_artifacts(item="i")) == 1


async def test_parent_hash_links_the_dag(store):
    await store.upsert_artifact(
        item="i", kind="segmentation", art_hash="s1", parent_hash=None, params={},
    )
    await store.upsert_artifact(
        item="i", kind="patching", art_hash="p1", parent_hash="s1", params={"mag": 20},
    )
    await store.upsert_artifact(
        item="i", kind="features", art_hash="f1", parent_hash="p1", params={"encoder": "conch_v1"},
    )
    rows = {r["art_hash"]: r for r in await store.list_artifacts(item="i")}
    assert rows["p1"]["parent_hash"] == "s1" and rows["f1"]["parent_hash"] == "p1"


async def test_set_status_reconciles_to_ready_with_counts(store):
    await store.upsert_artifact(
        item="i", kind="features", art_hash="f", parent_hash="p", params={"encoder": "conch_v1"},
    )
    await store.set_status(
        item="i", art_hash="f", status="ready", progress=1.0, n_items=6290, dim=512,
        artifact_ref="/cache/i/feat/f/features.h5",
    )
    got = await store.get_artifact(item="i", art_hash="f")
    assert got["status"] == "ready" and got["n_items"] == 6290 and got["dim"] == 512
    assert got["artifact_ref"].endswith("features.h5") and got["progress"] == 1.0


async def test_set_status_failed_carries_error(store):
    await store.upsert_artifact(
        item="i", kind="segmentation", art_hash="s", parent_hash=None, params={},
    )
    await store.set_status(item="i", art_hash="s", status="failed", error="no slide file")
    got = await store.get_artifact(item="i", art_hash="s")
    assert got["status"] == "failed" and got["error"] == "no slide file"


async def test_list_artifacts_newest_first_and_scoped_by_item(store):
    for h in ("a", "b"):
        await store.upsert_artifact(
            item="i", kind="segmentation", art_hash=h, parent_hash=None, params={},
        )
    await store.upsert_artifact(
        item="other", kind="segmentation", art_hash="x", parent_hash=None, params={},
    )
    got = await store.list_artifacts(item="i")
    assert [g["art_hash"] for g in got] == ["b", "a"]  # newest first


async def test_get_missing_is_none(store):
    assert await store.get_artifact(item="nope", art_hash="nope") is None


# ── the prediction kind + its result column (Inc 2c) ────────────────────────────────


async def _predict_row(store):
    return await store.upsert_artifact(
        item="i", kind="prediction", art_hash="pr1", parent_hash="f1",
        params={"task_id": "brca_idc_ilc", "model_ver": "abmil-conch-brca-fold0-v1"},
        job_id="j4",
    )


async def test_a_new_prediction_row_starts_with_no_result(store):
    row = await _predict_row(store)
    assert row["kind"] == "prediction" and row["parent_hash"] == "f1"
    assert row["result"] is None


async def test_set_status_stores_the_prediction_summary(store):
    await _predict_row(store)
    await store.set_status(
        item="i", art_hash="pr1", status="ready", stage="done", progress=1.0, n_items=2731,
        artifact_ref="/cache/i/pred/pr1/prediction.json",
        result={"pred_label": "IDC", "probs": [0.93, 0.07], "elapsed_ms": 118},
    )
    row = await store.get_artifact(item="i", art_hash="pr1")
    assert row["result"]["pred_label"] == "IDC" and row["n_items"] == 2731
    assert row["artifact_ref"].endswith("prediction.json")


async def test_set_status_leaves_an_existing_result_alone_when_omitted(store):
    await _predict_row(store)
    await store.set_status(
        item="i", art_hash="pr1", status="ready", result={"pred_label": "IDC"},
    )
    await store.set_status(item="i", art_hash="pr1", status="running", progress=0.5)
    row = await store.get_artifact(item="i", art_hash="pr1")
    assert row["result"] == {"pred_label": "IDC"} and row["status"] == "running"


async def test_rebuilding_clears_the_previous_result(store):
    await _predict_row(store)
    await store.set_status(item="i", art_hash="pr1", status="ready", result={"pred_label": "IDC"})
    again = await _predict_row(store)
    assert again["status"] == "queued" and again["result"] is None


async def test_the_result_is_copied_not_aliased(store):
    await _predict_row(store)
    payload = {"probs": [0.93, 0.07]}
    await store.set_status(item="i", art_hash="pr1", status="ready", result=payload)
    payload["probs"] = [0.0, 1.0]
    row = await store.get_artifact(item="i", art_hash="pr1")
    assert row["result"]["probs"] == [0.93, 0.07]


async def test_the_prediction_extends_the_dag_chain(store):
    for kind, h, parent in (
        ("segmentation", "s1", None), ("patching", "p1", "s1"),
        ("features", "f1", "p1"), ("prediction", "pr1", "f1"),
    ):
        await store.upsert_artifact(
            item="i", kind=kind, art_hash=h, parent_hash=parent, params={},
        )
    rows = {r["art_hash"]: r for r in await store.list_artifacts(item="i")}
    assert rows["pr1"]["parent_hash"] == "f1"
    assert [rows[h]["kind"] for h in ("s1", "p1", "f1", "pr1")] == [
        "segmentation", "patching", "features", "prediction",
    ]
