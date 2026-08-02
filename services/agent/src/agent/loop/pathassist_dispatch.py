"""Gateway → Girder plugin dispatch (Inc 6 · ticket 01).

One call: hand an ordered submission to `POST /pathassist/chain` and get back what Girder made of
it. The gateway keeps everything that makes a run *identifiable* — the content address, the reuse
check, the lineage, the plan — and gives away only the part that has to happen inside the Girder
process, which is minting the jobs and putting them on a queue (plan D5).

Deliberately thin, and deliberately not a second copy of the worker clients it replaces: there is
no status polling here. Once a run is a Girder job, its progress is read from `GET /job` like every
other job on the machine, which is the whole point of the change.
"""

import httpx


class DispatchUnavailable(RuntimeError):
    """The plugin could not be reached or refused the run. Carries what it said."""


# `dispatch_run` is gone (Inc 6 · 08). It put one run on the queue, and by the end of 07 every kind
# went through the planner instead — which always produces a sequence, even when the sequence is one
# step. Keeping both would have been two ways for a run to exist, and only one of them could reuse
# an artifact or plan an upstream.


async def dispatch_chain(
    *,
    plugin_url: str,
    item: str,
    steps: list[dict],
    token: str | None,
    label: str | None = None,
    timeout: float = 30.0,
    client: httpx.AsyncClient | None = None,
) -> dict:
    """Put an ordered sequence of runs on the queue as one submission (Inc 6 · 07).

    `steps` is `[{kind, artHash, params, title}]` — already planned, already addressed, already
    trimmed to what this slide is missing. The plugin sequences them with a Celery chain, so a step
    that fails or is stopped publishes nothing after it.

    Returns `{chainId, jobId, queue, steps}`. Only the head has a Girder job yet; the rest are
    minted as they are published, which is what keeps a chain that stopped early from leaving rows
    for work that never happened.

    Raises:
        DispatchUnavailable: the plugin is unreachable, unauthenticated, or refused a kind.
    """
    owns = client is None
    client = client or httpx.AsyncClient(timeout=timeout)
    try:
        resp = await client.post(
            f"{plugin_url.rstrip('/')}/pathassist/chain",
            headers={"Girder-Token": token} if token else {},
            params={"item": item, **({"label": label} if label else {})},
            json=steps,
        )
    except httpx.HTTPError as exc:
        raise DispatchUnavailable(f"could not reach the PathAssist Girder plugin: {exc}") from exc
    finally:
        if owns:
            await client.aclose()

    return _ack(resp)


def _ack(resp: httpx.Response) -> dict:
    """The plugin's reply, or its refusal turned into one exception the routes can forward."""
    if resp.status_code >= 400:
        detail = ""
        try:
            detail = resp.json().get("message") or resp.json().get("detail") or ""
        except ValueError:
            detail = resp.text[:300]
        raise DispatchUnavailable(
            f"the PathAssist Girder plugin refused the run ({resp.status_code}): {detail}"
        )
    return resp.json()
