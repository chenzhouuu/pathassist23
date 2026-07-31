# Inc 2b-3 — Preprocess as a 3-stage DAG (segment → tile → features)

> **Supersedes** the single-shot `/run` model from `2026-07-23-pathagent-v2-inc2b-trident-preprocess-design.md`.
> **Status:** ✅ implemented locally 2026-07-23 (Phases 1–5). Tests green: preprocess 67, agent 142,
> frontend utils 23 (vitest), `npm run build` clean, both services ruff-clean. Real GPU smoke of the
> per-stage Trident path (segment/patch/features) + live browser E2E still pending (worker changes
> need a container rebuild). Not committed, not pushed.
> **Motivation:** the current panel is one "Build index" button that bundles segment→patch→feature
> into one atomic job keyed by one flat `params_hash`. The user wants Trident-faithful granularity:
> tune and run each stage independently, reuse intermediate artifacts, and human-review the tissue
> segmentation on the viewer before spending GPU on encoding.

## Agreed decisions (the three forks)

| Fork | Choice | Consequence |
|------|--------|-------------|
| **A. Split depth** | **Real DAG, reusable** | 3 content-addressed cache keys; control-plane schema moves from "one row = one full index" to one row per artifact (segmentation / patching / features). Segment-once → tile-many → encode-many reuse. |
| **B. mag/patch_size** | **Bound to encoder** | Selecting an encoder auto-fills its trained `patch_size`/`mag` (conch_v1→512, uni_v1/v2→256); Advanced can override. Fixes today's off-spec conch_v1@256 default (Trident recommends 512). |
| **C. Segmentation overlay** | **Now** | After a segmentation is ready, draw its tissue contours on OpenSeadragon; the user can eyeball / re-run at a different `seg_conf_thresh` before tiling. Touches `ViewerPanel.jsx` + `RegionOverlay.jsx`. |

## Background — what the hyperparameters mean

- **magnification (`mag`)** — the target objective power at which patches are cut and fed to the
  encoder. WSIs are resolution pyramids measured in **mpp** (µm/px): 40× ≈ 0.25, 20× ≈ 0.5.
  `mag`+`patch_size` set the physical field of view: `FOV_µm = patch_size × mpp(mag)`.
  20×/256 → 128 µm; 20×/512 → 256 µm; 40×/256 → 64 µm.
- **encoders are trained at a fixed `mag`/`patch_size`** (Trident README table): UNI = 256/20×,
  CONCH v1 = **512**/20×, Virchow = 224/20×. So `patch_size` is not a free knob — it belongs to the
  encoder (Fork B). `mag` stays 20× for all three seeded encoders.

## Stage → parameter mapping (from `run_single_slide.py`)

| Stage | Params (Trident arg) | Output artifact |
|-------|----------------------|-----------------|
| ① **Segmentation** | `segmenter` (hest/grandqc/otsu) · `seg_conf_thresh` (0.5; ↓ keeps more tissue) · `remove_artifacts` · `remove_holes` · `remove_penmarks` | `contours.geojson` (tissue contours, level-0 px) |
| ② **Tiling** | `mag` · `patch_size` · `overlap` (px, 0) — depends on ① | `coords.h5` (level-0 coords + geometry attrs) |
| ③ **Features** | `encoder` (+ server-side `batch_limit`) — depends on ② | `features.h5` (features [N,dim] + coords) |

## Data model — content-addressed DAG

Compositional hashes (each transitively includes its ancestors):

```
seg_hash   = sha1("seg|segmenter={s}|conf={c}|art={a}|holes={h}|pen={p}|ver={SEG_VER}")[:16]
patch_hash = sha1("patch|parent={seg_hash}|mag={m}|ps={ps}|overlap={o}|ver={PATCH_VER}")[:16]
feat_hash  = sha1("feat|parent={patch_hash}|enc={e}|ver={FEAT_VER}")[:16]
```

Cache layout mirrors Trident's own on-disk DAG (`contours_geojson/` → `20x_256px/patches` →
`.../features_<enc>`):

```
{cache}/{item}/seg/{seg_hash}/contours.geojson
{cache}/{item}/patch/{patch_hash}/coords.h5
{cache}/{item}/feat/{feat_hash}/features.h5
```

The worker is **DB-stateless**: a `/patch` job resolves its parent by reading
`{cache}/{item}/seg/{seg_hash}/contours.geojson` off disk (content-addressed), so no cross-service
state is needed. The gateway owns the control-plane rows.

## Control-plane schema — one row per artifact

Replace the single `slide_index` table (which modeled one full index) with `preprocess_artifact`,
a DAG-shaped table discriminated by `kind` and linked by `parent_hash`:

```sql
CREATE TABLE IF NOT EXISTS preprocess_artifact (
    id           BIGSERIAL PRIMARY KEY,
    girder_item  TEXT NOT NULL,
    kind         TEXT NOT NULL,           -- 'segmentation' | 'patching' | 'features'
    art_hash     TEXT NOT NULL,           -- content hash of THIS artifact
    parent_hash  TEXT,                    -- NULL(seg) | seg_hash(patch) | patch_hash(feat)
    params       JSONB NOT NULL,          -- stage params (see mapping table)
    status       TEXT NOT NULL DEFAULT 'queued',
    stage        TEXT,                    -- fine sub-stage label for the progress bar
    progress     REAL NOT NULL DEFAULT 0,
    job_id       TEXT,
    n_items      INTEGER,                 -- n_contours | n_patches
    dim          INTEGER,                 -- features only
    artifact_ref TEXT,                    -- path to the output file
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (girder_item, art_hash)
);
CREATE INDEX IF NOT EXISTS preprocess_artifact_item_idx
    ON preprocess_artifact (girder_item, updated_at DESC);
```

`slide_index` is left in place (dev data, harmless) but the panel + find_regions move off it. Old
flat-hash disk caches are orphaned (acceptable in dev; a new `SEG/PATCH/FEAT_VER` invalidates cleanly).

`ArtifactStore` (mirrors `SlideIndexStore`, with a `MemoryArtifactStore` double): `upsert_artifact`,
`set_status`, `get_artifact(item, art_hash)`, `list_artifacts(item)` (the panel reconstructs the DAG
from `parent_hash`).

## Worker HTTP API

```
POST /segment   {item, segmenter, seg_conf_thresh, remove_*, girder_token}   → {job_id, seg_hash, status}
POST /patch     {item, seg_hash, mag, patch_size, overlap}                    → {job_id, patch_hash, status}
POST /features  {item, patch_hash, encoder}                                   → {job_id, feat_hash, status}
POST /run_all   {item, ...all params...}                                      → {job_id, seg_hash, patch_hash, feat_hash}
GET  /status?job_id=…                                                         → unchanged
POST /find_regions {item, feat_hash | (encoder,mag,patch_size,segmenter…), query, k}
```

- `/patch` and `/features` 409 if the parent artifact file is absent (must build upstream first).
- **`/run_all`** runs the whole DAG in one job, writing all three content-addressed artifacts and
  emitting `on_stage("segmentation"|"patching"|"features", p)`. The gateway pre-creates the seg/patch/
  feat rows sharing that `job_id` and reconciles them off the stage transitions: seg→ready when the
  job passes `patching`, patch→ready at `features`, feat→ready at `done`.
- **`find_regions`** resolves the features artifact (prefer explicit `feat_hash` from the row) →
  `artifact_ref` → reads `features.h5`. Keeps the gateway `tools.py` path working.

`pipeline.py` (currently 172 lines) splits into a `pipeline/` package to respect the file-size rule:

```
pipeline/__init__.py   # PipelineResult, run_segmentation, run_patching, run_features, run_all
pipeline/stub.py       # GPU-free deterministic stub for each stage (CI)
pipeline/trident.py    # real Trident recipe per stage (manual GPU smoke)
```

## Gateway proxy + store

New routes (proxy to the worker, own the `preprocess_artifact` rows):

```
POST /slides/{item}/segment | patch | features     # each: one job → one artifact row
GET  /slides/{item}/artifacts                       # all artifacts, DAG-reconciled against /status
GET  /slides/{item}/segmentation/{seg_hash}/contours # for the viewer overlay (Phase 5)
```

`app.py` adds `PgPreprocessArtifactStore` alongside the (kept) `PgSlideIndexStore`; each stage route
folds the worker `/status` into its single artifact row via `_reconcile_artifact` (one job → one
row — clean). A `patch`/`features` call on a missing parent surfaces the worker's 409 to the client.

**Refinement (decided during Phase 3):** the gateway does **not** proxy `/run_all`. Reconciling one
job's stage transitions onto three rows was the risky part of the original plan; instead **"Run all"
is orchestrated by the frontend** as a chain — POST `/segment` → poll ready → POST `/patch` → poll →
POST `/features`. Each stage stays a clean single-row build, the chain is resumable (a closed panel
just stops after the current stage; reopening shows ① done and ② ready to run), and per-stage
progress is live for free. The worker's `/run_all` endpoint is kept as an unused optimization.

## Frontend — 3-stage panel

`preprocessUtils.js`:
- `ENCODER_PATCH = { conch_v1: 512, uni_v1: 256, uni_v2: 256 }`, `ENCODER_MAG` default 20.
- `bindEncoder(encoder) → {patch_size, mag}` (used when the encoder changes unless override on).
- DAG helpers: `findSegmentation(rows, segParams)`, `findPatching(rows, seg_hash, tileParams)`,
  `findFeatures(rows, patch_hash, encoder)`; `stageReady`, `stageEnabled(prevReady)`.

`PreprocessPanel.jsx` → three stacked stage cards (Segment / Tile / Features), each with its own
params, status pill, progress bar, and **Run** button; stage N's Run is enabled only when the
selected upstream artifact is ready. A top **Run all** keeps the one-click path. Selecting an encoder
auto-sets `patch_size` (locked; Advanced unlocks). Features card shows the 🔍 text-search badge.

Stage ① card gets a **View overlay** action once ready.

## Segmentation overlay (Fork C)

`RegionOverlay.jsx` (already scaffolded) draws the `contours.geojson` polygons on OpenSeadragon in
level-0 → viewport coords; `ViewerPanel.jsx` mounts it when a segmentation overlay is toggled from
the panel. A `seg_conf_thresh` re-run replaces the overlay. (This is the human-in-the-loop QC that
Trident's QuPath story describes.)

## Sequencing (each phase self-contained + tested)

1. **Backend core** — `artifacts.py` compositional hashing + DAG cache layout; `pipeline/` package
   with the three stage fns + `run_all` (stub + trident); unit tests. *(no DB/HTTP)*
2. **Worker HTTP** — stage endpoints + `/run_all` + find_regions-by-artifact; app tests.
3. **Control plane** — `preprocess_artifact` table + `ArtifactStore` (+ memory double); gateway
   routes + reconciliation; store/route tests.
4. **Frontend** — `preprocessUtils` rewrite (+ tests) and the 3-stage `PreprocessPanel`.
5. **Overlay** — segmentation contours on the viewer + panel toggle.

## Risks / open points

- **`/run_all` reconciliation** — mapping one job's stage transitions onto three rows must handle a
  mid-stage failure (mark the in-flight artifact failed, downstream stays `queued`→ cancel).
- **Reuse UX** — when the user changes only the encoder, the panel must show ① and ② already ✓ and
  only ③ to run. `bindEncoder` + DAG lookup drives that.
- **Overlay coords** — contours are level-0 px; the overlay must map through OSD's viewport, same
  transform the nuclei overlay already uses (reuse that helper).
- **find_regions back-compat** — the gateway `tools.py` must pass `feat_hash` (or the full param set)
  so the worker resolves the right `features.h5`.
