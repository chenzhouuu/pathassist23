"""Increment 4 — plan persistence contract, exercised against MemoryStore.

The tricky logic lives here: a turn now yields an id (so a plan can bind to it), a new
plan expires any prior live plan (one live plan per conversation), and state transitions
are guarded (you cannot approve a plan that is not awaiting approval). PgStore's SQL is
verified separately against real Postgres in-container.
"""

_STEPS = [
    {"n": 1, "tool": "nuclei_segment_stub", "args": {"mpp": 0.25}},
    {"n": 2, "tool": "count_within_roi", "args": {"cell_class": "lymphocyte"}},
]


async def _conv(store):
    c = await store.create_conversation(user="u1", item="s", title=None)
    return c["id"]


async def _mkplan(store, cid, turn_id, digest):
    return await store.create_plan(
        conversation_id=cid, turn_id=turn_id, digest=digest, steps=_STEPS,
        scope={"item_id": "s", "roi": None}, envelope={"tools": 2}, reason="why",
    )


async def test_add_turn_returns_id_and_get_turns_exposes_it(store):
    cid = await _conv(store)
    tid = await store.add_turn(conversation_id=cid, role="user", content="count cells")
    assert isinstance(tid, int)
    turns = await store.get_turns(conversation_id=cid)
    assert turns[0]["id"] == tid


async def test_create_plan_starts_awaiting_and_binds_turn(store):
    cid = await _conv(store)
    tid = await store.add_turn(conversation_id=cid, role="user", content="count")
    p = await _mkplan(store, cid, tid, "d1")
    assert p["state"] == "AWAITING_APPROVAL"
    assert p["digest"] == "d1"
    assert p["turn_id"] == tid
    assert [pp["digest"] for pp in await store.get_plans(conversation_id=cid)] == ["d1"]


async def test_new_plan_expires_prior_live_plan(store):
    cid = await _conv(store)
    await _mkplan(store, cid, None, "d1")
    await _mkplan(store, cid, None, "d2")
    states = {p["digest"]: p["state"] for p in await store.get_plans(conversation_id=cid)}
    assert states == {"d1": "EXPIRED", "d2": "AWAITING_APPROVAL"}


async def test_approve_transitions_from_awaiting(store):
    cid = await _conv(store)
    await _mkplan(store, cid, None, "d1")
    updated = await store.set_plan_state(
        conversation_id=cid, digest="d1", state="APPROVED", expected=("AWAITING_APPROVAL",)
    )
    assert updated is not None and updated["state"] == "APPROVED"


async def test_cannot_reject_an_approved_plan(store):
    cid = await _conv(store)
    await _mkplan(store, cid, None, "d1")
    await store.set_plan_state(
        conversation_id=cid, digest="d1", state="APPROVED", expected=("AWAITING_APPROVAL",)
    )
    # expected=AWAITING but it is APPROVED → refused (None), and it stays APPROVED
    res = await store.set_plan_state(
        conversation_id=cid, digest="d1", state="REJECTED", expected=("AWAITING_APPROVAL",)
    )
    assert res is None
    assert (await store.get_plan(conversation_id=cid, digest="d1"))["state"] == "APPROVED"


async def test_get_plan_unknown_digest_is_none(store):
    cid = await _conv(store)
    assert await store.get_plan(conversation_id=cid, digest="nope") is None
