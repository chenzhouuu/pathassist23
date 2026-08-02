"""Resolve the caller from the Girder session the viewer already holds.

The copilot never trusts a client-supplied identity — it asks Girder who the token belongs to. That
is the "auth-on-read" seam every route depends on.

What is new here is that the answer is **cached for a few seconds and resolved once per token**.
`require_user` runs on every request, and every overlay tile is a request: a 60-tile viewport used
to be 60 `/user/me` calls, each on its own freshly built HTTP client. Girder was never the problem
(it serves 60 concurrent `/user/me` in 30 ms) — the per-request client was, and so was asking 60
times what is the same answer 60 times over.

The trade this makes is explicit: a token that is revoked or expires server-side keeps working here
for up to `auth_cache_seconds`. That is the same shape of staleness a session cookie already has,
it is bounded by a setting, and `AGENT_AUTH_CACHE_SECONDS=0` turns it off entirely.
"""

import asyncio
import time

import httpx
from fastapi import Header, HTTPException, status

from ..common.config import get_settings
from ..common.http import shared_client

_AUTH_TIMEOUT = 10.0

# Tokens in flight are few — one per signed-in browser — so this is a guard against unbounded
# growth rather than an eviction policy worth tuning.
_MAX_CACHED = 4096

_cache: dict[str, tuple[float, dict]] = {}
_locks: dict[str, asyncio.Lock] = {}


def reset_auth_cache() -> None:
    """Forget every cached identity. For tests, and for a deployment that wants a hard reset."""
    _cache.clear()
    _locks.clear()


def _prune(now: float) -> None:
    for token, (expires, _) in list(_cache.items()):
        if expires <= now:
            _cache.pop(token, None)
            _locks.pop(token, None)
    if len(_cache) > _MAX_CACHED:      # pathological only; correctness does not depend on it
        _cache.clear()
        _locks.clear()


async def _resolve(girder_token: str) -> dict:
    """Ask Girder who this token is. Raises the refusal the browser should see."""
    settings = get_settings()
    client = shared_client(settings.girder_base, _AUTH_TIMEOUT)
    try:
        resp = await client.get("/user/me", headers={"Girder-Token": girder_token})
    except httpx.HTTPError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Girder unreachable") from exc
    try:
        body = resp.json() if resp.status_code == 200 else None
    except ValueError:
        body = None
    if not body:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid Girder token")
    return body


async def require_user(girder_token: str = Header(..., alias="Girder-Token")) -> dict:
    """Validate the caller's Girder token, reusing a recent answer for the same token.

    The lock is per token and held only for the one `/user/me` a miss costs, so the first tile of a
    viewport pays it and the other fifty-nine read the cache. It is a lock rather than a shared
    task because a browser that navigates away mid-request must not cancel the lookup the other
    fifty-nine are waiting on.
    """
    ttl = get_settings().auth_cache_seconds
    if ttl <= 0:
        return await _resolve(girder_token)

    now = time.monotonic()
    hit = _cache.get(girder_token)
    if hit and hit[0] > now:
        return hit[1]

    lock = _locks.get(girder_token)
    if lock is None:
        lock = _locks.setdefault(girder_token, asyncio.Lock())
    async with lock:
        now = time.monotonic()
        hit = _cache.get(girder_token)          # filled while we waited for the lock
        if hit and hit[0] > now:
            return hit[1]
        user = await _resolve(girder_token)
        _prune(now)
        _cache[girder_token] = (now + ttl, user)
        return user
