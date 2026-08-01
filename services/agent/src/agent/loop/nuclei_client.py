"""Gateway → cellvit service client for the nuclei artifact (Inc 5, tickets 05 and 06).

Enqueue a build, poll it, read its meta, fetch one rendered tile.

Kept beside the tissue and biomarker map clients rather than folded into one, for the reason
stated there: the three services' paths and refusal vocabularies differ, and a shared client would
have to be told which one it is talking to on every call.
"""

from dataclasses import dataclass

import httpx

# An enqueue returns as soon as the worker queues it.
_CONTROL_TIMEOUT = 30.0
# A tile is read off disk and colourised; it never waits on the GPU.
_TILE_TIMEOUT = 30.0


async def enqueue_nuclei(
    *, base_url: str, item: str, bbox: dict | None, token: str | None,
    seg_hash: str | None = None, client: httpx.AsyncClient | None = None,
) -> dict:
    """POST /nuclei → {art_hash, job_id, status, backend, scope}.

    ``bbox=None`` means the whole slide, which is when ``seg_hash`` matters: it is how the worker
    knows which cores hold tissue.
    """
    payload = {"slide_ref": item, "bbox": bbox, "seg_hash": seg_hash, "girder_token": token}
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=_CONTROL_TIMEOUT)
    try:
        resp = await client.post("/nuclei", json=payload)
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns:
            await client.aclose()


async def nuclei_job_status(
    *, base_url: str, job_id: str, client: httpx.AsyncClient | None = None,
) -> dict:
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=_CONTROL_TIMEOUT)
    try:
        resp = await client.get(f"/nuclei/status/{job_id}")
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns:
            await client.aclose()


async def cancel_nuclei(
    *, base_url: str, job_id: str, client: httpx.AsyncClient | None = None,
) -> dict:
    """Ask a build to stop at its next core-tile boundary. Reachable from the UI in ticket 07."""
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=_CONTROL_TIMEOUT)
    try:
        resp = await client.post(f"/nuclei/cancel/{job_id}")
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns:
            await client.aclose()


async def get_nuclei_meta(
    *, base_url: str, item: str, art_hash: str, client: httpx.AsyncClient | None = None,
) -> dict:
    """The artifact's own meta: slide dims, mpp, store resolution, classes, palette, coverage."""
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=_CONTROL_TIMEOUT)
    try:
        resp = await client.get(f"/nuclei/{item}/{art_hash}/meta")
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns:
            await client.aclose()


@dataclass(frozen=True)
class TileResponse:
    body: bytes
    content_type: str
    cache_control: str | None
    etag: str | None
    status_code: int


async def get_nuclei_tile(
    *, base_url: str, path: str, params: dict, client: httpx.AsyncClient | None = None,
) -> TileResponse:
    """Fetch one rendered tile, preserving the headers that make it cacheable.

    A 400 (bad class spec) is forwarded verbatim rather than raised: the panel shows it as a
    control error, and raising here would turn a typo into a 502.
    """
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=_TILE_TIMEOUT)
    try:
        resp = await client.get(path, params=params)
        if resp.status_code >= 500:
            resp.raise_for_status()
        return TileResponse(
            body=resp.content,
            content_type=resp.headers.get("content-type", "application/json"),
            cache_control=resp.headers.get("cache-control"),
            etag=resp.headers.get("etag"),
            status_code=resp.status_code,
        )
    finally:
        if owns:
            await client.aclose()
