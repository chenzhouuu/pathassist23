"""Gateway → cellvit service client for the nuclei artifact (Inc 5, ticket 05).

Control traffic only: enqueue a build, poll it, read its meta. The tile proxy this service will
also need arrives with the raster in ticket 06 — until then a nuclei artifact has numbers and no
picture, so there is nothing binary to forward.

Kept beside the tissue and biomarker map clients rather than folded into one, for the reason
stated there: the three services' paths and refusal vocabularies differ, and a shared client would
have to be told which one it is talking to on every call.
"""

import httpx

# An enqueue returns as soon as the worker queues it.
_CONTROL_TIMEOUT = 30.0


async def enqueue_nuclei(
    *, base_url: str, item: str, bbox: dict | None, token: str | None,
    client: httpx.AsyncClient | None = None,
) -> dict:
    """POST /nuclei → {art_hash, job_id, status, backend, scope}."""
    payload = {"slide_ref": item, "bbox": bbox, "girder_token": token}
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
    """The artifact's own meta: slide dims, mpp, store resolution, classes, coverage, summary."""
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=_CONTROL_TIMEOUT)
    try:
        resp = await client.get(f"/nuclei/{item}/{art_hash}/meta")
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns:
            await client.aclose()
