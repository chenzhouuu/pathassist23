"""`POST /pathassist/run` — the only place a PathAssist analysis job is created.

This route exists for one structural reason (Inc 6 · D5). `girder_worker`'s
`create_task_job` hook fires on `.delay()` / `.apply_async()` and needs `cherrypy.request.app`,
`getCurrentUser()` and the model layer to do its work: mint the Girder job, put the `jobInfoSpec`
into the Celery headers so the driver can write back, and attach a scoped token. All three are
only reachable from inside the Girder process, so the dispatch has to happen here rather than in
the gateway that owns everything else about the request.

What this route deliberately does *not* do: compute an `art_hash`, look for a reusable artifact,
resolve upstream dependencies, or write a row. Those are the gateway's, and they stay there. This
is a dispatcher.
"""

import os

from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource
from girder.constants import TokenScope
from girder.exceptions import RestException
from girder_jobs.constants import JobStatus
from girder_jobs.models.job import Job

from . import KINDS
from .girder_worker_plugin.driver import run_analysis

#: Which box's queue a dispatch lands on. One queue per box at `concurrency=1` (Inc 6 · D6), so
#: the queue name *is* the placement decision, and a second GPU box is a second worker with a
#: different value here — no scheduler.
QUEUE = os.environ.get("PATHASSIST_QUEUE", "pathassist")

#: Human-facing titles. The Runs list shows these, so they name the work rather than the route.
TITLES = {
    "segmentation": "Tissue segmentation",
    "patching": "Tiling",
    "features": "Feature extraction",
    "prediction": "Downstream task",
    "nuclei": "Nuclei segmentation",
    "tissue": "Tissue map",
    "biomarker": "Marker map",
}


class PathAssistResource(Resource):
    def __init__(self, name="pathassist"):
        super().__init__()
        self.resourceName = name
        self.route("POST", ("run",), self.runAnalysis)

    @access.user(scope=TokenScope.USER_AUTH)
    @autoDescribeRoute(
        Description("Dispatch a PathAssist analysis run as a Girder job.")
        .notes("Called by the PathAssist gateway, which owns artifact identity and reuse. "
               "This route only creates the job and puts it on this box's queue.")
        .param("kind", "Which analysis to run.", enum=list(KINDS))
        .param("item", "The Girder item id of the slide.")
        .param("artHash", "The content address the gateway assigned to the result.")
        .param("title", "Overrides the job title shown in the Runs list.", required=False)
        # The one thing that cannot be a query param: an arbitrary dict of service parameters,
        # whose shape differs per kind and which can carry a list of regions. Girder's `.param()`
        # reads the query string, so everything scalar stays there and this is the body.
        .jsonParam("params", "Parameters for the analysis service.", paramType="body",
                   requireObject=True, required=False)
        .errorResponse("kind is not an analysis this server dispatches.", 400)
    )
    def runAnalysis(self, kind, item, artHash, title, params):
        if kind not in KINDS:
            # Refused here rather than discovered in the worker: a bad kind is a caller mistake,
            # and a caller mistake that reaches the queue is a mistake nobody sees for an hour.
            raise RestException(f"'{kind}' is not an analysis this server dispatches", code=400)

        user = self.getCurrentUser()
        token = self.getCurrentToken()

        async_result = run_analysis.apply_async(
            kwargs={
                "kind": kind,
                "item": item,
                "art_hash": artHash,
                "params": params or {},
                # The driver calls the analysis service and the gateway as this user. Both already
                # require a Girder token, so nothing gains a second auth surface.
                "girder_token": str(token["_id"]) if token else None,
                # `gateway_url` is deliberately NOT passed. The address of the gateway is a
                # property of the driver's network, not of Girder's: here Girder sits on
                # `dsa_default` while the gateway is on `agent_default`, so Girder cannot resolve
                # the name it would be handing out. The driver reads its own env instead.
            },
            queue=QUEUE,
            girder_job_title=title or f"{TITLES.get(kind, kind)} · {item}",
            girder_job_type="pathassist",
            girder_job_other_fields={"pathassist": {
                "kind": kind, "item": item, "artHash": artHash,
            }},
            girder_user=user,
        )

        job = async_result.job

        # girder_worker's `celery_handler` path leaves a dispatched job at INACTIVE until a worker
        # picks it up; only the older `worker_handler` path marks it QUEUED (event_handlers.py:61).
        # With `--concurrency=1` a second submission can sit there for an hour, and "inactive" is
        # the wrong word for a message that is already on the broker — a Runs list would read it as
        # never started. Say what is true. INACTIVE → QUEUED is a valid transition in both of
        # girder_plugin_worker's tables, so this asserts nothing the model disagrees with.
        if job.get("status") == JobStatus.INACTIVE:
            Job().updateJob(job, status=JobStatus.QUEUED)

        return {"jobId": str(job["_id"]), "celeryTaskId": async_result.task_id,
                "kind": kind, "item": item, "artHash": artHash, "queue": QUEUE}
