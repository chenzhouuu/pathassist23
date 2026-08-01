# 05 — Nuclei runs on the new path, and the artifact table sheds its job columns

**What to build:** the first real kind moves. Nuclei is submitted from the Analysis catalog, driven
by Celery, monitored in Runs, and read in the Workspace. The `Nuclei` tab goes.

This is where the source-of-truth split actually happens (plan D9): `status`, `stage`, `progress`
and `error` leave `preprocess_artifact`, `_reconcile_artifact` and its call site are deleted, and a
row becomes a claim that bytes exist on disk.

Nuclei is the closing ticket of Inc 6a because it is the kind that exercises everything at once —
hours-scale progress, cooperative stop, resume from partial coverage.

**Blocked by:** 01, 03, 04.

**Status:** done — with the column drop deferred to 07. See "What was not done, and why".

- [x] Nuclei submits through the catalog: a drawn region or the whole slide, with the whole-slide
      path still requiring a ready segmentation and saying why when there isn't one.
- [x] **D9 for nuclei**: no artifact row exists until the bytes do. The dispatch writes nothing;
      the row is written by the driver's report. `girder_job_id` added, and it names the run that
      produced the bytes.
- [ ] ~~`status` / `stage` / `progress` / `error` dropped from the table and from every reader.~~
      **Deferred to 07** — four kinds still reconcile against those columns.
- [~] ~~`_reconcile_artifact`, its one call site and the four worker status clients are deleted.~~
      One of the four is (`nuclei_job_status`, with `enqueue_nuclei` and `cancel_nuclei`). The
      other three and `_reconcile_artifact` go when the last kind that needs them moves.
- [x] The driver writes a row on `ready` **and** on `cancelled` — a stopped run left usable bytes
      and a resumable state. Nothing is written on failure; the failure is the Girder job.
- [x] Migration for existing rows: bytes on disk ⇒ keep, no bytes ⇒ delete. Report the counts.
- [x] `NucleiPanel.jsx`, `nucleiUtils.js` and the `nuclei` tab removed; the tests that cover the
      pure helpers move with the logic rather than being deleted.
- [x] **Verified on DEMO:** a whole-slide-extent run, stopped at 28/121 tiles and resumed, ending
      complete at 121 tiles / 16,093 nuclei. Queue position, tile-count progress, stop, resume and
      a mid-run page reload all checked in the browser.

## What was not done, and why

The ticket's second and third boxes describe the **end state** of the split, and the end state
needs every kind to be on the new path. Four are not: `segmentation` dispatches but still writes a
row at submit, and `patching` / `features` / `prediction` / `tissue` / `biomarker` still run on
their services' own queues and reach `ready` only through `list_slide_artifacts` reconciling them.
Dropping `status` now would leave those rows queued forever — their results, their counts and their
`artifact_ref` would never be written, which is not a display regression but a data one.

So D9 lands **per kind**, and nuclei is the first. Its shape is the whole of the rule:

```
dispatch  →  a Girder job, and nothing else
             (Runs shows it; the Workspace joins it on art_hash as a ghost row)
report    →  the artifact row, created here, carrying its counts and its girder_job_id
```

The columns come out in **07**, with the last kind. The design's own phasing says the same thing
(§6: "exactly one kind wired through: nuclei; the other four tabs stay untouched and keep working
on the old path"), and the alternative — moving all six kinds now — means rewriting four panels
that 06 and 07 delete.

## What moved

```
cellvit      POST /nuclei/hash        the address, computed without enqueuing anything
routing      Route.item_key           `slide_ref` for the three JobQueue services, `item` for preprocess
runner       service_payload()        the submit body, where it can be tested
             report_terminal(kind, params, girder_job_id)
gateway      start_nuclei             content-address → dispatch → no row
             report_artifact_result   creates the row when there isn't one
             — cancel_nuclei_build, nuclei polling, three nuclei clients
store        girder_job_id            which run made these bytes
frontend     workspace/nuclei.js      was panels/nucleiUtils.js, minus its panel half
             — NucleiPanel, the tab, cancelNuclei
```

`workspace/nuclei.js` is where the artifact half went because its two readers —
`workspace/artifactDetail.js` and `viewer/ArtifactLayers.jsx` — belong to neither panel, and the
Workspace is what owns an artifact's presentation now. Tissue and biomarker follow it in 06.

## The two things the ghost row needed

Both are consequences of "no row while it builds", and neither was obvious until the run was real.

- **The mask stops knowing it is growing.** `artifactRuns` is filled by the panels from the
  artifact rows they poll, and a building nuclei artifact has no row. `ArtifactLayers` now asks the
  runs store instead, which is the only thing that knows.
- **The Workspace stops knowing when to look.** Its poller runs while a *row* is in flight, and
  there is none — so a ghost would never have become a real row. It now refetches when a run for
  this slide leaves the unfinished set, which is exactly the moment the row appears.

## What the runs showed (2026-08-01, DEMO slide)

The artifact was deleted and rebuilt from nothing, which is what made stop and resume real.

```
18:10:06  start over the slide's full extent          121 core tiles
18:11:40  Runs:  20 / 121 · nuclei                    real counts, not a percentage
          Workspace: a ghost row, "Starting…", 26 / 121 · nuclei
18:12:10  Stop → "Stopping…" → stage `raster`         it finalises before it settles
18:13:04  settled CANCELED
          row created by the report: cancelled · stopped
          28 tiles · 7.50 mm² · 52 nuclei · remaining 93
18:13:16  start again  →  1 / 93 · nuclei             the denominator IS the remaining work
18:13:23  a second run queued behind it
          Runs:  2 active · "Waiting · 1 ahead" · Stop on both
          page reload mid-run: 2 active, "Waiting · 1 ahead" — nothing lost
18:27:10  both settled
          row: ready · done · 121 tiles · 32.41 mm² · 16,093 nuclei · remaining 0
```

121 is every tile of a 21911 × 21753 slide at a 2048 px core, so the interrupted-and-resumed build
covered the slide exactly once. Ticket 04's expansion re-checked against the new numbers: `Covered
121 tiles · 32.41 mm²`, `Total 16,093`, hiding a class refetches and keeps its count, opacity moves
the OSD layer without refetching a tile, and all of it survives a tab switch.

Migration, before any of this: 2 nuclei rows, both with bytes behind them, 0 deleted.

## Two things the deployment turned up, neither of them this ticket's code

- **This box's preprocess image has no torch**, so `POST /segment` returns the stub — a synthetic
  4096 × 4096 tissue square at the slide's origin (`stages.py:36`). A *seg-driven* whole-slide
  nuclei run therefore selects four cores of glass and finds nothing, which is what the first
  attempt did before the cause was found. The dispatch, the tile selection and the report were all
  correct; the segmentation was a placeholder. The run above uses a slide-sized region instead,
  which is the same `run_region` path with the tile list coming from the bbox rather than from
  contours. A seg-driven whole-slide run stays unverified on this box until the preprocess image
  carries a real segmenter.
- **A stopped run's `params` stay the ones that created the row.** A nuclei artifact is extended by
  however many runs it takes, so the row's `scope` is a fact about one of them. It is still stored —
  `girder_job_id` says which run — but the Workspace no longer displays it, because "region" on a
  map three later runs extended over the whole slide is the misleading half. What it covers is its
  coverage record, which is the line underneath.
