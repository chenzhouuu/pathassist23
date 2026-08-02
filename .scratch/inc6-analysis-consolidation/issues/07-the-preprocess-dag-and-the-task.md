# 07 — The preprocess DAG and the downstream task move across

**What to build:** the last four kinds — `segmentation`, `patching`, `features`, `prediction` —
move together, because they are one chain and splitting them would mean maintaining a half-migrated
chain across two job systems.

Segmentation has been driven by Celery since 01 as the substrate's proving kind; this is where its
old path is removed and the other three join it.

**Blocked by:** 05.

**Status:** done — verified on DEMO.

- [x] All four kinds submit through the catalog. Preprocess is one entry with its build target
      (encoder binds patch size — Fork B), not three entries.
- [x] The task entry keeps what Inc 2c earned: the declared `feature_spec`, the honest statement of
      what the classifier was trained on, and its caveat.
- [x] Chained submission uses Celery chain with Girder parent/child jobs; all rows are written at
      submit time from the hashes computable then (plan D7). **Amended in two places — see below.**
- [x] Runs shows a chain as a parent with its children, so "3 steps, on step 2" is legible.
- [x] The MIL evidence heatmap keeps working; it is a prediction artifact's layer and belongs in
      the Workspace row like every other.
- [x] Segmentation's pre-01 submission path deleted.
- [x] `PreprocessPanel.jsx`, `TaskPanel.jsx` and their tabs removed. Nine tabs → seven.
- [x] **Verified on DEMO:** from a slide with nothing built, run the full chain to a BRCA IDC/ILC
      call in one submission; the three-step progress is legible throughout and the prediction
      matches what the old path gives for the same feature index.

## What moved

```
preprocess svc POST /hash kind=prediction   the fourth address, off the task registry's model_ver
plugin         POST /pathassist/chain       an ordered submission, sequenced by celery.chain
               runs.chain_of                which submission a step belongs to, and where in it
               driver._job_for_chained_step a step minting its own job (see below)
               TITLES → __init__            both halves name a step now
gateway        gateway/plan.py              address the chain, then trim it to what is missing
               POST /slides/{item}/build    segment → tile → encode, one submission
               POST .../segment             a one-step chain; the pre-01 direct path is gone
               POST .../predict             feat_hash optional — find the matching index or build it
               — _reconcile_artifact, _RECONCILED_KINDS, _trigger_dag_stage, /patch, /features
frontend       analysis/encoders.js         was panels/preprocessUtils.js, minus its DAG half
               workspace/prediction.js      was panels/taskUtils.js, minus its planning half
               nativeCatalog                + Feature index; the task entry keeps the model card
               ParamField                   an option may carry a `note` — the model card
               runsUtils.chainGroups        several rows that are one submission
               RunsSection.ChainGroup       drawn as one thing with its steps under it
               artifactDetail.prediction    the call, the bars, overlay / side-by-side
               ArtifactLayers.PredictionEvidence   the heatmap document, while the eye is on
               — PreprocessPanel, TaskPanel, their tabs, startPatch, startFeatures
```

## Four calls worth not re-litigating

**A chain has no parent job.** Every step carries the same `chain.id` and its own position, and the
Runs list assembles the group from that. A real parent job would have to be created before its
steps, which means rows for steps that may never run — a Celery chain stops at its first failure,
and those two rows would sit INACTIVE for ever in a list whose whole job is saying what is actually
running. So `total` says how many steps were asked for and a row exists only where a message was
published. That is the amendment to "Girder parent/child jobs".

**No row is written at submit time either** — the other amendment, and it is 05's rule rather than
a new one: dispatch writes nothing, the driver's report creates the row, and a row is a claim that
bytes exist. What D7 actually needed from submit time is the *hashes*, and those are all computable
then, which is what lets the whole chain be addressed before the first job starts and every link be
submitted immutable.

**Missing steps are found backwards from the target.** A step whose bytes exist need not run, and
that is true whether or not its own parent still exists — content addressing means the bytes *are*
the artifact. Walking forwards would rebuild a patch grid in order to reach a feature index that is
already on disk. A submission with nothing left to run is answered rather than queued, and the
banner says *already built, nothing to run* rather than "submitted".

**The task entry has no required feature index.** Naming one is for a slide with several and a
deliberate choice; leaving it empty is the normal case, and the gateway then looks for an index
matching the task's declared `feature_spec` and plans the build when there is none. What it will not
do is run on whatever index happens to be there: an ABMIL head fitted on CONCH v1 will consume UNI
vectors of the same width and return a confident number, and nothing downstream would say it was
nonsense.

## What the runs showed (2026-08-02, DEMO slide)

```
06:15  task submitted with no index, slide had a segmentation only
       planned 3 steps — the existing segmentation reused, not re-cut
       Runs:  Breast · IDC vs ILC (TCGA-BRCA)      Step 1 of 3
                Tiling                Running · starting     [Stop]
       … and then two bugs, below.

06:29  after both fixes, same submission
       Tiling              step 1/3   Done   325 patches
       Feature extraction  step 2/3   Done   325 × 512, conch_v1
       Downstream task     step 3/3   Done   IDC 0.822 / ILC 0.178
       Runs group heading: "Breast · IDC vs ILC (TCGA-BRCA) · 3 steps · done"
```

The Workspace row for the prediction, opened:

```
Prediction    Call IDC · Confidence 0.82
              1 IDC 82.2%   2 ILC 17.8%
              Show as | Overlay · Side by side | Opacity 0.55
              325 patches · 2 ms · abmil-conch-brca-fold0-v1 · Blue supports ILC,
              red supports IDC. Per-patch evidence from the attention head — where
              the model looked, not a diagnosis of that tile.
```

Both modes draw: Overlay blends the diverging ramp into the H&E, Side by side opens the second
synced pane the CLAM demo calls *Side By Side*. The task option carries the whole Inc 2c model card
— required build, classes, cohort, AUC/Acc/F1, and the caveat — as a note under the picker.

## Three bugs the run turned up, none of them in the plan

- **`/hash` addressed a feature index with the wrong version constant.** The `features` branch used
  `index_version` while `/features` uses `feat_version`, so a build finished under a name the
  gateway had never heard of and the prediction behind it was refused `409: extract features for
  this slide first` — for an index that was sitting on disk. This is exactly the failure the `/hash`
  endpoint exists to prevent, inside the endpoint. The test now asserts the equality per kind rather
  than for segmentation only.

- **A chained step got no Girder job.** `girder_worker` does create one per published task — that is
  what `context/nongirder_context.py` is for — but it posts it with `kwargs` as a dict, and
  `requests` encodes a dict-valued query parameter as one repeated key per entry. Girder answers
  `400: Parameter "kwargs" must not be specified multiple times`; upstream logs *"Failed to post
  job"* and carries on. So a three-step build produced all three artifacts and showed one row.
  `args` and `otherFields` in that same call **are** `json.dumps`'d, so it is a one-field omission
  upstream. The driver now mints its own job for a chained step, and `girder_job_disable` stops
  upstream attempting the broken call at all.

- **A minted job stopped at INACTIVE.** `INACTIVE → SUCCESS` is not a transition `girder_jobs`
  allows, and a prediction step that finishes in a second never reports progress on the way. Visible
  as `Invalid state transition to '3', Current state is '0'` and a Done run reading *Inactive*. A
  job minted by the driver moves itself to RUNNING, which is what `task_prerun` does for a job that
  arrived with a spec.

## What did not come across

`status` / `stage` / `progress` / `error` are still columns on `preprocess_artifact`. Nothing writes
`queued`, `running` or `failed` to them any more — dispatch writes no row, so the only values left
are `ready` and `cancelled` — and `describeState` has stopped reading the other three. The `ALTER
TABLE` and the migration D9's R5 describes belong with the rest of the removal, in 09.
