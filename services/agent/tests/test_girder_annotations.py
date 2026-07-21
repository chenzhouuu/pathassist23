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
    assert got == {"kind": "nuclei", "count": 2, "points": [[10.0, 20.0], [11.0, 21.0]]}


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
    assert got == {"kind": "nuclei", "count": 1, "points": [[1.0, 2.0]]}


@pytest.mark.asyncio
async def test_put_raises_on_write_failure_so_caller_can_degrade():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"message": "read-only"})

    with pytest.raises(httpx.HTTPStatusError):
        await _store(handler).put(
            owner="u1", conversation_id=1, kind="nuclei", bbox=None,
            geometry={"kind": "nuclei", "count": 1, "points": [[1, 2]]},
            summary="1", item_id="item9", token="tok")
