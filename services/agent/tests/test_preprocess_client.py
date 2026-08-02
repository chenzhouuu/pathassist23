import httpx
import pytest

from agent.loop.preprocess_client import find_regions


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://pp")


# `trigger_preprocess` and `get_job_status` were tested here until Inc 6 · 09. Both went with the
# Inc-2a flat index: nothing polls a service for a run's progress any more, because a run is a
# Girder job and its progress is on the job.


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
