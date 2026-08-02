"""What the Runs list is allowed to know about a job (Inc 6 · ticket 03).

Pure functions, no girder import, so the two things that are easy to get wrong — which fields
leave the server, and what a queued run is waiting behind — are testable without a Mongo.

The whitelist is the point of this module. A job document is not safe to forward:

- `kwargs` carries the `girder_token` the dispatcher handed the driver.
- `_original_params` (slicer_cli_web, `rest_slicer_cli.py:460`) carries `girderToken` in clear.
- `jobInfoSpec.headers['Girder-Token']` is the job's own write token.

All three are live credentials sitting on a document whose other fields the Runs list genuinely
needs, so the row is built field by field rather than filtered field by field. `girder_jobs` makes
the same call at a smaller scale: `exposeFields` puts `args`/`kwargs` behind SITE_ADMIN
(`models/job.py:32`), which is also why `pathassist` — our own `girder_job_other_fields` — never
appears in `GET /job` and why this route exists at all.
"""

import re

# girder_jobs.constants.JobStatus, repeated here rather than imported: this module is tested
# without girder installed, and these five integers are a wire format that Girder cannot change
# without breaking every existing client.
INACTIVE, QUEUED, RUNNING, SUCCESS, ERROR, CANCELED = 0, 1, 2, 3, 4, 5

#: girder_plugin_worker/status.py::CustomJobStatus — the states a celery-handled job passes
#: through. 824 CANCELING is the one the Runs list needs a word for: `jobs.cancel` puts a live job
#: there and leaves it until its runner settles it (event_handlers.py:107).
FETCHING_INPUT, CONVERTING_INPUT, CONVERTING_OUTPUT, PUSHING_OUTPUT, CANCELING = (
    820, 821, 822, 823, 824)

#: Everything a run can be while it still occupies the queue.
UNFINISHED = (INACTIVE, QUEUED, RUNNING, FETCHING_INPUT, CONVERTING_INPUT,
              CONVERTING_OUTPUT, PUSHING_OUTPUT, CANCELING)
#: Everything a run can be once it is over.
FINISHED = (SUCCESS, ERROR, CANCELED)

#: The queue a dispatch lands on when the job predates `rest.py` storing one.
DEFAULT_LANE = "pathassist"
#: Where a docker CLI runs. Not our queue, so it does not share our queue's positions — a nuclei
#: run waiting at `concurrency=1` is not waiting behind a HistomicsTK container.
CLI_LANE = "girder_worker"

_OBJECT_ID = re.compile(r"^[0-9a-f]{24}$")

#: How much of a failure gets copied onto the row. Enough for the last frame of a traceback and
#: the exception line under it; not enough to make the Runs list a log viewer.
REASON_CHARS = 400


def job_types_query() -> dict:
    """The Mongo predicate for "a job the Analysis catalog could have started".

    Two families, and the second is a convention rather than a constant: `slicer_cli_web` types
    its jobs `'%s#%s' % (image, cli)` (`rest_slicer_cli.py:441`), so the `#` is the CLI marker.
    That deliberately excludes `slicer_cli_web_job` (pulling a docker image,
    `docker_resource.py:53`) and `assetstore_import`, which are housekeeping rather than analysis.
    """
    return {"$or": [{"type": "pathassist"}, {"type": {"$regex": "#"}}]}


def has_started(job: dict) -> bool:
    """Whether this run ever reached RUNNING, read off the job's own status history.

    One fact, and it decides what a cancelled row says. `PUT /job/{id}/cancel` puts *any* live job
    into CANCELING (`event_handlers.py:107`) and leaves it for its runner to settle — but a run
    still sitting on the queue has no runner. Celery holds the revoked message in the worker's
    prefetch buffer and only discovers the revocation when it tries to execute it, which at
    `--concurrency=1` is after the run ahead of it finishes (measured: 824 for the full 60 s a
    probe was watched, then settled the moment the previous task returned).

    So CANCELING means two different things, and only the history separates them: a cooperative
    stop in flight, or a message that will be dropped unread. Calling the second one "Stopping…"
    for twenty minutes is the same wrong word `rest.py` refused for INACTIVE.
    """
    return any(t.get("status") == RUNNING for t in (job.get("timestamps") or []))


def chain_of(job: dict) -> dict | None:
    """Which multi-step submission this run belongs to, and where in it (Inc 6 · 07).

    A chain has **no job of its own**. Every step carries the same `id` and its own position, and
    the Runs list assembles the group from that — so this field is the only thing that makes three
    separate jobs one submission.

    That is a choice, and the alternative failed on its own terms. A parent job would have to be
    created before the steps, which means creating rows for steps that may never be published: a
    Celery chain stops when a link fails, so the two jobs behind it would sit INACTIVE for ever in
    a list whose whole job is saying what is actually running. Here a job exists exactly when a
    message was published, and `total` still says how many steps were asked for.

    `total < 2` is not a chain. `runAnalysis` dispatches one step and writes no chain field at all;
    this refuses one anyway, so a caller cannot make a single run look like a sequence.
    """
    pa = job.get("pathassist")
    c = pa.get("chain") if isinstance(pa, dict) else None
    if not isinstance(c, dict) or not c.get("id"):
        return None
    step, total = c.get("step"), c.get("total")
    if not isinstance(step, int) or not isinstance(total, int) or total < 2:
        return None
    return {
        "id": str(c["id"]),
        "step": step,
        "total": total,
        # What the whole submission was for, said once. Without it a group of three would have to
        # be named after its first step, which is the one that finishes first and stops being
        # what the user is waiting for.
        "label": str(c.get("label") or "") or None,
        "kinds": [str(k) for k in (c.get("kinds") or [])],
    }


def lane_of(job: dict) -> str:
    """Which queue this run competes for.

    A position is only an answer to "why am I waiting" if everything counted shares one worker.
    """
    pa = job.get("pathassist")
    if isinstance(pa, dict):
        return pa.get("queue") or DEFAULT_LANE
    return CLI_LANE


def cli_item_id(job: dict, load_file) -> str | None:
    """The slide a docker CLI is running on, recovered from the params it was submitted with.

    `prepare_task.py:298-310` picks the *primary indexed non-output input* as the job's subject and
    resolves a file-typed one to `file['itemId']`. Nothing writes that itemId onto the job, so this
    reverses it: walk the submitted params in declaration order and take the first value that is an
    ObjectId naming a real file. `outputAnnotationFile_folder` is a folder id and loads as nothing;
    `girderToken` is 64 characters and never matches.

    On a copied item this lands on the **origin**, not the copy the user opened, because a copy
    shares the original's `largeImage.fileId` — upstream's own `reference['itemId']` has exactly
    the same property. That is why a row carries `slideKey` as well: two runs are on the same
    slide when they read the same image file, whichever item they were submitted against.

    `load_file` is injected so this stays testable without a Mongo.
    """
    for value in (job.get("_original_params") or {}).values():
        if not isinstance(value, str) or not _OBJECT_ID.match(value):
            continue
        found = load_file(value)
        if found and found.get("itemId"):
            return str(found["itemId"])
    return None


def item_id_of(job: dict, load_file) -> str | None:
    """The slide this run is about, whichever family the job belongs to."""
    pa = job.get("pathassist")
    if isinstance(pa, dict) and pa.get("item"):
        return str(pa["item"])
    return cli_item_id(job, load_file)


def slide_key(item_id: str | None, item: dict | None) -> str | None:
    """What makes two runs "the same slide" for grouping.

    The image file, not the item. On this deployment the DEMO slide is a `copyOfItem` whose
    `largeImage.fileId` points at the original's file, so a native run (submitted against the copy)
    and a docker CLI run (resolved back to the original) name two different items and one slide.
    Keying on the file is what upstream already treats as the slide's identity — it is the id
    `ItemSelectorWidget.js:249` hands a CLI in the first place.
    """
    file_id = ((item or {}).get("largeImage") or {}).get("fileId")
    return str(file_id) if file_id else item_id


#: A line of `traceback.format_tb` output. Where the reason stops and the frames begin.
_FRAME = re.compile(r'^\s+(File ")')


def failure_reason(log, limit: int = REASON_CHARS) -> str | None:
    """Why a run failed, as girder_worker recorded it.

    `girder_worker/app.py:180` formats every task failure as
    ``'%s: %s\\n%s' % (type(exc).__name__, exc, ''.join(tb.format_tb(...)))`` and appends it as the
    log's last chunk — so the reason is the **first** line of the **last** chunk, and everything
    after it is stack. Both families arrive this way: the driver's `RuntimeError`, and a docker
    CLI, whose container output is earlier chunks with this one appended after them.

    Taking the tail of the log instead returns the innermost `raise` statement, which names the
    line that threw and not the thing that went wrong. Measured on a real failure, that read
    ``raise ServiceRefused(f"{kind} was refused ...")`` where the answer was
    ``ServiceRefused: nuclei was refused (400): slide_ref is required``.
    """
    if isinstance(log, str):
        log = [log]
    chunks = [str(c) for c in (log or []) if str(c).strip()]
    if not chunks:
        return None

    head: list[str] = []
    used = 0
    for line in chunks[-1].splitlines():
        line = line.rstrip()
        if not line.strip():
            continue
        if head and _FRAME.match(line):
            break
        if head and used + len(line) + 1 > limit:
            break
        head.append(line[:limit])
        used += len(line) + 1
    return "\n".join(head) or None


def row(job: dict, *, readable: bool, mine: bool, item_id: str | None,
        slide_name: str | None, slide_key: str | None = None) -> dict:
    """One run, field by field.

    `readable` is the caller's READ access on the *job*, and it gates three things: the title, the
    slide it names, and the log tail. The row is still returned when it is False, because D3's
    reason for listing other people's runs is that a queue position is unexplainable without them
    — and position needs only `created`, `status` and `lane`, none of which say anything about
    whose work it is.
    """
    status = job.get("status")
    progress = job.get("progress") or {}
    out = {
        "id": str(job["_id"]),
        "status": status,
        "created": job.get("created"),
        "updated": job.get("updated"),
        "lane": lane_of(job),
        # Queue mechanics, like `lane` and `status` — nothing about whose work it is, so it rides
        # on every row including the ones that are otherwise unnamed.
        "started": has_started(job),
        "readable": readable,
        "mine": mine,
    }

    if not readable:
        # Named, not hidden: the row has to be countable and it has to be obvious why it is here.
        out["title"] = "Another user’s run"
        return out

    pa = job.get("pathassist") if isinstance(job.get("pathassist"), dict) else {}
    out.update({
        "title": job.get("title") or job.get("type"),
        "type": job.get("type"),
        "kind": pa.get("kind"),
        "artHash": pa.get("artHash"),
        "itemId": item_id,
        "slideKey": slide_key,
        "slideName": slide_name,
        "progress": {
            "current": progress.get("current"),
            "total": progress.get("total"),
            "message": progress.get("message"),
        } if progress else None,
    })
    chain = chain_of(job)
    if chain:
        out["chain"] = chain
    if status == ERROR:
        out["reason"] = failure_reason(job.get("log"))
    return out
