# Inc 2c — MIL downstream task on the preprocess DAG (BRCA IDC vs ILC)

> **Builds on** `2026-07-23-pathagent-v2-inc2b-3-preprocess-dag-stages-design.md`. That increment
> ends at `features.h5` — an `[N, dim]` bag of CONCH patch embeddings plus each patch's level-0
> coordinate. That artifact *is* a MIL bag; this increment adds the fourth stage that consumes it.
> **Status: COMPLETE (2026-07-23).** All seven phases implemented and verified, including the
> browser E2E. Local only — not committed, not pushed.
>
> *Tests:* preprocess 118 passed / 11 skipped on the CPU env, 129 on a torch env; agent 169 passed;
> frontend 125 passed; both services ruff-clean, `npm run build` clean.
>
> *L1 — port fidelity: exact.* Beyond the 48-patch committed fixture, `/predict` → `/prediction`
> ran over 12 real TCGA-BRCA bags (882–4347 patches) against `lcr_mil.teacher.abmil.ABMIL`:
> `max|Δprobs| = 0`, `max|Δattention| = 0` — bit-identical, not merely within tolerance — and
> `max|Σevidence − logit_margin| = 1.16e-06` (float32 accumulation over thousands of terms).
>
> *L2 — preprocessing equivalence: equivalent.* An index built through the panel (4258 patches)
> reproduces the training extraction (4260 patches) to the printed precision: 0.914542555809021 vs
> 0.914542. See "Field results".
>
> *The browser E2E found two defects, both fixed:* the collapsed right rail carried a duplicate tab
> list that omitted Task, making it unreachable by default; and `conch_v1` named two near-orthogonal
> embedding spaces that shared a `feat_hash`, so a task could silently run on the wrong vectors.
> Neither was reachable by unit tests.
> **Scope:** one task (TCGA-BRCA IDC vs ILC), one slide at a time, one model. The task registry is
> built for N tasks from day one; only the BRCA entry is populated.
> **Reference UI:** `clam.mahmoodlab.org` (the CLAM demo). The site was unreachable while this was
> written (`ECONNREFUSED 34.75.45.111:443`); the spec below is taken from user-supplied screenshots,
> not from memory of the site.

## What the reference actually is

The CLAM demo's left panel holds `SELECT STUDY:` (task) → `SELECT PATIENT:` (case) → two mode
buttons `Side By Side` / `Overlay` → a three-row result table (`Ground Truth` / `Prediction` /
`Confidence`). The main area is **two viewport-synced viewers of the same slide**: left is clean
H&E, right is the same slide with the heatmap *blended into* it (tissue texture stays visible — it
is not an opaque heatmap). A shared toolbar and a `Sync` checkbox sit underneath. There are no
opacity/colormap controls and no top-K patch thumbnails.

## Agreed decisions

| # | Fork | Choice | Consequence |
|---|------|--------|-------------|
| 1 | **Model** | **ABMIL on CONCH** — `s3mil/tcga_brca/conch/abmil_fold0.pt` | Gated-attention ABMIL is CLAM's direct analogue (CLAM = gated-attn ABMIL + a clustering branch); one forward yields slide logits *and* per-patch attention. 796 KB, 10 weight tensors. DAB-MIL (12 attribute heads, test AUC 0.908) is the interpretable alternative and is **deferred** — it would replace the CLAM-shaped UI with an attribute UI. |
| 2 | **Feature-spec conflict** | **Task declares its spec; the panel validates and offers to build** | Every hgmil BRCA model trains on `20x_256px_0px_overlap`, but `preprocessUtils.js:14` binds `conch_v1 → 512 px` (Fork B of Inc 2b-3, per Trident's recommended FOV). Rather than break one of the two, the task carries `feature_spec` and the Task panel drives a build with *those* params. Both feature sets coexist; content addressing keeps them apart. |
| 3 | **UI placement** | **New `Task` tab in `RightPanel` + splittable main area** | Native to PathAssist (controls right, not left) while keeping CLAM's function set. Not a separate full-page route — that would cut the task off from slide context, annotations and Copilot. |
| 4 | **Heatmap signal** | **Signed class evidence** | This ABMIL has a *single* attention branch (`attention_w: [1,128]`), so there is no class-specific attention to draw. Raw `aᵢ` is strictly positive and wastes a diverging colormap. Evidence is signed and reads correctly: red = pushes toward the predicted class. |
| 5 | **Transport / render** | **Compact JSON → offscreen grid canvas** | Server returns parallel arrays; the client bakes scores into a one-pixel-per-patch offscreen canvas and `drawImage`s it scaled onto OSD with `multiply` blending. Redraw cost is independent of patch count, scaling interpolation gives the smooth look, and opacity is live without a refetch. |
| 6 | **Backend placement** | **Fourth stage of the preprocess service, in torch** | Reuses the job queue, `/status` polling, content-addressed cache, gateway proxy and artifact table wholesale. torch (not a numpy port) so TransMIL / DAB-MIL drop in later without rewriting a forward pass. |
| 7 | **Stub seam** | **trident image only; base image returns 503** | The base image is `python:3.11-slim` + flask/numpy/h5py — no torch. We do not fabricate stub probabilities: a made-up 0.97 is worse than an honest "unavailable". |
| 8 | **Scope** | **The active slide only** | Same mental model as the Preprocess panel. No batch/cohort UI, no `SELECT PATIENT` dropdown. |
| 9 | **Task registry** | **Server-side frozen dataclass table + `GET /tasks`** | Adding NSCLC / Camelyon16 later touches one server file; the frontend renders whatever it is served. |
| 10 | **Result persistence** | **`preprocess_artifact` `kind='prediction'` + new `result` JSONB column** | The DAG extends by one node instead of growing a second table with a second reconcile path. `params` stays inputs-only; `result` holds the summary. |
| 11 | **Ground Truth row** | **Not shown** | The demo's ground truth comes from a curated cohort. Prediction + confidence only. |
| 12 | **Applicability guard** | **Stated in the panel; no automatic gating** | See "Applicability" below. A threshold that silently suppresses true positives is worse than a sentence the user reads once. |
| 13 | **Side-by-side** | **Split inside `ViewerPanel`; sync logic extracted to a shared hook** | `CompareViewer.jsx` already has working `animation`-handler viewport sync, but it is a full-page route for *two different slides*. Extract `useViewportSync`, share it. |

**Also settled:** heatmap controls = the two CLAM mode buttons + an Overlay opacity slider (default
0.5), colormap fixed to blue–white–red; missing features trigger an in-panel one-click build behind
an explicit confirmation (never silently on `Run`); no Copilot tool in v1.

## The model

`lcr_mil.teacher.abmil.ABMIL`, instantiated by `exp_s3mil.py` at `embed_dim=256, attn_dim=128`
(confirmed by both the checkpoint shapes and `s3mil_fold0.json:config`). Dropout is identity at eval.

```
h      = relu(W₁·x + b₁)              [N,512] → [N,256]
V      = tanh(W_V·h + b_V)            [N,256] → [N,128]
U      = sigmoid(W_U·h + b_U)         [N,256] → [N,128]
raw    = W_w·(V ⊙ U) + b_w            [N,128] → [N,1]
a      = softmax(raw, dim=0)          [N]        ← normalised over the whole bag
z      = Σᵢ aᵢ·hᵢ                     [256]
logits = W_c·z + b_c                  [2]
```

Per-patch class evidence, computed in the same pass:

```
Lᵢ  = W_c·hᵢ + b_c                    [N,2]     per-patch class scores
eᵢ  = aᵢ · (Lᵢ[pred] − Lᵢ[other])     [N]       signed; Σᵢeᵢ = logit margin of the slide
```

`eᵢ` sums exactly to the slide's logit margin, so the heatmap is a genuine decomposition of the
decision rather than a heuristic saliency map.

| | |
|---|---|
| Checkpoint | `s3mil/tcga_brca/conch/abmil_fold0.pt` (795,845 B) |
| Task | TCGA-BRCA subtyping — `0 = IDC`, `1 = ILC` |
| Cohort | 942 patients (IDC 753 / ILC 189); fold 0 = train 602 / val 151 / test 189 |
| Trained on | `20x_256px_0px_overlap/features_conch_v1`, dim 512, avg 2748 patches/slide |
| Fold-0 test | AUC 0.895 · acc 0.878 · F1 0.623 (val AUC 0.948) |
| `model_ver` | `abmil-conch-brca-fold0-v1` |

**Weights** live at `/home/chen/data2/models/mil/brca_idc_ilc_abmil_conch_fold0.pt`, reachable in the
container at `/weights/mil/...` — the trident compose override already mounts data2 at `/weights`.
A new `PREPROCESS_MIL_WEIGHTS` env var (default `/weights/mil`) roots the lookup.

## Applicability — what the panel says

The model was trained only on **invasive** breast carcinoma and only ever answers "ductal or
lobular". Fed a benign, DCIS or non-breast slide it still returns a confident binary answer. The
task card states the training cohort, the class space, the fold-0 test metrics, and one sentence:
*"Distinguishes invasive ductal from invasive lobular carcinoma only; output is not meaningful for
non-invasive cases."*

This is not hypothetical for this deployment: the 11 local breast slides in
`/home/chen/data2/BRCA-TEST/` are **BRACS** (7 classes — N / PB / UDH / FEA / ADH / DCIS / IC), a
different label space. The real TCGA-BRCA slides — 1656 `.svs` in
`/home/chen/data2/tcga_brca/wsis_idc_ilc_all/`, with `metadata_matched.csv` giving IDC/ILC for 942 —
are the ones to validate against, and data2 is already mounted (`PREPROCESS_SLIDES_ROOT: /data2`).

## Data model — a fourth DAG node

```
seg_hash → patch_hash → feat_hash → pred_hash
```

```
pred_hash = sha1("pred|parent={feat_hash}|task={task_id}|model_ver={mv}|ver={PRED_VER}")[:16]
{cache}/{item}/pred/{pred_hash}/prediction.json     # summary + per-patch arrays
```

Control plane — one migration, one new column:

```sql
ALTER TABLE preprocess_artifact ADD COLUMN IF NOT EXISTS result JSONB;
```

`kind='prediction'`, `parent_hash=feat_hash`, `params={task_id, model_ver, feature_spec}`,
`n_items=N`, `artifact_ref` → `prediction.json`, and:

```jsonc
result = {
  "task_id": "brca_idc_ilc",
  "classes": ["IDC", "ILC"],
  "probs": [0.93, 0.07],
  "pred_index": 0,
  "n_patches": 2731,
  "elapsed_ms": 118
}
```

The summary rides along with `list_artifacts`, so reopening the panel shows the last prediction with
no extra request. The per-patch arrays are fetched separately, only when a heatmap is drawn.

## Worker HTTP API

```
GET  /tasks                                    → [{id, label, classes, model_ver,
                                                   feature_spec, metrics, notes}]
POST /predict {item, feat_hash, task_id}       → 202 {job_id, pred_hash, kind:"prediction"}
                                                 409 if features.h5 is absent for that feat_hash
                                                 503 if this image has no torch (base image)
GET  /status?job_id=…                          → unchanged
```

The job reads `features.h5`, runs the forward, writes `prediction.json`:

```jsonc
{
  "task_id": "brca_idc_ilc", "model_ver": "abmil-conch-brca-fold0-v1",
  "classes": ["IDC","ILC"], "probs": [...], "pred_index": 0,
  "patch_px": 512,                   // level-0 side of one patch (from coords.h5 attrs)
  "coords":    [x0,y0, x1,y1, ...],  // level-0 px, index-aligned with features.h5
  "attention": [...],                // aᵢ,  N floats
  "evidence":  [...]                 // eᵢ,  N floats, signed
}
```

`GET /tasks` is served by both images (it is a static table); only `/predict` is gated on torch.

## Gateway

```
GET  /tasks                                          # proxy, cached briefly
POST /slides/{item}/predict {feat_hash, task_id}     # one job → one artifact row
GET  /slides/{item}/prediction/{pred_hash}/heatmap   # coords/attention/evidence arrays
```

`_reconcile_artifact` is reused unchanged; `set_status` gains a `result` parameter so the terminal
reconcile writes the summary. A 503 from the worker is surfaced verbatim so the panel can say *"Task
inference needs the GPU worker"* rather than rendering a generic failure.

## Frontend

**`taskUtils.js`** (pure, unit-tested — same split as `preprocessUtils.js`):
`matchFeatureSpec(rows, spec)` → the ready features row whose params satisfy the task, or `null`;
`buildPlanFor(spec, rows)` → which of segment/patch/features still need running;
`describePrediction(row)`; `colormap(t)` → blue–white–red; `normaliseEvidence(arr)` → symmetric
percentile scaling (2nd/98th) so one outlier patch cannot flatten the map.

`feature_spec` constrains `{encoder, mag, patch_size, overlap}` **only**. `segmenter` is deliberately
excluded: it propagates through `seg_hash → patch_hash → feat_hash`, so including it would reject
every otherwise-valid feature set built with a different segmenter and force a redundant rebuild.
The model is not bound to a segmenter — but see risk ① for what it *is* sensitive to.

**`TaskPanel.jsx`** — task select (one entry) → task card (classes, training cohort, fold-0 metrics,
the applicability sentence) → feature-spec status → `Run` → result card (`Prediction` / `Confidence`
+ n_patches, model_ver, elapsed) → view controls (`Side By Side` | `Overlay` + opacity slider).

When `matchFeatureSpec` returns `null`, the panel shows the required spec and a **Build features**
button that runs segment → patch → features with the task's params (reusing `nextChainStep`), with
live progress. `Run` stays disabled until it completes. The build is never implicit — it can cost
minutes of A6000 time shared with CellViT and MedGemma.

**`HeatmapOverlay.jsx`** — bake once into an offscreen canvas sized to the patch grid
(`ceil(W/patch_px) × ceil(H/patch_px)`, one pixel per patch), then per viewport event
`drawImage(offscreen, …)` into the visible rect with `globalCompositeOperation='multiply'` and the
chosen alpha. Rebake only when scores change. Mirrors `TissueOverlay.jsx`'s mount/projection
lifecycle (`imgToViewer`, viewport-event redraw, driven entirely by store state).

**`useViewportSync.js`** — extracted from `CompareViewer.jsx:189` (`wireSync`) verbatim: bidirectional
`animation` handlers behind a re-entrancy guard and an enable flag. `CompareViewer` switches to it in
the same change, so there is one implementation, not two.

**`ViewerPanel.jsx`** — when the task view mode is `side-by-side`, render a second OSD on the same
Girder tile source; left pane clean, right pane carries `HeatmapOverlay`. Annotations, measurement
and the existing overlays stay mounted on the left pane only. `overlay` mode is the single pane with
`HeatmapOverlay` on top.

**`RightPanel.jsx`** — a `Task` tab beside `Preprocess`, gated on `hasRole('ai-users')`.

## Numerical fidelity — two layers, kept distinct

**L1 — port correctness (must hold to 1e-5).** Feed the service a file straight out of
`/home/chen/MIL-Lab/trident_processed/tcga_brca/20x_256px_0px_overlap/features_conch_v1/` and compare
`probs`, `attention` and `evidence` against the hgmil `ABMIL` run offline on the same array. Same
inputs, same weights ⇒ same numbers. Any drift is a bug in the port. This ships as a checked-in
regression test over one small fixture bag.

*Result (2026-07-23):* exact. Both the 48-patch committed fixture and 12 real bags of 882–4347
patches reproduce the training code's `probs` and `attention` bit-for-bit; the evidence sum tracks
the logit margin to ~1e-6. As an aside, the same run agreed with the CSV subtype on 10 of 12 slides
— an observation only, since those 12 were drawn from the whole cohort and are not the fold-0 test
split. One of the two misses is `TCGA-BH-A0DP-11A`, a `-11A` (solid tissue normal) barcode labelled
ILC in the metadata, and the model sat at p(IDC)=0.52 — near-undecided, which is what the
applicability caveat above predicts for tissue outside the invasive-carcinoma training distribution.

**L2 — preprocessing equivalence (observed, not asserted).** Take one TCGA-BRCA slide, build features
through the PathAssist DAG, and compare patch count and predicted probabilities against the MIL-Lab
features for the same slide. These are *not* expected to be bit-identical — different segmentation
means a different bag. How close they land is a fact to measure and record, not a threshold to
assert. It is reported in the smoke write-up; it does not gate CI.

## Field results — the first live smoke (2026-07-23)

One slide was reachable end to end: **TCGA-3C-AAAU-01A-01-TS1** (Girder item
`6a3d59bed59c30f37fd998a0`, collection TCGA-BRCA), ground truth **ILC**. It was run twice through
the container's real `/predict`:

| Feature index | patches | `patch_px` | call | p(IDC) | Σevidence |
|---|---|---|---|---|---|
| PathAssist Trident, **512 px** @20× (off-spec) | 1146 | 1024 | IDC | 0.5001 | 0.0005 |
| MIL-Lab, **256 px** @20× (the trained spec) | 4260 | 512 | IDC | 0.9145 | 2.370 |

The browser E2E then built the task's own 256 px index through the panel and ran it — and it also
came out undecided (p(IDC) = 0.4990, 4258 patches). **That is what exposed the real defect, and it
is not resolution.**

### ⚠ Defect: `conch_v1` is two different encoders, and they share a `feat_hash`

`stages.py:_trident_features` passes `{"with_proj": True, "normalize": True}` for `conch_v1` —
added in Inc 2b so `find_regions` could search the CONCH text–image contrastive space. Trident's
own defaults for that encoder are `with_proj=False, normalize=False` (`load.py:355`), and MIL-Lab
extracted the training features with those defaults.

Measured on the same slide, same coords, 4258 shared patches:

| | ‖v‖ | pairwise cos (internal) | per-patch cos vs the other set, after L2 |
|---|---|---|---|
| PathAssist (`with_proj=True`) | 1.0000 | 0.723 | — |
| MIL-Lab (Trident defaults) | 22.65 | 0.721 | **0.0049** |

Cosine ≈ 0 means these are **not the same embedding at a different scale — they are near-orthogonal
spaces**. The projection head maps into the text-aligned space; the model was trained on the vision
tower output. Rescaling cannot recover it, and the experiment confirms that: normalising MIL-Lab's
own features drops the call from 0.9145 to 0.5301, and multiplying PathAssist's back up by 22.65
only reaches 0.5629.

Both variants are stored under `encoder: "conch_v1"`, so they hash to the same `feat_hash` and the
same cache path. **The content addressing cannot currently tell them apart** — a slide indexed for
text search looks, to the task, exactly like a slide indexed for the model.

This is a gap in Inc 2b-3's hashing that Inc 2c surfaced; `find_regions` never noticed because
cosine ranking is scale-invariant and it genuinely wants the projected space.

### ✅ Fixed — the variant is now part of the encoder identity

- `config.ENCODER_KWARGS` maps encoder **id** → `encoder_factory` kwargs, and `encoder_model()`
  maps both ids onto the one checkpoint. `conch_v1` = Trident defaults (vision); `conch_v1_text` =
  `with_proj + normalize`. Distinct ids ⇒ distinct `feat_hash` ⇒ they can no longer collide.
- `TEXT_CAPABLE_ENCODERS` and the agent's `_TEXT_ENCODERS` move to `conch_v1_text`; the panel's
  default build target moves there too, so a default index still powers Copilot search. A task
  asks for the vision variant through its own `feature_spec`.
- A new `feat_version` (`v2`), separate from `index_version` (`v1`), invalidates feature artifacts
  without discarding the segmentations and patch grids beneath them — those were never wrong.
- **Data migration:** the two pre-split `features` rows were relabelled
  `encoder: conch_v1 → conch_v1_text`. They are *valid* text indexes that were merely misnamed, so
  relabelling keeps `find_regions` working off the existing files instead of re-spending GPU. The
  version bump alone was not enough — the panel matches on `params.encoder`, not on the hash.

Guards added so this cannot regress silently: `feat_hash` must differ between the variants,
`is_text_capable("conch_v1")` must be false, `encoder_kwargs` must return a copy, and on the
frontend `matchFeatureSpec` must reject a `conch_v1_text` index at the task's exact resolution.

### ✅ L2 — preprocessing equivalence, measured

After the fix, the browser rebuilt the vision index through the panel (segmentation and 256 px
tiling reused; only the features stage re-ran) and the task returned:

| | patches | p(IDC) |
|---|---|---|
| PathAssist, built through the panel | 4258 | **0.914542555809021** |
| MIL-Lab, the training extraction | 4260 | **0.914542** |

Two independently-built feature sets, two different segmentations, a two-patch difference in the
bag — and the answer agrees to the printed precision. **L2 is not merely close; it is equivalent.**
The evidence map changed character too: uniform red/blue speckle before the fix, sparse structured
foci after it.

**What the smoke did establish:**

*The port is faithful in production.* On MIL-Lab's correctly-extracted index the container returned
0.9145 against hgmil's own `ABMIL` at 0.914542 on the same file.

*The control plane works end to end.* The panel reused the existing segmentation, built a new
256 px patching (4258) and features row, wrote a `kind='prediction'` row with its summary in
`result`, and fetched the heatmap — all with zero console errors.

*The model is not always right.* On the correct features it called **IDC on an ILC slide at
p = 0.91**, and `get_tcga_brca_splits` puts TCGA-3C-AAAU in **fold 0's training split**. Fold-0 ILC
F1 is 0.623 against a 753/189 imbalance, so the minority class is underfit. That is a fact about
the checkpoint, not this increment — but a demo will land on such slides.

## Sequencing

1. **Task registry + forward** — `tasks.py` (frozen dataclass table), `predict.py` (torch forward +
   evidence), weight export to data2. Unit tests incl. the **L1** fixture regression. *(no HTTP/DB)*
2. **Worker HTTP** — `GET /tasks`, `POST /predict`, `pred_hash`/`pred_paths` in `artifacts.py`, the
   409/503 paths; app tests with the runner seam overridden (as the existing tests do).
3. **Control plane** — `result` column migration, `set_status(result=…)`, gateway routes +
   reconcile, heatmap fetch route; store and route tests.
4. **Frontend logic** — `taskUtils.js` + tests (spec matching, build planning, colormap,
   normalisation).
5. **Frontend UI** — `TaskPanel.jsx`, `RightPanel` tab, store state.
6. **Viewer** — `useViewportSync` extraction (+ `CompareViewer` switched over), `HeatmapOverlay`,
   `ViewerPanel` split mode.
7. **Verification** — GPU smoke on a real fold-0 test slide, **L2** measurement, browser E2E.

Phases 1–3 are backend-only and land independently; 4–6 are frontend-only. Phase 7 is the gate.

## Risks / open points

**① The bag is the unit of normalisation.** `a = softmax(raw)` is taken over the whole bag, so the
slide embedding depends on how many patches the slide was cut into and where. Training bags came
from MIL-Lab's Trident segmentation; PathAssist re-segments with `hest`. Because `z` is a weighted
*average* (weights sum to 1) the sensitivity is lower than a sum would be, but it is not zero. This
is exactly what **L2** measures — and the reason `segmenter` is left out of `feature_spec` is a
deliberate trade: we accept segmentation variance rather than force a full rebuild of every existing
index. If L2 shows a large gap, the mitigation is to pin the segmenter in `feature_spec` after all,
which is a one-line registry change.

**② `overlap` must stay 0.** A denser grid changes `N`, hence the softmax denominator, hence both
attention and the slide embedding. The task spec pins `overlap=0` to match training.

**③ The base image cannot run this at all.** Every frontend state that depends on `/predict` needs an
explicit "needs the GPU worker" rendering — not a spinner that never resolves and not a generic
error toast. `GET /tasks` deliberately works everywhere so the panel can still show the task card.

**④ We are building on unverified ground.** Inc 2b-3 is local-only, uncommitted, and its real Trident
per-stage path has never had a GPU smoke or a browser E2E — and `run_features` is precisely the
producer of the `features.h5` this increment consumes. Phase 7 therefore validates *both* increments;
a failure there may well be upstream. Foundation verification runs in parallel with phases 1–6 rather
than blocking them.

**⑤ Patch geometry comes from `coords.h5`, not from arithmetic.** `patch_px` (the level-0 side of one
patch) depends on the slide's native magnification — 256 px at 20× is 512 level-0 px on a 40× slide
and 256 on a 20× slide. Read it from the coords attrs the tiling stage already writes; do not derive
it from `mag`/`patch_size` in the frontend.
