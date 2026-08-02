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

import json
import os

import httpx
from girder_worker.app import app
from girder_worker.utils import JobManager, JobStatus, girder_job

from .. import TITLES
from ..routing import base_url, route_for
from ..runner import HTTP_TIMEOUT, drive, report_terminal, service_payload
from ..status import Status, progress_message


# `girder_job`, not `@app.task(girder_job_title=...)`: the kwargs form is accepted silently and
# then ignored, leaving the class defaults at "<unnamed job>" / type "celery". `rest.py` overrides
# both per call, so a dispatched run would have been fine either way — but a bare `.delay()` would
# have produced a mistyped job, and `type` is what the Runs list filters on.
@girder_job(title="PathAssist analysis", type="pathassist")
@app.task(bind=True)
def run_analysis(self, *, kind: str, item: str, art_hash: str, params: dict,
                 girder_token: str | None = None, gateway_url: str | None = None,
                 chain: dict | None = None) -> dict:
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
    # (girder_worker/app.py:106), and also every link of a chain after the first (see below).
    jm = self.job_manager or _job_for_chained_step(
        self, kind=kind, item=item, art_hash=art_hash, chain=chain)
    # The signal handlers that settle the job on SUCCESS / ERROR read `sender.job_manager` after
    # the body returns (`girder_worker/app.py::gw_task_success`), so a job minted here has to be
    # put back on the task or it would never leave RUNNING.
    self.job_manager = jm

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

    payload = service_payload(kind, item, girder_token, params)
    with httpx.Client(base_url=base_url(route), timeout=HTTP_TIMEOUT) as client:
        status = drive(client, kind, payload, report=report, is_canceled=lambda: self.canceled)

    if status.state == "failed":
        # Raising is what puts the Girder job in ERROR with this text in its log. Nothing is
        # reported to the gateway: nothing usable reached the disk.
        raise RuntimeError(status.error or f"{kind} failed")

    report_terminal(gateway_url, girder_token, item, art_hash, status,
                    kind=kind, params=params, girder_job_id=_job_id(jm))

    if status.state == "cancelled" and jm is not None:
        # A cooperative stop returns normally, so without this the job would settle on SUCCESS and
        # the Runs list would call a half-built artifact finished.
        jm.updateStatus(JobStatus.CANCELED)

    return {"kind": kind, "item": item, "art_hash": art_hash,
            "status": status.state, "result": status.result}


def _job_for_chained_step(task, *, kind: str, item: str, art_hash: str, chain: dict | None):
    """Mint this step's Girder job, for a link of a chain that arrived without one.

    **Why this exists, measured on the DEMO slide (Inc 6 · 07).** `girder_worker` does create a job
    per published task, including the links a chain publishes from inside the worker — that is what
    `context/nongirder_context.py` is for. But it posts the job over REST with
    `gc.post('job', parameters={... 'kwargs': <dict> ...})`, and `requests` encodes a dict-valued
    query parameter as one repeated key per entry. Girder answers
    `400: Parameter "kwargs" must not be specified multiple times`, upstream logs
    *"Failed to post job"* and carries on. The step runs correctly and is invisible: a three-step
    build showed one row in the Runs list and produced all three artifacts.

    `args` and `otherFields` in that same call are `json.dumps`'d and `kwargs` is not, so this is a
    one-field omission upstream rather than a design we are working against. The fix is the same
    call made correctly, from the one place that already knows what this step is.

    Minted here rather than pre-created at dispatch on purpose: a job then exists exactly when a
    step *starts*. Pre-creating all N would mean rows for steps that may never run — a chain stops
    at its first failure — sitting INACTIVE for ever in a list whose whole job is saying what is
    actually running.

    The chain metadata travels in the task's **kwargs**, not its headers: the publish hook strips
    every `girder_job_*` header after using it (`girder_worker/app.py`, `Task.reserved_options`),
    so by the time a step runs its own position is only where it was serialised.

    Best-effort: a step that cannot record itself still runs, which is the same bargain
    `report_terminal` makes. Returns a `JobManager` or None.
    """
    client = getattr(task, "girder_client", None)
    if client is None:
        return None
    pa = {"kind": kind, "item": item, "artHash": art_hash,
          "queue": os.environ.get("PATHASSIST_QUEUE", "pathassist")}
    if chain:
        pa["chain"] = chain
    other = {
        "celeryTaskId": task.request.id,
        "celeryParentTaskId": getattr(task.request, "parent_id", None),
        "pathassist": pa,
    }
    try:
        job = client.post("job", parameters={
            "title": f"{TITLES.get(kind, kind)} · {item}",
            "type": "pathassist",
            "handler": "celery_handler",
            "public": False,
            "args": json.dumps([]),
            # The whole point: a JSON string, not a dict. See above.
            "kwargs": json.dumps({"kind": kind, "item": item, "art_hash": art_hash}),
            "otherFields": json.dumps(other),
        })
        spec = (job or {}).get("jobInfoSpec")
        if not spec:
            return None
        jm = JobManager(**spec)
        # A new job is INACTIVE, and `INACTIVE → SUCCESS` is not a transition girder_jobs allows —
        # measured, as `Invalid state transition to '3', Current state is '0'`, on a prediction
        # step short enough to finish before any progress arrived. `task_prerun` does this for a
        # job that came with a spec; a job minted here has to do it for itself. Inside the guard
        # with the rest: it is a second network call, and this whole function is bookkeeping.
        jm.updateStatus(JobStatus.RUNNING)
        return jm
    except Exception:                                  # noqa: BLE001 — never fail a run over this
        return None


def _job_id(jm) -> str | None:
    """This run's Girder job id, off the update URL girder_worker handed the JobManager.

    The job is minted by the `create_task_job` hook during `apply_async`, so its id does not exist
    when the kwargs are built and cannot be passed in. What the worker *is* given is
    `jobInfoSpec.url` — `{apiUrl}/job/{jobId}` — which is the id's only carrier on this side
    (girder_worker/utils.py, `JobManager.url`).

    Best-effort by design: `girder_job_id` records which run produced an artifact's bytes, and a
    row with the bytes and no provenance is worth more than a failed report.
    """
    url = getattr(jm, "url", None)
    if not url:
        return None
    tail = str(url).rstrip("/").rsplit("/", 1)[-1]
    return tail or None
