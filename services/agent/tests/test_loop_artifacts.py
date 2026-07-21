"""R9 — artifacts as handles (D4).

A server tool's bulk output (dense nuclei geometry) is written to an ArtifactStore, which
returns a light **handle** — kind/ref/bbox/count/summary/size, never the geometry. The
event stream and the model's context carry only the handle; the client fetches the bytes
out-of-band by `ref`. R9 ships an in-memory stub; the Girder DSA-annotation store swaps in
behind this seam at R10/R11.
"""

from agent.loop.artifacts import ArtifactHandle, InMemoryArtifactStore


async def test_put_returns_a_handle_carrying_no_geometry():
    store = InMemoryArtifactStore()
    handle = await store.put(
        owner="u1", conversation_id=1, kind="nuclei",
        bbox={"x": 0, "y": 0, "width": 10, "height": 10},
        geometry={"points": [[1, 2], [3, 4]]}, summary="2 nuclei",
    )
    assert isinstance(handle, ArtifactHandle)
    assert handle.kind == "nuclei" and handle.ref and handle.count == 2
    assert handle.summary == "2 nuclei"
    assert handle.bbox == {"x": 0, "y": 0, "width": 10, "height": 10}
    # the handle is a reference, not a payload — no geometry field on it
    assert "points" not in handle.to_dict() and "geometry" not in handle.to_dict()


async def test_geometry_is_fetchable_by_ref_for_the_owner_only():
    store = InMemoryArtifactStore()
    handle = await store.put(
        owner="u1", conversation_id=1, kind="nuclei", bbox=None,
        geometry={"kind": "nuclei", "points": [[1, 2]]}, summary="1 nucleus",
    )
    got = await store.get(owner="u1", ref=handle.ref)
    assert got["points"] == [[1, 2]]
    assert await store.get(owner="intruder", ref=handle.ref) is None  # owner-scoped
    assert await store.get(owner="u1", ref="no-such-ref") is None


async def test_refs_are_unguessable_and_unique():
    store = InMemoryArtifactStore()
    a = await store.put(owner="u1", conversation_id=1, kind="nuclei", bbox=None,
                        geometry={"points": []}, summary="0")
    b = await store.put(owner="u1", conversation_id=1, kind="nuclei", bbox=None,
                        geometry={"points": []}, summary="0")
    assert a.ref != b.ref and len(a.ref) >= 16


async def test_put_and_get_accept_item_id_and_token_kwargs():
    # The seam is uniform: callers always pass item_id/token; the in-memory store ignores them.
    store = InMemoryArtifactStore()
    handle = await store.put(
        owner="u1", conversation_id=1, kind="nuclei", bbox=None,
        geometry={"kind": "nuclei", "points": [[1, 2]]}, summary="1 nucleus",
        item_id="item9", token="tok",
    )
    got = await store.get(owner="u1", ref=handle.ref, token="tok")
    assert got["points"] == [[1, 2]]
    assert await store.get(owner="intruder", ref=handle.ref, token="tok") is None
