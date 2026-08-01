"""The one Celery task — a shell around `runner.drive`.

The task computes nothing and decides nothing. It binds a Girder job to a run: translates the
runner's readings into `JobManager` calls, hands the runner Celery's revocation flag, and settles
the job on the right terminal status. Everything with a branch in it lives in `runner.py` and
`status.py`, where it can be tested without a broker, a Mongo or a GPU.

One task for every kind rather than one per kind: the only thing that differs between a
segmentation and a whole-slide nuclei run is three strings in `routing.ROUTES` and how long the
loop turns. Every model stays in its service (Inc 6 · D4).

Two invariants worth stating here, because both are easy to break later and neither shows up in a
passing test:

- **A cancel that cannot be delivered is refused, not faked** (`runner.request_cancel`). Reporting
  a job stopped while it still holds the GPU would be a lie the Runs list then repeats.
- **A stopped run is not a failed one.** Cooperative stop leaves usable bytes and a resumable
  state, so it settles as `CANCELED` carrying its tallies, exactly as a finished run carries its
  own.
"""

import os

import httpx
from girder_worker.app import app
from girder_worker.utils import JobStatus, girder_job

from ..routing import base_url, route_for
from ..runner import HTTP_TIMEOUT, drive, report_terminal
from ..status import Status, progress_message


# `girder_job`, not `@app.task(girder_job_title=...)`: the kwargs form is accepted silently and
# then ignored, leaving the class defaults at "<unnamed job>" / type "celery". `rest.py` overrides
# both per call, so a dispatched run would have been fine either way — but a bare `.delay()` would
# have produced a mistyped job, and `type` is what the Runs list filters on.
@girder_job(title="PathAssist analysis", type="pathassist")
@app.task(bind=True)
def run_analysis(self, *, kind: str, item: str, art_hash: str, params: dict,
                 girder_token: str | None = None, gateway_url: str | None = None) -> dict:
    """Drive one analysis run on this box, as a Girder job.

    The kwargs are what `rest.PathAssistResource.runAnalysis` passes; `girder_job_title` is
    overridden per call there, so the Runs list names the work rather than repeating the default
    above.

    `gateway_url` falls back to this box's own env because the gateway's address is a property of
    the driver's network rather than of Girder's — in this deployment Girder sits on `dsa_default`
    and the gateway on `agent_default`, so a value passed down from the dispatcher would be a name
    the dispatcher itself cannot resolve. The kwarg stays for tests and for a per-dispatch override.
    """
    gateway_url = gateway_url or os.environ.get("PATHASSIST_GATEWAY_URL", "")
    route = route_for(kind)
    # None when dispatched without a jobInfoSpec — a bare celery call with no Girder job behind it
    # (girder_worker/app.py:106). The run still happens; it just goes unrecorded.
    jm = self.job_manager

    def report(status: Status, job_id: str) -> None:
        if jm is None:
            return
        # Real counts when the service has them, the percentage when it does not. Girder's job
        # model has slots for both, which is why the bar can read "142 / 338 · nuclei" — the
        # numbers the services were already computing and discarding (plan §3).
        has_counts = status.total is not None and status.total > 0
        jm.updateProgress(
            total=status.total if has_counts else 100,
            current=status.current if has_counts else status.percent,
            message=progress_message(status),
        )

    payload = {"item": item, "girder_token": girder_token, **(params or {})}
    with httpx.Client(base_url=base_url(route), timeout=HTTP_TIMEOUT) as client:
        status = drive(client, kind, payload, report=report, is_canceled=lambda: self.canceled)

    if status.state == "failed":
        # Raising is what puts the Girder job in ERROR with this text in its log. Nothing is
        # reported to the gateway: nothing usable reached the disk.
        raise RuntimeError(status.error or f"{kind} failed")

    report_terminal(gateway_url, girder_token, item, art_hash, status)

    if status.state == "cancelled" and jm is not None:
        # A cooperative stop returns normally, so without this the job would settle on SUCCESS and
        # the Runs list would call a half-built artifact finished.
        jm.updateStatus(JobStatus.CANCELED)

    return {"kind": kind, "item": item, "art_hash": art_hash,
            "status": status.state, "result": status.result}
