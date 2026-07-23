"""Gateway → preprocess service HTTP client (Inc 2b).

Three thin async calls to the preprocess worker: trigger a build (`/run`), poll a job's status
(`/status`, used by the gateway to reconcile the durable slide_index row), and text→patch region
retrieval (`/find_regions`, used by the find_regions server tool). The Girder token rides
server-to-server and is never a model argument (D3). Mirrors ``pathvlm_client.py``.
"""

from dataclasses import dataclass

import httpx


@dataclass(frozen=True)
class RegionsResult:
    """find_regions retrieval outcome: ranked level-0 candidate boxes + provenance."""

    regions: list[dict]
    top_score: float
    encoder: str
    query: str


async def trigger_preprocess(
    *,
    base_url: str,
    item: str,
    params: dict,
    token: str | None,
    timeout: float = 30.0,
    client: httpx.AsyncClient | None = None,
) -> dict:
    """POST /run to enqueue a build; returns {job_id, params_hash, status, encoder, mag, ...}."""
    payload = {"item": item, "girder_token": token, **params}
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=timeout)
    try:
        resp = await client.post("/run", json=payload)
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns:
            await client.aclose()


async def get_job_status(
    *,
    base_url: str,
    job_id: str,
    timeout: float = 15.0,
    client: httpx.AsyncClient | None = None,
) -> dict:
    """GET /status for a job; returns {status, stage, progress, n_patches, features_ref, error}."""
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=timeout)
    try:
        resp = await client.get("/status", params={"job_id": job_id})
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns:
            await client.aclose()


async def find_regions(
    *,
    base_url: str,
    item: str,
    query: str,
    k: int,
    token: str | None,
    encoder: str | None = None,
    timeout: float = 60.0,
    client: httpx.AsyncClient | None = None,
) -> RegionsResult | None:
    """POST /find_regions; None when the slide isn't indexed for text search (404/409)."""
    payload = {"item": item, "query": query, "k": k, "girder_token": token}
    if encoder:
        payload["encoder"] = encoder
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=timeout)
    try:
        resp = await client.post("/find_regions", json=payload)
        if resp.status_code in (404, 409):
            return None  # not indexed / image-only index → the tool degrades cleanly
        resp.raise_for_status()
        data = resp.json()
    finally:
        if owns:
            await client.aclose()
    return RegionsResult(
        regions=list(data.get("regions", [])),
        top_score=float(data.get("top_score", 0.0)),
        encoder=str(data.get("encoder", "")),
        query=str(data.get("query", query)),
    )
