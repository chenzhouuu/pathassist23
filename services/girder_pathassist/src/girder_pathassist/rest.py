"""The two routes Girder has to serve for PathAssist analyses: dispatch one, and list them all.

`POST /pathassist/run` exists for one structural reason (Inc 6 · D5). `girder_worker`'s
`create_task_job` hook fires on `.delay()` / `.apply_async()` and needs `cherrypy.request.app`,
`getCurrentUser()` and the model layer to do its work: mint the Girder job, put the `jobInfoSpec`
into the Celery headers so the driver can write back, and attach a scoped token. All three are
only reachable from inside the Girder process, so the dispatch has to happen here rather than in
the gateway that owns everything else about the request.

What that route deliberately does *not* do: compute an `art_hash`, look for a reusable artifact,
resolve upstream dependencies, or write a row. Those are the gateway's, and they stay there. It is
a dispatcher.

`GET /pathassist/runs` is the one route D3 budgeted for. `GET /job` cannot answer the question the
Runs list asks, for three measured reasons: it lists **one user's** jobs while a queue position is
only explicable if the run ahead of you is visible (`job_rest.py:44`, and `GET /job/all` is
`@access.admin`); it drops `pathassist`, the `girder_job_other_fields` that says which slide and
which kind (`models/job.py:29`); and the fields that *would* carry the slide — `kwargs`,
`_original_params` — hold live Girder tokens, so the answer has to be assembled rather than
filtered. `runs.py` holds the assembly; this file holds the queries.
"""

import datetime
import os

from bson.errors import InvalidId
from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource
from girder.constants import AccessType, SortDir, TokenScope
from girder.exceptions import RestException
from girder.models.file import File
from girder.models.item import Item
from girder_jobs.constants import JobStatus
from girder_jobs.models.job import Job

from . import KINDS, runs
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


#: How many settled runs the list carries. Unfinished ones are never trimmed to this — see
#: `listRuns` — because they are what the caller is waiting on.
FINISHED_LIMIT = 25

#: A backstop on the unfinished half. At `concurrency=1` a real queue is single digits; a hundred
#: means something is wrong, and the Runs list should stay small enough to render while it is.
UNFINISHED_CAP = 100


class PathAssistResource(Resource):
    def __init__(self, name="pathassist"):
        super().__init__()
        self.resourceName = name
        self.route("POST", ("run",), self.runAnalysis)
        self.route("GET", ("runs",), self.listRuns)

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
                # Which queue this landed on. A position in a queue only explains a wait if
                # everything counted shares one worker, and nothing else on the job says which
                # worker that is.
                "queue": QUEUE,
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

    @access.user(scope=TokenScope.USER_AUTH)
    @autoDescribeRoute(
        Description("List analysis runs — every slide, every user.")
        .notes("The Runs list's only source. Scope is deliberately global (Inc 6 · D3): the GPU "
               "is shared, so a run that is waiting can only say why if the run ahead of it is "
               "visible. Rows the caller cannot read are returned counted but unnamed.")
        .param("limit", "How many settled runs to include. Unfinished runs are always all of "
                        "them.", required=False, dataType="int", default=FINISHED_LIMIT)
    )
    def listRuns(self, limit):
        user = self.getCurrentUser()
        jobModel = Job()
        query = runs.job_types_query()
        sort = [("created", SortDir.DESCENDING)]

        # Two queries rather than one page, because the two halves are bounded by different
        # things. Every unfinished run must be present or the arithmetic behind "1 ahead" is wrong;
        # settled runs are history and a page of them is plenty.
        #
        # `find`, not `findWithPermissions`: the permission filter is what would drop exactly the
        # rows D3 asks for. Access is applied per row below instead, and decides what a row *says*
        # rather than whether it exists.
        unfinished = list(jobModel.find(
            dict(query, status={"$in": list(runs.UNFINISHED)}),
            sort=sort, limit=UNFINISHED_CAP, includeLog=False))
        finished = list(jobModel.find(
            dict(query, status={"$in": list(runs.FINISHED)}),
            sort=sort, limit=max(0, int(limit or 0)), includeLog=True))

        files: dict[str, dict | None] = {}
        items: dict[str, dict | None] = {}

        def loadFile(fileId):
            if fileId not in files:
                try:
                    files[fileId] = File().load(fileId, force=True, fields=["itemId"])
                except InvalidId:
                    files[fileId] = None
            return files[fileId]

        def loadItem(itemId):
            # `pathassist.item` is whatever the gateway sent at dispatch, so an id that is not an
            # id is a possible input here rather than an impossible one.
            if itemId and itemId not in items:
                try:
                    # `force=True` because this only ever produces a display name and a grouping
                    # key, and the row it lands on is already gated on the caller's access to the
                    # *job*.
                    items[itemId] = Item().load(itemId, force=True, fields=["name", "largeImage"])
                except InvalidId:
                    items[itemId] = None
            return items.get(itemId)

        rows = []
        for job in unfinished + finished:
            readable = bool(user) and jobModel.hasAccess(job, user, AccessType.READ)
            itemId = runs.item_id_of(job, loadFile) if readable else None
            item = loadItem(itemId) if readable else None
            rows.append(runs.row(
                job,
                readable=readable,
                mine=bool(user) and str(job.get("userId")) == str(user["_id"]),
                item_id=itemId,
                slide_name=item["name"] if item else None,
                slide_key=runs.slide_key(itemId, item),
            ))

        rows.sort(key=lambda r: r["created"] or datetime.datetime.min, reverse=True)
        return rows
