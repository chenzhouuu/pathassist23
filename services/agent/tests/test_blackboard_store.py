"""Case blackboard (increment 6c).

The blackboard is the per (user, slide) set of *deduped current facts*: for each
(subject, predicate) it keeps only the most recent Claim's value — the projected
"what we currently believe about this slide", distinct from the append-only Claim log.
It aggregates across ALL of the user's conversations on the slide (per-slide scope,
matching the cache). Derived from claims, not stored. Exercised against MemoryStore;
the PgStore query is covered by the in-container probe.
"""


async def _conv(store, item="slideA"):
    c = await store.create_conversation(user="u1", item=item, title=None)
    return c["id"]


def _claim(run_id: int, *, subject="inflammatory", predicate="count", value=154) -> dict:
    return {
        "plan_digest": "abc123", "subject": subject, "predicate": predicate,
        "value": value, "unit": "cells",
        "scope": {"item_id": "slideA", "roi": {"x": 1, "y": 2, "width": 3, "height": 4}},
        "metrics": {"count": value, "density": 11503.0, "density_unit": "cells/mm²"},
        "evidence": [{"run_id": run_id, "key": "nuclei"}],
        "method_versions": {"tools": ["nuclei_segment_stub"], "registry_version": "regv1"},
        "status": "asserted",
    }


async def _assert_claim(store, cid, *, subject="inflammatory", predicate="count", value=154):
    """Emulate a completed run that produces one Claim; returns its run_id."""
    run = await store.create_run(conversation_id=cid, plan_digest="abc123")
    await store.finish_run(
        run_id=run["id"], status="DONE",
        result={"count": value}, artifacts={"nuclei": {"count": value}},
    )
    await store.create_claim(
        conversation_id=cid, run_id=run["id"],
        claim=_claim(run["id"], subject=subject, predicate=predicate, value=value),
    )
    return run["id"]


async def test_blackboard_keeps_only_latest_per_subject_predicate(store):
    cid = await _conv(store)
    await _assert_claim(store, cid, value=10)
    await _assert_claim(store, cid, value=20)   # same (subject, predicate) → supersedes
    bb = await store.get_blackboard(user="u1", item="slideA")
    assert len(bb) == 1
    assert (bb[0]["subject"], bb[0]["predicate"]) == ("inflammatory", "count")
    assert bb[0]["value"] == 20


async def test_blackboard_keeps_distinct_subjects_as_separate_facts(store):
    cid = await _conv(store)
    await _assert_claim(store, cid, subject="inflammatory", value=20)
    await _assert_claim(store, cid, subject="tumor", value=44)
    bb = await store.get_blackboard(user="u1", item="slideA")
    assert {f["subject"] for f in bb} == {"inflammatory", "tumor"}


async def test_blackboard_aggregates_across_conversations_on_same_slide(store):
    c1 = await _conv(store)
    await _assert_claim(store, c1, subject="inflammatory", value=20)
    c2 = await _conv(store)   # same user, same slideA, different thread
    await _assert_claim(store, c2, subject="tumor", value=44)
    bb = await store.get_blackboard(user="u1", item="slideA")
    assert len(bb) == 2


async def test_blackboard_is_scoped_per_user_and_slide(store):
    cid = await _conv(store)
    await _assert_claim(store, cid, value=20)
    assert await store.get_blackboard(user="u1", item="slideB") == []
    assert await store.get_blackboard(user="u2", item="slideA") == []


async def test_blackboard_is_empty_without_claims(store):
    await _conv(store)
    assert await store.get_blackboard(user="u1", item="slideA") == []


async def test_blackboard_fact_carries_source_and_evidence(store):
    cid = await _conv(store)
    rid = await _assert_claim(store, cid, value=20)
    fact = (await store.get_blackboard(user="u1", item="slideA"))[0]
    assert fact["run_id"] == rid
    assert fact["conversation_id"] == cid
    assert fact["evidence"] == [{"run_id": rid, "key": "nuclei"}]
    assert fact["scope"]["roi"] == {"x": 1, "y": 2, "width": 3, "height": 4}
    assert fact["metrics"]["density"] == 11503.0
