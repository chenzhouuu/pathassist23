# 01 — A native job runs as a Girder job, through Celery

**What to build:** the substrate. A new Girder plugin creates the job; a generic Celery driver task
supervises the service that does the work; the job record carries real progress. One kind is wired
through to prove it — `segmentation`, because it finishes in about two minutes on the DEMO slide.

The driver does not compute anything. It POSTs to the service's existing route, polls its existing
`/status`, mirrors what it reads into the Girder job, and forwards a cancel. Model loading, warm-up
and idle GPU release are untouched (plan D4).

**Blocked by:** nothing.

**Status:** needs-triage

- [ ] `girder_pathassist` plugin exposes `POST /pathassist/run` and calls `run_stage.delay(...)`
      inside the Girder process, so `create_task_job` mints the job, the `jobInfoSpec` and the
      scoped token (plan D5). Installed via `deploy/dsa5.Dockerfile` alongside the existing
      Keycloak patch.
- [ ] One Celery task, parameterised by kind, reading its service URLs from box-local env. Not one
      task per kind.
- [ ] A Celery worker container per box, started `-Q <box> --concurrency=1` against the existing
      `dsa-rabbitmq-1` (plan D6). It is our image, not `dsarchive/dsa_common_5`.
- [ ] `Progress.__call__` takes optional `(current, total)`; `cellvit/nuclei.py:160` and the other
      report sites pass the numbers they already have. The job's progress reads
      `142 / 338 · nuclei`, not `42%`.
- [ ] `PUT /job/{id}/cancel` reaches the service's cooperative stop, and the job settles on
      `cancelled` rather than `error`.
- [ ] The gateway forwards to the plugin instead of calling the service; it still computes
      `art_hash`, checks reuse and writes the row.
- [ ] **Verified on DEMO:** submit a segmentation, watch the job in Girder's own job list reach
      success with progress moving; kill the Celery worker mid-run and confirm the job is redelivered
      (`task_acks_late` is already set) rather than lost.
- [ ] **Verified on DEMO:** submit two segmentations back to back and confirm the second is
      `queued`, not running.
