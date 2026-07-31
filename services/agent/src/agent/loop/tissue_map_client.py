"""Gateway → tissue service client for the dense tissue-class map (Inc 4).

Same two shapes of traffic as the biomarker map client, for the same reasons:

- **control** (enqueue, status, catalog, meta, stats) — small JSON, ordinary awaits;
- **tiles** — binary imagery, hundreds of requests per viewport, proxied through the gateway so
  the browser's Girder session is checked once and the tissue service is never publicly exposed.
  That is why this module returns raw bytes plus the headers worth forwarding, and nothing else.

Kept separate from ``biomarker_map_client`` rather than generalised: the two services' paths and
refusal vocabularies differ, and a shared client would have to be told which one it is talking to
on every call, which is the same coupling with more indirection.
"""

from dataclasses import dataclass

import httpx

# An enqueue returns immediately (the worker queues it), so these stay short.
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


async def enqueue_tissue(
    *, base_url: str, item: str, seg_hash: str, bbox: dict | None, backend: str | None,
    token: str | None, client: httpx.AsyncClient | None = None,
) -> dict:
    """POST /tissue → {art_hash, job_id, status, scope, backend}. ``bbox=None`` ⇒ whole slide."""
    payload = {"slide_ref": item, "seg_hash": seg_hash, "bbox": bbox,
               "backend": backend, "girder_token": token}
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=_CONTROL_TIMEOUT)
    try:
        resp = await client.post("/tissue", json=payload)
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns:
            await client.aclose()


async def tissue_job_status(
    *, base_url: str, job_id: str, client: httpx.AsyncClient | None = None,
) -> dict:
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=_CONTROL_TIMEOUT)
    try:
        resp = await client.get(f"/tissue/status/{job_id}")
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns:
            await client.aclose()


async def get_tissue_json(
    *, base_url: str, path: str, params: dict | None = None,
    client: httpx.AsyncClient | None = None,
) -> dict | None:
    """GET a control-plane JSON document (catalog / meta / stats); None on 404."""
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=_CONTROL_TIMEOUT)
    try:
        resp = await client.get(path, params=params or {})
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns:
            await client.aclose()


async def get_tissue_tile(
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
