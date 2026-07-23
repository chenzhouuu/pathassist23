import httpx
import pytest

from agent.loop.preprocess_client import find_regions, get_job_status, trigger_preprocess


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://pp")


@pytest.mark.asyncio
async def test_trigger_preprocess_posts_run():
    seen = {}

    def handler(request):
        import json
        seen["path"] = request.url.path
        seen["json"] = json.loads(request.content)
        return httpx.Response(202, json={
            "job_id": "j1", "params_hash": "h1", "status": "queued",
            "encoder": "conch_v1", "mag": 20, "patch_size": 256, "segmenter": "hest",
        })

    async with _client(handler) as c:
        out = await trigger_preprocess(
            base_url="http://pp", item="item9",
            params={"encoder": "conch_v1"}, token="tok", client=c,
        )
    assert seen["path"] == "/run" and seen["json"]["item"] == "item9"
    assert seen["json"]["girder_token"] == "tok" and seen["json"]["encoder"] == "conch_v1"
    assert out["params_hash"] == "h1" and out["job_id"] == "j1"


@pytest.mark.asyncio
async def test_get_job_status():
    def handler(request):
        assert request.url.path == "/status" and request.url.params["job_id"] == "j1"
        return httpx.Response(200, json={"status": "ready", "n_patches": 16})

    async with _client(handler) as c:
        out = await get_job_status(base_url="http://pp", job_id="j1", client=c)
    assert out["status"] == "ready" and out["n_patches"] == 16


@pytest.mark.asyncio
async def test_find_regions_ready():
    regions = [{"x": 0, "y": 0, "width": 512, "height": 512, "score": 0.6}]

    def handler(request):
        assert request.url.path == "/find_regions"
        return httpx.Response(200, json={
            "regions": regions, "top_score": 0.6, "encoder": "conch_v1", "query": "tumor",
        })

    async with _client(handler) as c:
        out = await find_regions(
            base_url="http://pp", item="s", query="tumor", k=8, token="t", client=c
        )
    assert out is not None and out.regions == regions and out.top_score == 0.6
    assert out.encoder == "conch_v1"


@pytest.mark.asyncio
@pytest.mark.parametrize("code", [404, 409])
async def test_find_regions_none_when_not_indexed(code):
    def handler(request):
        return httpx.Response(code, json={"detail": "not indexed"})

    async with _client(handler) as c:
        out = await find_regions(
            base_url="http://pp", item="s", query="tumor", k=8, token="t", client=c
        )
    assert out is None
