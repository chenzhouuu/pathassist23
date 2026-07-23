import pytest

from agent.store import MemorySlideIndexStore


@pytest.fixture
def store():
    return MemorySlideIndexStore()


async def test_upsert_creates_then_updates_in_place(store):
    a = await store.upsert_index(
        item="item1", params_hash="h1", encoder="conch_v1", mag=20,
        patch_size=256, segmenter="hest", job_id="j1",
    )
    assert a["status"] == "queued" and a["encoder"] == "conch_v1" and a["job_id"] == "j1"
    # same (item, params_hash) → same row, reset for a fresh build (unique key)
    b = await store.upsert_index(
        item="item1", params_hash="h1", encoder="conch_v1", mag=20,
        patch_size=256, segmenter="hest", job_id="j2",
    )
    assert b["job_id"] == "j2"
    assert len(await store.list_indexes(item="item1")) == 1


async def test_set_status_reconciles_to_ready(store):
    await store.upsert_index(
        item="i", params_hash="h", encoder="conch_v1", mag=20,
        patch_size=256, segmenter="hest",
    )
    await store.set_status(
        item="i", params_hash="h", status="ready", progress=1.0,
        n_patches=8412, feature_ref="/cache/i/h/features.h5",
    )
    idx = await store.get_index(item="i", params_hash="h")
    assert idx["status"] == "ready" and idx["n_patches"] == 8412
    assert idx["feature_ref"].endswith("features.h5") and idx["progress"] == 1.0


async def test_set_status_failed_carries_error(store):
    await store.upsert_index(
        item="i", params_hash="h", encoder="conch_v1", mag=20,
        patch_size=256, segmenter="hest",
    )
    await store.set_status(item="i", params_hash="h", status="failed", error="no slide file")
    idx = await store.get_index(item="i", params_hash="h")
    assert idx["status"] == "failed" and idx["error"] == "no slide file"


async def test_list_indexes_newest_first_and_scoped_by_item(store):
    for h in ("h1", "h2"):
        await store.upsert_index(
            item="i", params_hash=h, encoder="conch_v1", mag=20,
            patch_size=256, segmenter="hest",
        )
    await store.upsert_index(
        item="other", params_hash="hx", encoder="uni_v2", mag=20,
        patch_size=256, segmenter="hest",
    )
    got = await store.list_indexes(item="i")
    assert [g["params_hash"] for g in got] == ["h2", "h1"]  # newest first


async def test_get_missing_is_none(store):
    assert await store.get_index(item="nope", params_hash="nope") is None
