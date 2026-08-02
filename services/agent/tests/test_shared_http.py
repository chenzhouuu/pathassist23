"""The pooled clients the auth check and the tile proxies share (common/http.py)."""

from agent.common import http as http_mod


async def _cleanup():
    await http_mod.close_shared_clients()


async def test_the_same_base_and_timeout_get_the_same_client():
    try:
        a = http_mod.shared_client("http://svc:8020", 30.0)
        b = http_mod.shared_client("http://svc:8020", 30.0)
        assert a is b                                    # the whole point: connections stay warm
    finally:
        await _cleanup()


async def test_different_services_get_different_clients():
    try:
        a = http_mod.shared_client("http://cellvit:8020", 30.0)
        b = http_mod.shared_client("http://tissue:8023", 30.0)
        c = http_mod.shared_client("http://cellvit:8020", 10.0)
        assert a is not b and a is not c                 # keyed by (base_url, timeout)
    finally:
        await _cleanup()


async def test_a_closed_client_is_rebuilt_rather_than_handed_back():
    """A request that lands after shutdown must see the service, not a closed-client error."""
    try:
        first = http_mod.shared_client("http://svc:8020", 30.0)
        await http_mod.close_shared_clients()
        second = http_mod.shared_client("http://svc:8020", 30.0)
        assert second is not first
        assert not second.is_closed
    finally:
        await _cleanup()


async def test_close_is_idempotent():
    http_mod.shared_client("http://svc:8020", 30.0)
    await http_mod.close_shared_clients()
    await http_mod.close_shared_clients()
