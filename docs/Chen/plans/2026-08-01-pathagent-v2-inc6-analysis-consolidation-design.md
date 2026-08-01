# PathAgent v2 · Inc 6 — Analysis Consolidation + Celery Job Substrate · Plan

> **Date:** 2026-08-01
> **Author:** Chen (with Claude)
> **Status:** Plan — awaiting sign-off. No code written.
> **Reuses:** Inc 2b (`preprocess_artifact` DAG), Inc 2c (MIL task), Inc 3b (marker map),
> Inc 4 (tissue map), Inc 5 (Workspace + OHIF vendoring, nuclei artifact, cooperative stop).
> **Ask (verbatim):** 现在整个 panel 中有太多的 AI 功能了，我需要把 preprocess、markers、
> tissue、nuclei、task，全部整合到 analysis 中。你需要首先查看 analysis 的代码以及 framework，
> 然后深度思考如何进行整合。最重要的是考虑不同 job 的提交，比如我提交了 preprocess 任务，
> 又提交了 nuclei 任务，应该如何有效地管理这些任务。同样，你不需要自己创造代码以及 idea，
> 但是你需要从已经有的 open-source project 中找到类似的功能，复制并 modify 他们的实现。
> **Amendment (verbatim):** 我需要稳定的 job 分配运行 · 以后如果实现多机器管理的话怎么办 ·
> 找一张相对较小的 brca WSI，创建一个新的 folder 就叫 DEMO，在这张 WSI 上跑通，同时所有的
> 测试都需要集中在这张 slide 上

---

## 0. What this is

Two things the ask binds together, and a third the grilling turned up.

1. **Five task panels collapse into Analysis.** `Preprocess`, `Markers`, `Tissue`, `Nuclei` and
   `Task` stop being tabs and become entries in one algorithm catalog, beside the HistomicsTK
   docker CLIs that `AnalysisPanel` already lists. Twelve tabs become seven.
2. **Job management becomes real.** Submissions stop being an in-process `queue.Queue` per service
   and become Girder jobs dispatched through `girder_worker` / Celery — the substrate DSA already
   runs on this machine and that half of our own system already uses.
3. **The two halves of the artifact record separate.** `preprocess_artifact` stops pretending to be
   a job table and becomes what it is good at — a content-addressed registry with DAG lineage.
   Everything about a *run* moves to the Girder job.

These are one increment because the catalog is not worth building over a job model that cannot say
what is queued behind what, and the job substrate has no user-visible surface without the catalog.

---

## 1. Decision ledger (grilled with Chen, 2026-08-01)

| # | Decision | Choice | Why |
|---|---|---|---|
| **D1** | Integration shape | **One algorithm catalog**: `catalog → form → run`, HistomicsTK CLIs and the five native tools as peers | `AnalysisPanel` is already that state machine (`view: 'list' \| 'form' \| 'running'`, `AnalysisPanel.jsx:221`). A second-level tab bar would rename the problem; an accordion would leave the CLI list unrelated to everything else. |
| **D2** | Responsibility split | **Analysis submits and monitors. Workspace owns results and layers.** | The eye already lives in the Workspace (Inc 5 · D7/03b), and the layer parameters already live in the store *because* a panel unmounts on every tab switch. Moving the controls next to the eye makes that structural instead of a workaround. Harvest target: OHIF `SegmentationTable`'s `Config` + `Segments`. |
| **D3** | Runs list scope | **Global — every slide, every user** | The A6000 is shared. A queue position is only explicable if the thing ahead of you is visible. Costs one SQL predicate and one route; the table has no user column and does not grow one. |
| **D4** | Job substrate | **`girder_worker` / Celery, with a thin-driver task** | The requirement is stable distribution and multi-machine. A control-plane-only fix leaves the actual queue hand-rolled (four copies of `jobs.py`) and makes a second GPU box a scheduler-writing exercise. The **models do not move**: the Celery task drives each service's existing `POST` + `/status` + `/cancel` over local HTTP and mirrors progress into the Girder job — the shape `slicer_cli_web` already uses to drive docker containers. |
| **D5** | Who creates the Girder job | **A new Girder plugin** (`girder_pathassist`) | `girder_worker/context/girder_context.py::create_task_job` must run inside the Girder process — it needs `cherrypy.request.app`, `getCurrentUser()` and `ModelImporter` to mint the job, the `jobInfoSpec` and the scoped token. The gateway stays in the path because `art_hash`, dedup and lineage are its job. |
| **D6** | Queue topology | **One queue per box, `concurrency=1`** | Never OOMs, queue semantics are one sentence, and a second box is one more worker with one more queue name. Rejected: a `heavy`/`light` split (better utilisation, more failure modes) and per-kind queues (today's unmanaged 4-way concurrency, only visible). This is a `-Q` flag, not code — revisit cheaply. |
| **D7** | Missing upstreams | **One planner + Celery chain + Girder parent/child jobs** | Replaces `preprocessUtils.nextChainStep` and `taskUtils.pendingStages`. Every `art_hash` is computable at submit time (`artifacts.py`: `seg_hash(params)`, `patch_hash(parent, …)`, `feat_hash(parent, …)` — params and parent only, never output bytes), so all three rows exist before the first job starts. Girder models the job DAG natively (`createJob(parentId=…)`, `_validateChild`). |
| **D8** | Status transport | **Poll `GET /job`; the WebSocket is a separate deployment ticket** | Girder 5's push needs `girder.asgi:app` + a Redis (`girder/notification.py`); the deployment runs `gunicorn girder.wsgi:app --workers=32`, and `GET /notifications/me` measured **404**. Switching a running deployment's serving model deserves its own risk window. The frontend is `applyJobEvent(job)` either way. |
| **D9** | Source of truth | **A row exists ⟺ bytes exist on disk.** `status`/`stage`/`progress` leave the artifact table | Removes the two-truths problem instead of synchronising it, and deletes `_reconcile_artifact` with its "nobody looking ⇒ nothing advances" defect. Run state, failures and logs live in the Girder job, which is durable in Mongo and survives every restart. |
| **D10** | Scope | **The five task panels only.** `AI` / `AskPA` / `Copilot` untouched | Their consolidation is a different question — which conversational surface wins — and folding it in would make this increment unbounded. 12 → 7 tabs. |
| **D11** | Delivery | **Vertical slice: shell + nuclei end-to-end first**, then replicate | The risk is concentrated in the substrate, not the UI. Verified on the DEMO slide (§7). |

**Determined by fact, not chosen:**

- **The CLI half needs no work.** `runCliByPath` already creates a Girder job through
  `slicer_cli_web`; it appears in `GET /job` the moment the Runs list reads that endpoint.
- **Each service keeps its in-process queue** as a local serialiser. Celery's `concurrency=1`
  governs the cross-service layer, which today does not exist at all.
- **A stopped run leaves a row.** Cooperative stop's whole point is that computed bytes stay on
  disk and a re-run resumes; under D9 those bytes require a row. Complete-vs-partial is carried by
  `result.coverage`, which is why `status` is not needed to express it.
- **The TCGA-BRCA collection is entirely frozen sections** (793 TS / 73 BS / 12 MS, zero DX). The
  ABMIL classifier's cohort line — "TCGA-BRCA — 942 cases" — is exactly this collection, so a `TS`
  demo slide is the correct input rather than a compromise.

---

## 2. Open-source survey (per the standing harvest rule)

Everything below is readable on this machine — the Girder source is checked out at
`/tmp/pathassist-girder-src`, and the running containers are the deployed form of it.

### The job substrate — the analogue is the floor we are standing on

`docker ps` carries three containers nobody in this repo wrote:

| Container | What it is |
|---|---|
| `dsa-rabbitmq-1` | Celery broker |
| `dsa-worker-1` | `girder_worker` — Celery worker, `DSA_WORKER_CONCURRENCY=4` |
| `dsa-girder-1` | Girder + `girder-jobs` + `girder-plugin-worker` + `girder-slicer-cli-web` + `histomicsui` |

Every HistomicsTK CLI submitted from `AnalysisPanel` already runs on it. What we take:

- `plugins/jobs/girder_jobs/` — the job model: status enum, `progress {total, current, message}`,
  appendable `log`, `parentId`, and REST (`GET /job`, `GET /job/all`, `PUT /job/{id}/cancel`,
  `GET /job/typeandstatus`).
- `worker/girder_worker/task.py::Task` — a Celery task carrying `girder_job_title` /
  `girder_job_type` headers, which creates and drives a Girder job on `.delay()`.
- `worker/girder_worker/utils/__init__.py:231::JobManager` — `updateStatus` / `updateProgress` /
  `write`, the handle a running task writes back through.
- `plugins/slicer_cli_web/slicer_cli_web/girder_worker_plugin/cli_progress.py` — the **shape** of a
  thin driver: a Celery task that supervises an external process and mirrors its progress into the
  job. Our driver supervises a local HTTP service instead of a docker container.
- `plugins/jobs/girder_jobs/web_client/views/JobListWidget.js` (338 lines) — the Runs list's
  interaction model: type/status filters, multi-select, bulk cancel, and the event names
  (`g:event.job_status`, `g:event.job_created`) the poller will emit locally and a future
  WebSocket will emit for real.

The deployment has already been tuned for job durability: `deploy/dsa5.Dockerfile` appends
`task_acks_late = True` and `task_reject_on_worker_lost = True` to `celeryconfig.py`.

### The Workspace expansion — continue the Inc 5 vendoring

`src/components/workspace/vendor/ohif/PanelSection.tsx` says in its own header that this directory
is where the rest of OHIF's segmentation table lands. `SegmentationTable.Config` (opacity / outline
sliders) and `SegmentationTable.Segments` (a row per segment with its own eye and colour swatch)
are the components D2 needs; the class checkboxes in `NucleiPanel` and the channel list in
`MarkersPanel` are segment rows wearing a different name.

### The catalog — no new source needed

`AnalysisPanel`'s Slicer-CLI XML → form generator stays as-is and gains a sibling: native tools
declare their form as data rather than as XML. Nothing is harvested here because the analogue is
already in the file.

---

## 3. What exists today (measured, 2026-08-01)

- **12 tabs**, 9 gated on `hasRole('ai-users')` (`RightPanel.jsx:56`).
- **Two job systems.** Girder jobs for CLIs; `POST /slides/{item}/<kind>` → a `preprocess_artifact`
  row → `GET /slides/{item}/artifacts` for the five native tools.
- **`_reconcile_artifact` has exactly one call site** — `routes.py:688`, inside the artifact list
  route. A durable row therefore only advances while somebody has that slide's list open.
- **Worker job state is a process-local dict** (`jobs.py`, `self._status`). After a worker restart
  the gateway's poll 404s, `except httpx.HTTPError: continue` keeps the last known state, and the
  row is stuck `running` forever.
- **`jobs.py` exists four times** (preprocess, biomarker, tissue, cellvit). `cellvit/jobs.py:1`
  records that the third copy was the agreed trigger for extraction.
- **Cooperative stop exists for tissue and nuclei only.**
- **Progress is lossy at the source.** `cellvit/nuclei.py:160` computes
  `report("nuclei", (i + 1) / total)` — the numerator and denominator are right there and are
  discarded because `Progress.__call__` takes `(str, float)`.
- **`pathagent-redis` has idled for two weeks** with no importer anywhere in the repo. Girder 5's
  notification layer wants exactly one (`GIRDER_NOTIFICATION_REDIS_URL`), which is probably why it
  was started.

---

## 4. The job path, end to end

```
browser
  │  POST /slides/{item}/nuclei          (unchanged public shape)
  ▼
gateway (FastAPI)
  │  compute art_hash · check reuse · plan missing upstreams (D7)
  │  upsert the row(s)                    ← queued, no status machinery
  │  POST /pathassist/run                 (kind, item, params, art_hash, parent job)
  ▼
girder plugin  (new, ~150 lines)
  │  run_stage.delay(...)  →  create_task_job() mints the Girder job,
  ▼                            jobInfoSpec + api_url + scoped token into the headers
rabbitmq  ──────────────────────────────────────────────────────────────────
  ▼
celery driver  (new, ~80 lines, one generic task parameterised by kind)
  │  POST  {LOCAL_SERVICE}/nuclei            ← the service's existing route
  │  loop: GET {LOCAL_SERVICE}/status
  │        jm.updateProgress(current=142, total=338, message='nuclei')
  │        if self.canceled: POST {LOCAL_SERVICE}/.../cancel
  │  on terminal: PATCH the gateway's artifact row (ready | cancelled) or leave none (failed)
  ▼
cellvit service (unchanged)
     FastAPI · warm CellViT-SAM-H · in-process queue · cooperative stop
```

**Multi-machine** is the same picture twice. Each box runs the five services plus one Celery worker
started with `-Q <box>`; the driver's service URLs come from box-local env. Placement is a routing
key. No scheduler is written.

**Latency.** service → driver (1 s, same box) → job record → browser (2.5 s) ≈ 3.5 s worst case,
against 2.5 s today. The second returns when D8's WebSocket ticket lands.

---

## 5. Data model after the split

```
preprocess_artifact                    girder job
  art_hash        content address        status        queued/running/success/error/cancelled
  kind                                   progress      {total, current, message}
  parent_hash     DAG lineage            log           appended by the driver
  params                                 parentId      the chain's parent
  girder_job_id   ← new                  kwargs        {item, kind, art_hash}   ← the join key
  result / n_items / dim
  artifact_ref
  created_at
  ✘ status  ✘ stage  ✘ progress  ✘ error      (dropped — D9)
```

A Workspace row list is `(ready artifacts from Postgres) ∪ (in-flight jobs for this slide from
Girder)`, unioned on `art_hash`. Because the hash is known at submit time, a ghost row becomes a
real row without flicker — same key, more fields.

Deleting `status` is what makes `delete_artifact`, `usage/dependants` and reuse-matching trivially
correct: a row is a claim that bytes exist, and nothing else.

---

## 6. Phases

Sliced so each one is verifiable in the browser, on the DEMO slide.

### Inc 6a — the shell, and nuclei end to end
The Girder plugin, the driver task, the queue, the Analysis catalog shell with its Runs section,
the Workspace expansion, and exactly one kind wired through: `nuclei`. The other four tabs stay
untouched and keep working on the old path.

### Inc 6b — tissue and biomarker
The two other JobQueue-shaped kinds. Their panels' controls land in the Workspace; their tabs go.

### Inc 6c — the preprocess DAG and the task, plus the planner
Four kinds at once (`segmentation`, `patching`, `features`, `prediction`) because they are one
chain, which is what makes this the right place for the unified planner.

### Inc 6d — removal and tidy-up
Delete the five panels and their tabs, collapse the four `jobs.py` copies, and clear the deployment
debris (`dsa-worker-1` healthcheck timeout, `pathagent-redis`).

---

## 7. Test slide

Everything is verified on one slide, so results are comparable across runs and increments:

**`BRCA-DEMO / DEMO`** (folder `6a6e1ca82ae96ce927e33817`) →
`TCGA-WT-AB44-01A-01-TS1…svs`, item `6a6e1ca82ae96ce927e33818`,
21911 × 21753 px (0.48 Gpx) · 40× · mpp 0.253 · 8 levels · 35.5 MB.

Smallest primary-tumor slide in the cohort the ABMIL classifier was trained on. At 20× it is
roughly a 40 × 40 patch grid, so a whole-slide run is tens of minutes — long enough to exercise
stop and resume, short enough to iterate.

---

## 8. Risks

**R1 · rabbitmq becomes load-bearing for every AI feature.** Today its loss costs only the CLIs.
Mitigation: the services' own endpoints keep working, so the degraded mode is "no new jobs", not
"nothing works"; the Runs list must say which of the two it is.

**R2 · a driver task holds a Celery slot for hours.** Intended under D6 — that occupancy *is* the
serialisation. It does mean `task_acks_late` matters, and it is already set.

**R3 · one queue at `concurrency=1` makes a long job block short ones.** Accepted knowingly; the
escape hatch is a second box, which is the reason for D4. Revisit by changing a `-Q` flag.

**R4 · a new Girder plugin means rebuilding the DSA image.** `deploy/dsa5.Dockerfile` already
patches the image (the Keycloak provider is copied in and `__init__.py` rewritten), so the
mechanism exists; the cost is build time and a restart of a container that has been up 2 weeks.

**R5 · existing rows have no `girder_job_id`, and some are stuck `running`.** A migration must
decide each one from disk: bytes present ⇒ keep as a row; absent ⇒ delete. There is no third case,
which is the first dividend of D9.

**R6 · progress goes through one more hop.** Quantified in §4. Named here so the first measurement
on the DEMO slide is compared against a stated expectation rather than a memory.

---

## 9. Out of scope

- Consolidating `AI` / `AskPA` / `Copilot` (D10).
- The ASGI + WebSocket switch (D8) — its own deployment ticket.
- Moving inference into Celery workers (rejected under D4: it would discard warm models,
  CellViT-SAM-H warm-up and pathvlm's idle GPU release).
- Multi-machine deployment itself. Inc 6 makes it a configuration change; it does not perform it.
