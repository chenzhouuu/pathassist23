import httpx
import pytest

from agent.loop.segmenter import segment_region


@pytest.mark.asyncio
async def test_segment_region_posts_and_maps_result():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["json"] = __import__("json").loads(request.content)
        return httpx.Response(200, json={
            "count": 2, "centroids": [[100.0, 200.0], [110.0, 220.0]],
            "bbox": {"x": 100, "y": 200, "width": 64, "height": 48}, "mpp": 0.5,
        })

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport, base_url="http://cellvit") as client:
        res = await segment_region(
            base_url="http://cellvit", slide_ref="item1",
            bbox={"x": 100, "y": 200, "width": 64, "height": 48},
            token="tok", client=client,
        )

    assert res.count == 2
    assert res.points == [[100.0, 200.0], [110.0, 220.0]]
    assert res.mpp == 0.5
    assert seen["json"]["slide_ref"] == "item1"
    assert seen["json"]["girder_token"] == "tok"
    assert "/segment" in seen["url"]


@pytest.mark.asyncio
async def test_segment_region_mpp_defaults_to_none():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"count": 0, "centroids": []})  # no mpp key

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport, base_url="http://cellvit") as client:
        res = await segment_region(
            base_url="http://cellvit", slide_ref="item1",
            bbox={"x": 0, "y": 0, "width": 8, "height": 8}, token=None, client=client,
        )
    assert res.mpp is None
