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


async def enqueue_map(
    *, base_url: str, item: str, seg_hash: str, bbox: dict | None, token: str | None,
    nuclei_hash: str | None = None, client: httpx.AsyncClient | None = None,
) -> dict:
    """POST /biomarker → {art_hash, job_id, status, scope}. ``bbox=None`` means whole slide.

    ``nuclei_hash`` names the cells the map is built on (Inc 5, D9). The worker refuses without it:
    a phenotype is an attribute of a nucleus, so the nuclei have to exist first.
    """
    payload = {"slide_ref": item, "seg_hash": seg_hash, "bbox": bbox,
               "nuclei_hash": nuclei_hash, "girder_token": token}
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=_CONTROL_TIMEOUT)
    try:
        resp = await client.post("/biomarker", json=payload)
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns:
            await client.aclose()


async def map_job_status(
    *, base_url: str, job_id: str, client: httpx.AsyncClient | None = None,
) -> dict:
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=_CONTROL_TIMEOUT)
    try:
        resp = await client.get(f"/biomarker/status/{job_id}")
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns:
            await client.aclose()


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
