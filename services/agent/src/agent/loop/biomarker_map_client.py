"""Gateway → biomarker service client for the marker/phenotype map (Inc 3b).

Two shapes of traffic, and they are deliberately different:

- **control** (enqueue, status, meta, cells) — small JSON, ordinary awaits;
- **tiles** — binary imagery, hundreds of requests per viewport. Those are proxied through the
  gateway so the browser's Girder session is checked once and the biomarker service is never
  publicly exposed (D3), which means this module must return the raw bytes plus the headers worth
  forwarding, and nothing else.
"""

from dataclasses import dataclass

import httpx

# A whole-slide enqueue returns immediately (the worker queues it), so these stay short.
_CONTROL_TIMEOUT = 30.0
# Tiles are read off disk and composited in-process; slow only when the disk is cold.
_TILE_TIMEOUT = 30.0


@dataclass(frozen=True)
class TileResponse:
    body: bytes
    content_type: str
    cache_control: str | None
    etag: str | None
    status_code: int = 200


# There is no enqueue or status here any more. Since Inc 6 · 06 a marker-map run is dispatched onto
# this box's Celery queue and driven by `girder_pathassist`, which dials the service directly — so
# the gateway's half of a run is the content address (`POST /biomarker/hash`, called inline) and
# the driver's report. What is left is the read side: the catalog, the meta, the cells and the
# tiles.


async def get_map_json(
    *, base_url: str, path: str, client: httpx.AsyncClient | None = None,
) -> dict | None:
    """GET a control-plane JSON document (catalog / meta / cells); None on 404."""
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=_CONTROL_TIMEOUT)
    try:
        resp = await client.get(path)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns:
            await client.aclose()


async def get_tile(
    *, base_url: str, path: str, params: dict, client: httpx.AsyncClient | None = None,
) -> TileResponse:
    """Fetch one composited tile, preserving the headers that make it cacheable.

    A 400 (bad channel spec) is forwarded verbatim rather than raised: the panel shows it as a
    control error, and a raise here would turn a typo into a 502.
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
