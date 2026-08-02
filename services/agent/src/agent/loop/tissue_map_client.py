"""Gateway → tissue service client for the dense tissue-class map (Inc 4).

Same two shapes of traffic as the biomarker map client, for the same reasons:

- **control** (catalog, meta, stats) — small JSON, ordinary awaits;
- **tiles** — binary imagery, hundreds of requests per viewport, proxied through the gateway so
  the browser's Girder session is checked once and the tissue service is never publicly exposed.
  That is why this module returns raw bytes plus the headers worth forwarding, and nothing else.

Kept separate from ``biomarker_map_client`` rather than generalised: the two services' paths and
refusal vocabularies differ, and a shared client would have to be told which one it is talking to
on every call, which is the same coupling with more indirection.
"""

from dataclasses import dataclass

import httpx

from ..common.http import shared_client

# Small JSON reads off disk, so these stay short.
_CONTROL_TIMEOUT = 30.0
# Tiles are read off disk and rendered in-process; slow only when the disk is cold.
_TILE_TIMEOUT = 30.0


@dataclass(frozen=True)
class TileResponse:
    body: bytes
    content_type: str
    cache_control: str | None
    etag: str | None
    status_code: int = 200


# There is no enqueue, status or cancel here any more. Since Inc 6 · 06 a tissue run is dispatched
# onto this box's Celery queue and driven by `girder_pathassist`, which dials the service directly
# — so the gateway's half of a run is the content address (`POST /tissue/hash`, called inline) and
# the driver's report. What is left is the read side: the catalog, the meta, the stats and the
# tiles, which the browser still reaches through this authenticated proxy.


async def get_tissue_json(
    *, base_url: str, path: str, params: dict | None = None,
    client: httpx.AsyncClient | None = None,
) -> dict | None:
    """GET a control-plane JSON document (catalog / meta / stats); None on 404."""
    client = client or shared_client(base_url, _CONTROL_TIMEOUT)
    resp = await client.get(path, params=params or {})
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


async def get_tissue_tile(
    *, base_url: str, path: str, params: dict, client: httpx.AsyncClient | None = None,
) -> TileResponse:
    """Fetch one rendered tile, preserving the headers that make it cacheable.

    A 400 (bad class spec) is forwarded verbatim rather than raised: the panel shows it as a
    control error, and raising here would turn a typo into a 502.
    """
    client = client or shared_client(base_url, _TILE_TIMEOUT)
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
