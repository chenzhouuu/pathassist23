"""Process-wide pooled HTTP clients for the gateway's hot paths.

Every overlay tile the viewer draws is one gateway request, and one viewport is 30–80 of them
(``overlayLayers.js`` mounts each artifact as an OpenSeadragon tiled image). Building an
``httpx.AsyncClient`` per request — ``async with httpx.AsyncClient(...)``, the shape this module
replaces — means a fresh TCP connection per request, and there are two hops: the auth check against
Girder and the proxy to the rendering service. Sixty tiles was therefore 120 sockets opened and
closed to paint one screen.

Measured on a box where Girder, the gateway and the renderers are all local:

    60 nuclei tiles, straight to the cellvit service      0.24 s
    60 nuclei tiles, through the gateway                  1.21 s

None of that gap is Girder (it answers 60 concurrent ``/user/me`` in 0.03 s) and none of it is the
renderer. It is connection churn. So the clients live as long as the process and keep their
connections warm.

Keyed by ``(base_url, timeout)`` because that pair is what a client *is* here — everything else
about a request is per-call. Callers may still pass their own client (the tests do, with a
``MockTransport``); this is only what they get when they don't.
"""

import httpx

# Sized for the fan-out a tile pyramid produces rather than for a control-plane API: a viewport is
# tens of concurrent requests, and a keepalive pool smaller than that would put the churn straight
# back. `keepalive_expiry` outlives an idle pan, so scrubbing around a slide never re-handshakes.
_LIMITS = httpx.Limits(
    max_connections=200,
    max_keepalive_connections=100,
    keepalive_expiry=60.0,
)

_clients: dict[tuple[str, float], httpx.AsyncClient] = {}


def shared_client(base_url: str, timeout: float) -> httpx.AsyncClient:
    """The pooled client for one (base_url, timeout), created on first use.

    Safe to call on every request: construction is a dict lookup after the first. A client that has
    been closed (shutdown, then a straggler request) is rebuilt rather than reused, because a closed
    client raises on use and the caller would see it as the service being down.
    """
    key = (base_url, timeout)
    client = _clients.get(key)
    if client is None or client.is_closed:
        client = httpx.AsyncClient(base_url=base_url, timeout=timeout, limits=_LIMITS)
        _clients[key] = client
    return client


async def close_shared_clients() -> None:
    """Close every pooled client. Called from the app's lifespan shutdown."""
    clients = list(_clients.values())
    _clients.clear()
    for client in clients:
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001 — shutdown must not fail on a half-open socket
            pass
