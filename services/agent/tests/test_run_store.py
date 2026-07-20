"""Run + artifact persistence (increment 5).

A run is the mutable execution record of a frozen, approved plan; the artifacts it
produces are fetched by (run_id, key), owner-scoped via the conversation.
"""

async def _conv(store):
    c = await store.create_conversation(user="u1", item="slideA", title=None)
    return c["id"]


async def test_create_run_starts_running(store):
    cid = await _conv(store)
    run = await store.create_run(conversation_id=cid, plan_digest="abc123")
    assert run["status"] == "RUNNING"
    assert run["plan_digest"] == "abc123"
    assert run["conversation_id"] == cid
    assert isinstance(run["id"], int)


async def test_finish_run_stores_result_and_artifacts(store):
    cid = await _conv(store)
    run = await store.create_run(conversation_id=cid, plan_digest="abc123")
    nuclei = {"kind": "nuclei", "geometry": "points", "points": [[1, 2], [3, 4]], "count": 2}
    done = await store.finish_run(
        run_id=run["id"], status="DONE",
        result={"count": 2, "density": 1.5}, artifacts={"nuclei": nuclei},
    )
    assert done["status"] == "DONE"
    assert done["result"]["count"] == 2
    got = await store.get_artifact(conversation_id=cid, run_id=run["id"], key="nuclei")
    assert got == nuclei


async def test_get_artifact_unknown_key_is_none(store):
    cid = await _conv(store)
    run = await store.create_run(conversation_id=cid, plan_digest="abc123")
    await store.finish_run(run_id=run["id"], status="DONE", result={}, artifacts={})
    assert await store.get_artifact(conversation_id=cid, run_id=run["id"], key="nuclei") is None


async def test_get_artifact_is_owner_scoped(store):
    cid = await _conv(store)
    run = await store.create_run(conversation_id=cid, plan_digest="abc123")
    await store.finish_run(
        run_id=run["id"], status="DONE", result={}, artifacts={"nuclei": {"count": 0}},
    )
    # A different conversation cannot fetch this run's artifact.
    other = await store.create_conversation(user="u1", item="slideB", title=None)
    assert await store.get_artifact(
        conversation_id=other["id"], run_id=run["id"], key="nuclei"
    ) is None


async def test_finish_run_can_fail(store):
    cid = await _conv(store)
    run = await store.create_run(conversation_id=cid, plan_digest="abc123")
    failed = await store.finish_run(
        run_id=run["id"], status="FAILED", result={}, artifacts={}, error="boom",
    )
    assert failed["status"] == "FAILED"
    assert failed["error"] == "boom"


# ── Content-addressed cache (increment 6b) ────────────────────────────────────────


async def _done_run(store, cid, digest="dig", count=5):
    run = await store.create_run(conversation_id=cid, plan_digest=digest)
    await store.finish_run(
        run_id=run["id"], status="DONE",
        result={"count": count}, artifacts={"nuclei": {"count": count}},
    )
    return run["id"]


async def test_get_cached_run_finds_latest_done_for_user_item_digest(store):
    cid = await _conv(store)
    await _done_run(store, cid, count=5)
    cached = await store.get_cached_run(user="u1", item="slideA", plan_digest="dig")
    assert cached is not None
    assert cached["result"]["count"] == 5
    assert cached["artifacts"]["nuclei"]["count"] == 5


async def test_get_cached_run_misses_on_other_digest_item_or_user(store):
    cid = await _conv(store)
    await _done_run(store, cid)
    assert await store.get_cached_run(user="u1", item="slideA", plan_digest="other") is None
    assert await store.get_cached_run(user="u1", item="slideB", plan_digest="dig") is None
    assert await store.get_cached_run(user="u2", item="slideA", plan_digest="dig") is None


async def test_get_cached_run_ignores_unfinished_runs(store):
    cid = await _conv(store)
    await store.create_run(conversation_id=cid, plan_digest="dig")   # RUNNING, never DONE
    assert await store.get_cached_run(user="u1", item="slideA", plan_digest="dig") is None


async def test_get_cached_run_reuses_across_conversations_on_the_same_slide(store):
    c1 = await _conv(store)
    await _done_run(store, c1, count=9)
    # A different conversation on the same slide (same user+item) sees the cached run.
    await store.create_conversation(user="u1", item="slideA", title=None)
    cached = await store.get_cached_run(user="u1", item="slideA", plan_digest="dig")
    assert cached["result"]["count"] == 9
