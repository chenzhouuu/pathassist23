"""Gateway → cellvit service client for the nuclei artifact (Inc 5, tickets 05 and 06).

Read an artifact's meta, fetch one rendered tile. That is all that is left.

**Submitting, polling and cancelling went in Inc 6 · 05**, when nuclei moved onto the Girder job
queue: the driver dials the cellvit service directly from its own box (`routing.ROUTES`), so a
second copy of those three calls in the gateway would be a path nothing takes. What stays is the
read side, which the gateway still proxies because the browser reaches it through the gateway.

Kept beside the tissue and biomarker map clients rather than folded into one, for the reason
stated there: the three services' paths and refusal vocabularies differ, and a shared client would
have to be told which one it is talking to on every call.
"""

from dataclasses import dataclass

import httpx

# A meta read is a small JSON off disk.
_CONTROL_TIMEOUT = 30.0
# A tile is read off disk and colourised; it never waits on the GPU.
_TILE_TIMEOUT = 30.0


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
