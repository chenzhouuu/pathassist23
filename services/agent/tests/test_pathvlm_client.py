import json

import httpx
import pytest

from agent.loop.pathvlm_client import DescribeResult, describe_region


@pytest.mark.asyncio
async def test_describe_region_posts_and_maps_result():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "description": "hyperchromatic nuclei, high N:C ratio",
            "magnification_used": 20.0, "mpp": 0.5,
        })

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://p")
    res = await describe_region(
        base_url="http://p", slide_ref="item9",
        bbox={"x": 1, "y": 2, "width": 512, "height": 512},
        magnification=20, focus="atypia", token="tok", client=client,
    )
    assert isinstance(res, DescribeResult)
    assert res.description.startswith("hyperchromatic")
    assert res.magnification == 20.0 and res.mpp == 0.5
    assert seen["path"] == "/describe_region"
    # D3: token rides the body server-to-server, never a model argument
    assert seen["body"]["girder_token"] == "tok" and seen["body"]["focus"] == "atypia"


@pytest.mark.asyncio
async def test_describe_region_raises_on_http_error_so_caller_can_degrade():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, json={"detail": "girder down"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://p")
    with pytest.raises(httpx.HTTPStatusError):
        await describe_region(
            base_url="http://p", slide_ref="x", bbox={"x": 0, "y": 0, "width": 8, "height": 8},
            magnification=None, focus=None, token=None, client=client,
        )
