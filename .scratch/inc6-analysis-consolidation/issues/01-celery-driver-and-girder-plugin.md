# 01 — A native job runs as a Girder job, through Celery

**What to build:** the substrate. A new Girder plugin creates the job; a generic Celery driver task
supervises the service that does the work; the job record carries real progress. One kind is wired
through to prove it — `segmentation`, because it finishes in about two minutes on the DEMO slide.

The driver does not compute anything. It POSTs to the service's existing route, polls its existing
`/status`, mirrors what it reads into the Girder job, and forwards a cancel. Model loading, warm-up
and idle GPU release are untouched (plan D4).

**Blocked by:** nothing.

**Status:** done

- [x] `girder_pathassist` plugin exposes `POST /pathassist/run` and calls `run_stage.delay(...)`
      inside the Girder process, so `create_task_job` mints the job, the `jobInfoSpec` and the
      scoped token (plan D5). Installed via `deploy/dsa5.Dockerfile` alongside the existing
      Keycloak patch.
- [x] One Celery task, parameterised by kind, reading its service URLs from box-local env. Not one
      task per kind.
- [x] A Celery worker container per box, started `-Q <box> --concurrency=1` against the existing
      `dsa-rabbitmq-1` (plan D6). It is our image, not `dsarchive/dsa_common_5`.
- [x] `Progress.__call__` takes optional `(current, total)`; `cellvit/nuclei.py:160` and the other
      report sites pass the numbers they already have. The job's progress reads
      `142 / 338 · nuclei`, not `42%`.
- [x] `PUT /job/{id}/cancel` reaches the service's cooperative stop, and the job settles on
      `cancelled` rather than `error`.
- [x] The gateway forwards to the plugin instead of calling the service; it still computes
      `art_hash`, checks reuse and writes the row.
- [x] **Verified on DEMO:** submit a segmentation, watch the job in Girder's own job list reach
      success with progress moving; kill the Celery worker mid-run and confirm the job is redelivered
      (`task_acks_late` is already set) rather than lost.
- [x] **Verified on DEMO:** submit two segmentations back to back and confirm the second is
      `queued`, not running.

## What the runs showed (2026-08-01, DEMO slide `6a6e1ca82ae96ce927e33818`)

Segmentation is the kind the gateway routes through the plugin, and it settled `ready` with the
artifact row written back by the driver. But the running preprocess here is the GPU-free stub, so a
segmentation finishes too fast to interrupt or to queue behind anything. The kill, queue and cancel
checks were therefore run on `nuclei`, dispatched straight at `POST /pathassist/run` — the same
driver, the same Girder job, the same queue, and a run long enough to catch in the act.

**Redelivery.** `docker kill agent-celery-1` at 89 % of a 9-tile run. rabbitmq immediately showed
`pathassist  messages=1  unacknowledged=0` — the unacked message came back, which is the whole
claim. On restart the worker logged `Task ...[83e45708] received` for the *same* task id and drove
it to SUCCESS. It finished in 8 s rather than starting over: the cellvit job the dead driver had
been watching kept running and persisted its tiles, so the re-submitted run found `remaining: 0`.
Redelivery is safe here because the services resume from their own artifact, not because the
dispatch is idempotent — a service without that property would recompute.

**Serialisation.** Two runs back to back at `--concurrency=1`: the second sat at `QUEUED` for the
first's full 2.5 minutes, then started within one poll of the first reaching SUCCESS.

**Progress.** `1 / 12 · nuclei` … `10 / 12 · nuclei` — the real tile counts, from the numbers
`nuclei.py:160` was already computing and discarding. Segmentation, which has no natural
denominator, correctly falls back to the percentage rather than inventing one.

**Cancel.** `PUT /job/{id}/cancel` → celery revoke → the driver noticed and POSTed
`/nuclei/cancel/{job}` → `CANCELING` for ~35 s while the run reached a clean core-tile boundary →
`CANCELED`, carrying `n_tiles: 52, remaining: 2, stopped: true`. A stopped run keeps its tallies
and is not an error.

## Three things the deployment corrected

- **A dispatched job sits at `INACTIVE`, not `QUEUED`.** girder_worker only marks a job queued on
  the older `worker_handler` path (`event_handlers.py:61`); the `celery_handler` path our
  `.apply_async()` takes goes straight from created to RUNNING. At `--concurrency=1` a second
  submission can wait an hour looking like it never started, so `rest.py` now makes the transition
  itself — a valid one in both of `girder_plugin_worker`'s tables.
- **The gateway↔plugin wire format was wrong and no test could have caught it.** Girder's
  `autoDescribeRoute.param()` reads the query string; only a `paramType="body"` jsonParam reads the
  body. Sending one JSON object got every scalar rejected as missing. Every existing test doubled
  `dispatch_run`, which is right for testing the gateway and blind to the wire — so two tests now
  assert the request itself against a `MockTransport`.
- **`gateway_url` cannot come from Girder.** It was being read in the Girder process and passed
  down. Girder is on `dsa_default` and the gateway on `agent_default`, so it would have been
  handing the driver a name it could not itself resolve. The driver reads its own env now.

Also worth knowing for the Runs-list ticket: `girder_job_other_fields` **is** stored on the job doc
(`job['pathassist'] == {kind, item, artHash}`) but Girder's REST layer filters it out of `GET /job`.
Exposing it, or reading `kwargs`, is that ticket's problem.
