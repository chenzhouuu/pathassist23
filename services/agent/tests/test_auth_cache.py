"""`require_user` resolves a token once and reuses the answer (see gateway/auth.py).

Every overlay tile is an authorised request and a viewport is tens of them, so what these pin is
the request *count* against Girder, not just the identity that comes back.
"""

import asyncio

import httpx
import pytest
from fastapi import HTTPException

from agent.common.config import Settings
from agent.gateway import auth as auth_mod


@pytest.fixture(autouse=True)
def _clean_cache():
    auth_mod.reset_auth_cache()
    yield
    auth_mod.reset_auth_cache()


def _girder(calls: list, *, status: int = 200, user: dict | None = None):
    """A stand-in Girder that records every `/user/me` it is asked."""
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.headers.get("Girder-Token"))
        if status != 200:
            return httpx.Response(status, json={"message": "no"})
        return httpx.Response(200, json=user or {"_id": "u1", "login": "tester"})
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://girder")


def _wire(monkeypatch, client, *, ttl: float = 30.0):
    monkeypatch.setattr(auth_mod, "shared_client", lambda base_url, timeout: client)
    monkeypatch.setattr(auth_mod, "get_settings",
                        lambda: Settings(girder_base="http://girder", auth_cache_seconds=ttl))


async def test_the_same_token_is_resolved_once(monkeypatch):
    calls: list = []
    _wire(monkeypatch, _girder(calls))

    first = await auth_mod.require_user("tok-a")
    second = await auth_mod.require_user("tok-a")

    assert first == second == {"_id": "u1", "login": "tester"}
    assert calls == ["tok-a"]            # the second request never left the gateway


async def test_a_viewport_of_concurrent_requests_asks_girder_once(monkeypatch):
    """The case this exists for: 60 tiles land together, all carrying one browser's token."""
    calls: list = []
    _wire(monkeypatch, _girder(calls))

    users = await asyncio.gather(*(auth_mod.require_user("tok-a") for _ in range(60)))

    assert len(users) == 60
    assert all(u == {"_id": "u1", "login": "tester"} for u in users)
    assert len(calls) == 1               # single-flight, not 60 racing misses


async def test_different_tokens_are_different_identities(monkeypatch):
    calls: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        token = request.headers.get("Girder-Token")
        calls.append(token)
        return httpx.Response(200, json={"_id": token})

    _wire(monkeypatch, httpx.AsyncClient(transport=httpx.MockTransport(handler),
                                         base_url="http://girder"))

    assert (await auth_mod.require_user("tok-a"))["_id"] == "tok-a"
    assert (await auth_mod.require_user("tok-b"))["_id"] == "tok-b"
    assert (await auth_mod.require_user("tok-a"))["_id"] == "tok-a"
    assert calls == ["tok-a", "tok-b"]   # one lookup each; the cache is keyed by token


async def test_a_rejected_token_is_not_cached(monkeypatch):
    """A 401 must stay a live question — caching it would outlast the sign-in that fixes it."""
    calls: list = []
    _wire(monkeypatch, _girder(calls, status=401))

    for _ in range(3):
        with pytest.raises(HTTPException) as exc:
            await auth_mod.require_user("tok-bad")
        assert exc.value.status_code == 401
    assert len(calls) == 3


async def test_ttl_zero_disables_the_cache(monkeypatch):
    """AGENT_AUTH_CACHE_SECONDS=0 is the escape hatch for a deployment that wants none of this."""
    calls: list = []
    _wire(monkeypatch, _girder(calls), ttl=0)

    await auth_mod.require_user("tok-a")
    await auth_mod.require_user("tok-a")

    assert len(calls) == 2


async def test_an_expired_entry_is_resolved_again(monkeypatch):
    calls: list = []
    _wire(monkeypatch, _girder(calls), ttl=30.0)

    clock = [1000.0]
    monkeypatch.setattr(auth_mod.time, "monotonic", lambda: clock[0])

    await auth_mod.require_user("tok-a")
    clock[0] += 29.0
    await auth_mod.require_user("tok-a")
    assert len(calls) == 1               # still inside the window

    clock[0] += 2.0
    await auth_mod.require_user("tok-a")
    assert len(calls) == 2               # past it


async def test_girder_unreachable_is_a_503(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    _wire(monkeypatch, httpx.AsyncClient(transport=httpx.MockTransport(handler),
                                         base_url="http://girder"))

    with pytest.raises(HTTPException) as exc:
        await auth_mod.require_user("tok-a")
    assert exc.value.status_code == 503
