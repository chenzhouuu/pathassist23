"""Submit, watch, stop, report — the whole of what the driver actually does.

Kept clear of `girder_worker` on purpose. Everything here is `httpx` and pure decisions, so the
cases worth testing (a service that 404s mid-run, a cancel against a service with no stop, a stop
that takes several polls to land, a payload whose result is nested) are covered without a broker,
a Mongo or a GPU. `driver.py` is the Celery shell that wires this to a Girder job.
"""

import logging
import os
import time

import httpx

from .routing import route_for
from .status import Status, normalise

logger = logging.getLogger(__name__)

#: How often the driver asks the service where it is. Local HTTP on the same box, so this is cheap;
#: it is the first of the two hops between a tile finishing and the browser hearing about it (the
#: other is the Runs poller), which is why it is not slower.
POLL_SECONDS = float(os.environ.get("PATHASSIST_DRIVER_POLL_SECONDS", "1.0"))

#: Timeout for the submit and status calls. Submit is an enqueue and returns at once; a service
#: slow enough to blow this is a service worth failing against.
HTTP_TIMEOUT = float(os.environ.get("PATHASSIST_DRIVER_TIMEOUT", "30.0"))


class ServiceRefused(RuntimeError):
    """The analysis service rejected the submission. Carries its words, not ours."""


def service_payload(kind: str, item: str, token: str | None, params: dict | None) -> dict:
    """The submit body for this kind, with the slide under the key that service names it by.

    Here rather than in `driver.py` so it is testable without `girder_worker` installed, which is
    the whole reason this module exists. The key is not uniform — the preprocess service says
    `item`, the three JobQueue services say `slide_ref` — and sending the wrong one is not a subtle
    failure: a nuclei dispatch came back `400: slide_ref is required` inside a second (Inc 6 · 05).
    """
    return {route_for(kind).item_key: item, "girder_token": token, **(params or {})}


def submit(client: httpx.Client, kind: str, payload: dict) -> str:
    """Enqueue the work on its service and return that service's own job id.

    The gateway has already validated the request, so a refusal here is the service's own and its
    detail is forwarded verbatim — the Runs list should show what the worker said, not a
    paraphrase.
    """
    route = route_for(kind)
    resp = client.post(route.submit, json=payload)
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail") or ""
        except ValueError:
            detail = resp.text[:300]
        raise ServiceRefused(f"{kind} was refused ({resp.status_code}): {detail}")
    job_id = (resp.json() or {}).get("job_id")
    if not job_id:
        raise ServiceRefused(f"{kind} accepted the request but returned no job_id")
    return job_id


def read_status(client: httpx.Client, kind: str, job_id: str) -> Status:
    """One status reading, normalised.

    A 404 means the service has forgotten this job — which is exactly what a service restart looks
    like from here. That is a failure with a nameable cause, not a job to poll forever. The row
    stuck at `running` because nobody could tell those apart is the defect this increment removes
    (plan §3).
    """
    route = route_for(kind)
    resp = client.get(route.status.format(job_id=job_id))
    if resp.status_code == 404:
        return Status(
            state="failed", stage=None, current=None, total=None, percent=0, result={},
            error=(
                f"the {kind} service no longer knows job {job_id} — it restarted while the job "
                "was running, and whatever that job had not already written to disk is gone"
            ),
        )
    resp.raise_for_status()
    return normalise(resp.json(), nested_result=route.nested_result)


def request_cancel(client: httpx.Client, kind: str, job_id: str) -> bool:
    """Ask the service to stop at its next clean boundary. False when it has no way to be asked.

    Best-effort on the response by design: the service answers while the job is still running (it
    finishes the tile it is on first), so what matters is that the request landed. The outcome
    arrives through the next status reading, like everything else.
    """
    route = route_for(kind)
    if route.cancel is None:
        return False
    try:
        client.post(route.cancel.format(job_id=job_id))
    except httpx.HTTPError:
        logger.warning("cancel request to the %s service did not land", kind, exc_info=True)
        return False
    return True


def drive(
    client: httpx.Client,
    kind: str,
    payload: dict,
    *,
    report,
    is_canceled,
    sleep=time.sleep,
    poll_seconds: float = POLL_SECONDS,
) -> Status:
    """Submit, then watch until the service settles. Returns the terminal reading.

    Celery and Girder are entirely behind `report` and `is_canceled`, which is what makes the
    interesting paths testable at all.
    """
    job_id = submit(client, kind, payload)
    report(Status(state="running", stage="starting", current=None, total=None,
                  percent=0, result={}, error=None), job_id)

    asked_to_stop = False
    while True:
        status = read_status(client, kind, job_id)
        report(status, job_id)
        if status.terminal:
            return status
        if is_canceled() and not asked_to_stop:
            # Asked once. A service with no stop keeps running, and the log is where that gets
            # said — the alternative is a Stop button that silently does nothing.
            if request_cancel(client, kind, job_id):
                logger.info("asked the %s service to stop job %s", kind, job_id)
            else:
                logger.warning(
                    "the %s service has no cooperative stop; job %s runs to completion",
                    kind, job_id,
                )
            asked_to_stop = True
        sleep(poll_seconds)


def report_terminal(gateway_url: str | None, token: str | None, item: str, art_hash: str,
                    status: Status, *, kind: str | None = None, params: dict | None = None,
                    girder_job_id: str | None = None, timeout: float = HTTP_TIMEOUT) -> bool:
    """Tell the gateway how the run ended, so the artifact row stops being a promise.

    Called for `ready` and for `cancelled` — both leave usable bytes on disk. A failed run reports
    nothing, because its whole story is the Girder job.

    `kind` and `params` are what let this report **create** the row rather than only update one.
    That is the D9 shape a kind takes when it moves onto this path (Inc 6 · 05): the gateway stops
    writing a row at dispatch, so between submit and the last tile there is a job and no row, and a
    row means bytes exist. Until a kind has moved, its row is still written at dispatch and these
    two are simply redundant.

    Returns whether the gateway acknowledged. A failure here is logged and swallowed: the bytes are
    on disk either way, so losing the row's result is recoverable, and turning a finished run into
    a failed one would not be.
    """
    if not gateway_url:
        return False
    url = f"{gateway_url.rstrip('/')}/slides/{item}/artifacts/{art_hash}/result"
    headers = {"Girder-Token": token} if token else {}
    body = {"status": status.state, "result": status.result, "kind": kind,
            "params": params or {}, "girder_job_id": girder_job_id}
    try:
        httpx.post(url, json=body, headers=headers, timeout=timeout).raise_for_status()
    except httpx.HTTPError:
        logger.exception("could not report %s %s to the gateway", art_hash, status.state)
        return False
    return True
