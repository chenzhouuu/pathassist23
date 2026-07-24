import json

import httpx
import pytest

from agent.loop.biomarker_client import phenotype_cells


@pytest.mark.asyncio
async def test_phenotype_cells_maps_fields():
    capture = {}

    def handler(request: httpx.Request) -> httpx.Response:
        capture["path"] = request.url.path
        capture["json"] = json.loads(request.content)
        return httpx.Response(200, json={
            "count": 3,
            "counts_by_phenotype": {"Tumour": 2, "Cytotoxic T": 1},
            "flag_counts": {"Proliferating": 1},
            "cells": [{"x": 1.0, "y": 2.0, "phenotype": "Tumour", "flags": [],
                       "markers": {"CK": 0.9}}],
            "positive_markers": ["CK", "CD8"],
            "mpp": 0.5,
        })

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://bm:8022")
    res = await phenotype_cells(
        base_url="http://bm:8022", slide_ref="item1",
        bbox={"x": 0, "y": 0, "width": 64, "height": 64}, focus="immune", token="tok",
        client=client,
    )
    assert capture["path"] == "/phenotype"
    assert capture["json"]["girder_token"] == "tok" and capture["json"]["focus"] == "immune"
    assert res.count == 3
    assert res.counts_by_phenotype["Tumour"] == 2
    assert res.flag_counts["Proliferating"] == 1
    assert res.positive_markers == ["CK", "CD8"]
    assert res.mpp == 0.5


@pytest.mark.asyncio
async def test_phenotype_cells_raises_on_http_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"detail": "GPU worker needed"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://bm:8022")
    with pytest.raises(httpx.HTTPStatusError):
        await phenotype_cells(
            base_url="http://bm:8022", slide_ref="s",
            bbox={"x": 0, "y": 0, "width": 8, "height": 8}, token=None, client=client,
        )
