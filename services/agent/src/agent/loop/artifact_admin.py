"""Gateway → owning service: remove an artifact's bytes, and ask what they cost (Inc 5, ticket 04).

One module rather than a method on each of the three map clients. Those are kept separate because
each service's enqueue and tile vocabularies genuinely differ, and a shared client would have to be
told which service it is on every call. Delete and usage are the opposite case: the same operation
with the same shape, differing only in a URL. A table of three URLs is less indirection than three
copies of the same two functions.
"""

import httpx

# Walking a whole-slide artifact's directory to sum its size is hundreds of MB of stat() calls.
_TIMEOUT = 60.0


def _path(kind: str, item: str, art_hash: str) -> str:
    """Where this kind's bytes live, in its owning service's own URL vocabulary.

    `tissue` and `biomarker` each own one kind, so the kind is implicit in their path. The
    preprocess service owns four, so it takes the row's `kind` and maps it to its directory
    layout itself — the gateway does not need to know that layout.
    """
    if kind in ("tissue", "biomarker"):
        return f"/{kind}/{item}/{art_hash}"
    return f"/artifacts/{kind}/{item}/{art_hash}"


async def delete_artifact(
    *, base_url: str, kind: str, item: str, art_hash: str,
    client: httpx.AsyncClient | None = None,
) -> None:
    """DELETE the artifact's directory. Idempotent — an artifact already gone is a success."""
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=_TIMEOUT)
    try:
        resp = await client.delete(_path(kind, item, art_hash))
        resp.raise_for_status()
    finally:
        if owns:
            await client.aclose()


async def artifact_usage(
    *, base_url: str, kind: str, item: str, art_hash: str,
    client: httpx.AsyncClient | None = None,
) -> int:
    """Bytes on disk, or 0 when the service cannot say. Never a refusal: this only ever decorates
    a confirm dialog, and failing to size an artifact is not a reason to refuse to delete it."""
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=_TIMEOUT)
    try:
        resp = await client.get(f"{_path(kind, item, art_hash)}/usage")
        resp.raise_for_status()
        return int(resp.json().get("bytes") or 0)
    except (httpx.HTTPError, ValueError, TypeError):
        return 0
    finally:
        if owns:
            await client.aclose()
