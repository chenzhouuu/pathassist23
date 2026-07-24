import json

import httpx
import pytest

from agent.loop.girder_annotations import GirderAnnotationStore


def _store(handler):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://g/api/v1")
    return GirderAnnotationStore("http://g/api/v1", client=client)


@pytest.mark.asyncio
async def test_put_posts_point_annotation_scoped_to_item_with_token():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["itemId"] = request.url.params.get("itemId")
        seen["token"] = request.headers.get("Girder-Token")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"_id": "ann123"})

    handle = await _store(handler).put(
        owner="u1", conversation_id=1, kind="nuclei",
        bbox={"x": 10, "y": 20, "width": 5, "height": 5},
        geometry={"kind": "nuclei", "count": 2, "points": [[10, 20], [11, 21]]},
        summary="2 nuclei", item_id="item9", token="tok",
    )

    assert handle.ref == "ann123"
    assert handle.kind == "nuclei" and handle.count == 2 and handle.summary == "2 nuclei"
    assert seen["method"] == "POST" and seen["path"] == "/api/v1/annotation"
    assert seen["itemId"] == "item9" and seen["token"] == "tok"  # D3: token server-side only
    assert seen["body"]["elements"][0] == {"type": "point", "center": [10.0, 20.0, 0]}
    assert len(seen["body"]["elements"]) == 2


@pytest.mark.asyncio
async def test_get_maps_point_elements_back_to_points():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/annotation/ann123"
        assert request.headers.get("Girder-Token") == "tok"
        return httpx.Response(200, json={
            "_id": "ann123",
            "annotation": {"name": "Copilot nuclei · 2", "elements": [
                {"type": "point", "center": [10.0, 20.0, 0]},
                {"type": "point", "center": [11.0, 21.0, 0]},
            ]},
        })

    got = await _store(handler).get(owner="u1", ref="ann123", token="tok")
    assert got == {"kind": "nuclei", "count": 2, "points": [[10.0, 20.0], [11.0, 21.0]],
                   "classes": [None, None]}  # elements carried no group


@pytest.mark.asyncio
async def test_get_returns_none_when_annotation_is_inaccessible():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"message": "Access denied"})

    assert await _store(handler).get(owner="u1", ref="nope", token="tok") is None


@pytest.mark.asyncio
async def test_get_returns_none_on_server_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"message": "boom"})

    assert await _store(handler).get(owner="u1", ref="x", token="tok") is None


@pytest.mark.asyncio
async def test_get_returns_none_on_transport_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("girder unreachable")

    assert await _store(handler).get(owner="u1", ref="x", token="tok") is None


@pytest.mark.asyncio
async def test_get_is_defensive_about_malformed_elements():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"annotation": {"elements": [
            {"type": "point", "center": [1.0, 2.0, 0]},
            {"type": "polygon", "points": [[0, 0]]},   # non-point → skipped
            {"type": "point", "center": [5]},          # too short → skipped
            {"type": "point"},                          # no center → skipped
        ]}})

    got = await _store(handler).get(owner="u1", ref="x", token="tok")
    assert got == {"kind": "nuclei", "count": 1, "points": [[1.0, 2.0]], "classes": [None]}


@pytest.mark.asyncio
async def test_put_raises_on_write_failure_so_caller_can_degrade():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"message": "read-only"})

    with pytest.raises(httpx.HTTPStatusError):
        await _store(handler).put(
            owner="u1", conversation_id=1, kind="nuclei", bbox=None,
            geometry={"kind": "nuclei", "count": 1, "points": [[1, 2]]},
            summary="1", item_id="item9", token="tok")


@pytest.mark.asyncio
async def test_put_tags_group_and_linecolor_per_element():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"_id": "ann1"})

    await _store(handler).put(
        owner="u1", conversation_id=1, kind="nuclei",
        bbox={"x": 0, "y": 0, "width": 5, "height": 5},
        geometry={"kind": "nuclei", "count": 2, "points": [[1, 2], [3, 4]],
                  "classes": ["Neoplastic", "Inflammatory"]},
        summary="2 nuclei", item_id="item9", token="tok",
    )
    els = seen["body"]["elements"]
    assert els[0] == {"type": "point", "center": [1.0, 2.0, 0],
                      "group": "Neoplastic", "lineColor": "#ff0000"}
    assert els[1]["group"] == "Inflammatory" and els[1]["lineColor"] == "#22dd4d"
    # Regression guard: NO top-level "groups" — the DSA POST body is {name, description, elements}
    # (per-element `group` drives grouping). A top-level groups list fails schema validation, which
    # silently degraded the tool to summary-only and killed the overlay.
    assert "groups" not in seen["body"]


@pytest.mark.asyncio
async def test_get_reads_group_back_into_aligned_classes():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"_id": "ann1", "annotation": {"elements": [
            {"type": "point", "center": [1.0, 2.0, 0], "group": "Neoplastic"},
            {"type": "point", "center": [3.0, 4.0, 0]},                       # legacy, no group
        ]}})

    got = await _store(handler).get(owner="u1", ref="ann1", token="tok")
    assert got == {"kind": "nuclei", "count": 2, "points": [[1.0, 2.0], [3.0, 4.0]],
                   "classes": ["Neoplastic", None]}


@pytest.mark.asyncio
async def test_phenotype_geometry_round_trips_full_fidelity_in_session():
    # DSA point elements can't carry per-cell flags/markers; the in-process cache keeps them for
    # the same-session overlay fetch (kind stays "phenotype", cells survive).
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"_id": "annP"})

    store = _store(handler)
    geom = {
        "kind": "phenotype", "count": 1, "points": [[5.0, 6.0]], "classes": ["Cytotoxic T"],
        "cells": [{"x": 5.0, "y": 6.0, "phenotype": "Cytotoxic T",
                   "flags": ["Proliferating"], "markers": {"CD8": 0.9}}],
    }
    handle = await store.put(
        owner="u", conversation_id=1, kind="phenotype", bbox=None,
        geometry=geom, summary="1 cell phenotyped", item_id="item9", token="tok",
    )
    assert handle.kind == "phenotype"
    got = await store.get(owner="u", ref=handle.ref, token="tok")
    assert got["kind"] == "phenotype"
    assert got["cells"][0]["flags"] == ["Proliferating"]
    assert got["cells"][0]["markers"]["CD8"] == 0.9
