"""Claim persistence (increment 6a).

A Claim is the durable, verified result of a run — persisted so it (and its overlay)
survives a page reload. Claims are conversation-scoped, like turns and plans.
Exercised against MemoryStore; the PgStore path is covered by the in-container probe.
"""


async def _conv(store):
    c = await store.create_conversation(user="u1", item="slideA", title=None)
    return c["id"]


def _claim(run_id: int, value: int = 154) -> dict:
    return {
        "plan_digest": "abc123", "subject": "inflammatory", "predicate": "count",
        "value": value, "unit": "cells",
        "scope": {"item_id": "slideA", "roi": {"x": 1, "y": 2, "width": 3, "height": 4}},
        "metrics": {"count": value, "density": 11503.0, "density_unit": "cells/mm²"},
        "evidence": [{"run_id": run_id, "key": "nuclei"}],
        "method_versions": {"tools": ["nuclei_segment_stub", "count_within_roi"],
                            "registry_version": "regv1"},
        "status": "asserted",
    }


async def test_create_claim_persists_the_assertion(store):
    cid = await _conv(store)
    run = await store.create_run(conversation_id=cid, plan_digest="abc123")
    saved = await store.create_claim(
        conversation_id=cid, run_id=run["id"], claim=_claim(run["id"])
    )
    assert isinstance(saved["id"], int)
    assert saved["conversation_id"] == cid
    assert saved["run_id"] == run["id"]
    assert saved["value"] == 154
    assert saved["metrics"]["density"] == 11503.0
    assert saved["evidence"] == [{"run_id": run["id"], "key": "nuclei"}]


async def test_get_claims_returns_them_in_order(store):
    cid = await _conv(store)
    run = await store.create_run(conversation_id=cid, plan_digest="abc123")
    await store.create_claim(conversation_id=cid, run_id=run["id"], claim=_claim(run["id"], 10))
    await store.create_claim(conversation_id=cid, run_id=run["id"], claim=_claim(run["id"], 20))
    claims = await store.get_claims(conversation_id=cid)
    assert [c["value"] for c in claims] == [10, 20]


async def test_claims_are_conversation_scoped(store):
    cid = await _conv(store)
    run = await store.create_run(conversation_id=cid, plan_digest="abc123")
    await store.create_claim(conversation_id=cid, run_id=run["id"], claim=_claim(run["id"]))
    other = await store.create_conversation(user="u1", item="slideB", title=None)
    assert await store.get_claims(conversation_id=other["id"]) == []
