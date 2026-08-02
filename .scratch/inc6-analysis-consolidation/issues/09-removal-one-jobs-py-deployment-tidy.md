# 09 — Removal, one `jobs.py`, and clearing the deployment debris

**What to build:** the tidy-up that only becomes safe once every kind is across.

**Blocked by:** 08.

**Status:** done — verified on DEMO.

- [x] Four copies of `jobs.py` (preprocess, biomarker, tissue, cellvit) collapse into one shared
      module. `cellvit/jobs.py:1` recorded the third copy as the agreed trigger; this is the fourth.
      It keeps its role — the box-local serialiser under Celery's cross-service one.
- [x] Cooperative stop lives in that shared module rather than three times.
- [x] `RightPanel` is 7 tabs. No dead imports, no `hasRole` entries for tabs that no longer exist.
- [x] `preprocessApi.js` loses the routes that no longer exist; `taskApi.js`, `tissueApi.js`,
      `nucleiApi.js`, `biomarkerApi.js` keep only their tile and meta surfaces.
- [x] `dsa-worker-1`'s healthcheck no longer reports unhealthy — **diagnosed and written down, not
      changed from here.** The file belongs to another user and to upstream DSA; see below.
- [x] `pathagent-redis` is either wired to something or removed. **Kept, deliberately**, as the
      WebSocket ticket's input — the ticket's own reasoning, followed.
- [x] The plan's §9 out-of-scope list is still out of scope. Nothing drifted; see below.
- [x] **Verified on DEMO:** full sweep — build every artifact kind on the slide from empty, using
      only Analysis and the Workspace, with no reference to a removed panel.

## What moved

```
services/_shared/pathassist_jobs/   the one job queue — cellvit's version, which was the only one
                                    that carried current/total. preprocess gains a cooperative stop
                                    it never had; the other two gain the counts.
services/_shared/tests/             the one suite, beside the module rather than in any service
— preprocess/cellvit/tissue/biomarker  src/*/jobs.py  ×4, tests/test_jobs.py ×3
Dockerfiles ×7                      built from `services/`, so the shared module can be copied in
docker-compose (+3 overrides)       contexts follow
gateway            — POST /slides/{item}/preprocess, GET .../index, _reconcile,
                     get_slide_index_store, SlideIndexStore/Pg/Memory, slide_index.py,
                     trigger_preprocess, get_job_status
frontend           — startPreprocess, listSlideIndex, getBiomarkerCells
deploy/RUNBOOK.md  the healthcheck, the redis, and the `docker cp` loop for the shared module
```

## Three calls worth not re-litigating

**The shared module is put on the path, not installed.** `pythonpath = ["src", "../_shared"]` for
the suites; `COPY _shared/pathassist_jobs ./src/pathassist_jobs` for the images, which is why the
four build contexts moved up to `services/`. A versioned package would be four services pinning
four versions of a hundred lines of threading — which is the problem it was extracted to stop
having.

**It keeps its role, and it is not redundant with Celery.** Celery serialises work *across*
services on this box (D4/D6); this serialises it *within* one, so a service with two requests in
flight does not put two models on the A6000 at once. Two layers, two questions.

**The `slide_index` table stays in `pg.py`, unread.** Every code path to it is gone — it predates
the content-addressed DAG and had been unreachable from the UI since Inc 2b-3 — but dropping a
table is destructive and is somebody's decision rather than a tidy-up's.

## Two deployment findings, both written down rather than patched

**`dsa-worker-1` is not unhealthy.** Its healthcheck runs `celery inspect ping --timeout 10` inside
a Docker `timeout: 10s`: it answers correctly and is then killed for taking as long as it was told
it could. The health *log* says so —

```
ExitCode -1  Health check exceeded timeout (10s):
  ->  celery@71a9a92b946b: OK   pong
  ->  celery@6fd145e44333: OK   pong
```

— both workers answered. The fix is `timeout: 30s`, giving the check more room than the command it
runs; shortening the ping instead would remove the only thing that makes the check meaningful when
a worker really is wedged. The file is `/home/path01/dsa/docker-compose.yml`, owned by the `path01`
user and by upstream DSA, so it is not edited from this repo. Both the diagnosis and the one-line
change are in `deploy/RUNBOOK.md`.

**`pathagent-redis` is kept.** Idle since 2026-07-13 with no importer in the repo, and the ticket's
own reasoning applies: Girder 5's notification layer wants exactly one, which is almost certainly
why it was started, and it is the input to the WebSocket ticket (D8) that replaces the Runs list's
2.5 s poll. Deleting it would mean standing it back up to do that work.

## What the sweep showed (2026-08-02, DEMO slide)

All four services rebuilt on the new context, GPU images, running the shared queue:

```
agent-preprocess-1  jobs ok, cuda True
agent-tissue-1      jobs ok, cuda True
agent-biomarker-1   jobs ok, cuda True
agent-cellvit-1     jobs ok, cuda True
```

Tabs, read off the rendered page: `Workspace · Info · AI · Analysis · AskPA · Copilot · Panels`.
Seven, and none of them a removed panel.

Every kind planned on a slide with nothing built:

```
segmentation   Tissue segmentation
feature index  Tissue segmentation → Tiling → Feature extraction
nuclei         Tissue segmentation → Nuclei segmentation
tissue map     Tissue segmentation → Tissue map
marker map     Tissue segmentation → Nuclei segmentation → Marker map
```

A marker map submitted from the catalog and stopped from the Runs list, with nothing else open:
`1 step · 1 queue slot` → Running · sampling → Running · tiles → Stop → Stopped. The DEMO slide now
carries **all seven kinds** — segmentation, patching, features, prediction, nuclei, tissue,
biomarker — every one of them built through Analysis and read in the Workspace.

## Still outstanding, and why

**D9's column drop.** `status` / `stage` / `progress` / `error` are still on `preprocess_artifact`.
Nothing writes `queued`, `running` or `failed` to them any more — dispatch writes no row, so the
only values left are `ready` and `cancelled` — and nothing reads `stage`, `progress` or `error`.
What still reads `status` is complete-vs-stopped, which the design says `result.coverage` should
carry instead. That is a schema migration plus a frontend change, it is not one of this ticket's
boxes, and R5's "decide each existing row from disk" is a data decision. It belongs in its own
ticket beside the WebSocket one.

## The plan's §9 out-of-scope list, checked

- Consolidating `AI` / `AskPA` / `Copilot` (D10) — untouched. Three tabs, as before.
- The ASGI + WebSocket switch (D8) — untouched; `pathagent-redis` is kept *for* it.
- Moving inference into Celery workers — did not happen. Every model is still in its service; the
  driver still drives them over local HTTP.
- Multi-machine deployment — still a configuration change nobody has performed. `PATHASSIST_QUEUE`
  and the box-local service URLs are the whole of it.

Nothing drifted.
