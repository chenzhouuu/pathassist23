# Adversarial Review — Inc 2b (pivoted) Trident preprocess + Preprocess panel design

> **Reviews:** `2026-07-23-pathagent-v2-inc2b-trident-preprocess-design.md`
> **Method:** code-grounded, adversarial. Every claim checked against the actual repo seams
> (`services/agent/src/agent/{gateway,store,loop,common}/`, `services/{pathvlm,cellvit}/`), the
> **vendored Trident source** (`github/TRIDENT/`, v0.3.0), the **recovered v1 `services/pathagent`**
> stack (git `75d5523^`), the **live DSA** (`localhost:9080`), and the frontend right-rail wiring.
> **Verdict:** the *thesis* (Trident tissue-aware feature extraction + a control-plane index, features
> computed once and referenced everywhere) is sound and well-grounded. But the design carries **one
> blocking factual error** (the CONCH text-search default cannot do text search) and **six should-fix**
> corrections where it assumes seams/behaviour the code does not actually have. Fold all seven in before
> writing the Inc 2b-1 TDD plan.
> **Tally:** 1 blocking · 6 should-fix · 3 notes.

---

## What holds up

- **Trident four-step recipe.** Real and vendored: `load_wsi(...) → slide.segment_tissue →
  slide.extract_tissue_coords → slide.extract_patch_features` (`run_single_slide.py:88,107,135,176`;
  methods on the `WSI` base class, `WSI.py:438/697/884`). The verbs are right — with object-model and
  naming caveats (F2, F5).
- **Level-0 coordinate frame (D5).** Confirmed at source: Trident coords are "ALWAYS wrt. level 0"
  (`WSI.py:775`, `IO.py:592`), written by `coords_to_h5` as int64 `(N,2)` (`IO.py:646-687`). The
  level-0 bbox contract really is free — each patch box is `(x,y)…(x+patch_size_level0, y+…)`. (Attr
  name fix in F5.)
- **TissueLab split (D4).** Right shape: arrays → h5, control/status → Postgres. The `slide_index`
  table drops cleanly into the existing idempotent-DDL path (F4).
- **Async as a visible panel action (D6).** The honest resolution of the old F2 — provided the job
  queue lives in the *worker service*, not the gateway (F7 makes this concrete).
- **Build order (2b-1 → 2b-2 → 2b-3), stub-first.** Correct instinct, and the CellViT (R8→R11) /
  MedGemma (Inc 2a) stub seam is a proven template (`services/pathvlm/src/pathvlm_service/infer.py`).
  The findings below re-slice *what ships in this pass* (F6), not the order.

---

## Findings

### F1 — BLOCKING · the CONCH default cannot do text search; only `conch_v1` (re-projected) can
The design's spine is `find_regions(query: str)` = CONCH text→patch cosine, with **`conch_v15` as the
suggested default** (§D2, §5 form default) and `{conch_v1, conch_v15, musk}` as the text-capable set.
Grounded against the vendored encoders, this is **wrong in three compounding ways**:

1. **`conch_v15` has no text tower at all.** `Conchv15InferenceEncoder` loads `CONCHVisionTower` — a
   bare `vit_large` trunk + attentional pooler, downloading only `pytorch_model_vision.bin`
   (`trident/patch_encoder_models/model_zoo/conchv1_5/conchv1_5.py`; wrapper at `load.py:1302-1326`).
   No text encoder, no tokenizer. **Text→patch retrieval with `conch_v15` is impossible** — it would
   crash or (worse) silently score against a nonexistent space.
2. **Trident exposes zero text API.** Every `encoder_registry` value subclasses `BasePatchEncoder`
   whose `forward` runs images only (`load.py:128,193-198`). The text tower of `conch_v1` (a CoCa
   model with `encode_text`, `.../site-packages/conch/open_clip_custom/coca_model.py:225`) is only
   reachable by **bypassing the Trident wrapper** — `encoder.model.encode_text(...)` plus the external
   `conch` package tokenizer (`from conch.open_clip_custom import tokenize, get_tokenizer`).
3. **Default `conch_v1` patch features are in the wrong space.** The wrapper builds with
   `with_proj=False, normalize=False` (`load.py:355`), so `encode_image` skips the contrastive
   projection (`forward_no_head`, `vision_tower.py:121`) that `encode_text` applies. Cosine
   text↔patch on the default output is **invalid**. You must re-extract with
   `encoder_factory('conch_v1', with_proj=True, normalize=True)` to land in the shared space.

**Resolution (reshapes D2, §4, §5, §6):**
- Text-search index default = **`conch_v1` built with `with_proj=True, normalize=True`** (not
  `conch_v15`). `musk` is the other genuine VL option.
- The text-capable set is **`{conch_v1, musk}`** — drop `conch_v15` from it (it stays a valid
  *image-only* encoder for future image→image similarity, and is fine as the *default image encoder*,
  just never for text `find_regions`).
- `find_regions` retrieval must call the **`conch` package** directly for text-encode + tokenize, not
  a Trident method — its own model handle, not `extract_patch_features`.
- The panel/tool "🔍 text search" badge is keyed on this corrected set, and the encoder wrapper for a
  text-search build must pass `with_proj=True, normalize=True`.
- **Install caveat:** `conch` is an **optional** Trident extra (`[tool.poetry.extras] patch-encoders =
  [...,"conch","musk"]`), NOT installed by a plain Trident install — the new service's image must
  `pip install git+https://github.com/Mahmoodlab/CONCH.git` (or the extra) or `conch_v1` throws
  "Please install CONCH" (`load.py:364`).

### F2 — should-fix · §3 source-file resolver is not what v1 did; use the recovered pattern
§3 describes a 3-tier resolver: (1) Girder **filesystem-assetstore path** via `/item/{id}/files`,
(2) **`/mnt/dsa-cache/` FUSE**, (3) download. The recovered v1 `slide_resolver.py` (git `75d5523^`,
authored `da76192`, hardened `dec5fa3`, name+size tier `33aa278`) did **none of tiers 1–2 as
described**:

- Real tier 1 = local match by **`item_id`** against a *separately configured* `slides_root` (glob,
  validated) — not a Girder assetstore path.
- Real tier 2 = local match by the Girder file's **`name` + byte `size`** (calls `/item/{id}/files`
  only for the file doc's name/size, then finds a same-named, same-size file already on local disk).
- Real tier 3 = stream `GET /file/{id}/download` → `.part` → atomic `os.replace`.

`/mnt/dsa-cache/` is the **large_image FUSE tile-byte cache** (`deploy/docker-compose.yml:69`,
`-o diskcache`), *not* a browsable `.svs` store — the v1 resolver never touched it. And in the S3
deployment there is **no local `.svs` path at all** (only S3 + the byte cache), so tier 3 (download)
is the only prod-safe path.

**Resolution:** re-port the recovered `resolve_slide()` + `girder_download.py`
(`find_item_slide_file` = `/item/{id}/files` largest-WSI; `download_item_slide` = streamed
`/file/{id}/download`) verbatim into `services/preprocess/`, driven by a new
`PREPROCESS_SLIDES_ROOT` (dev points it at `/home/chen/data2` where **~4,577 TCGA + the BRACS-164x
`.svs` exist on disk today**, so dev resolves by name+size; prod leaves it empty → download tier).
Thread the user's `Girder-Token` through (the v1 worker defaulted it to `None` and thus only served
public items — a documented v1 gap we should close). Correct §3 to this.

### F3 — should-fix · attaching the h5 back to the Girder item needs WRITE access it may not have
D3 attaches `features.h5 / coords.h5 / contours.geojson` **to the Girder item**. But Girder file
upload requires **write permission on that item**, and the copilot runs with the *caller's*
`Girder-Token`. The Inc 2c work already hit exactly this wall: a non-owner writing a DSA annotation to
a **public** item got **403** (`GirderAnnotationStore`, memory `pathagent-v2-orchestrator-reslot`).
The demo scenario — a pathologist opening a *public* TCGA slide they do not own — will **403 on
attach**, silently breaking D3 for the primary use case.

**Resolution:** make the artifact sink a **seam**, defaulting to a **service-local artifact cache**
keyed by `item_id + params_hash` (survives restart via a mounted volume, shared across workers if the
volume is shared), with **Girder-attach behind the seam** for the owned-item / service-token case
(manual smoke). This also keeps the stub path GPU- and permission-free. Re-word D3: "attach to Girder
when writable; otherwise a params-hash-keyed service cache" — the *index record* (Postgres) is the
durable source of truth either way; the h5 location is an implementation detail the `slide_index` row
points at (`feature_file_id` for Girder OR a cache ref).

### F4 — should-fix · `slide_index` is net-new DDL + a store seam, not "a Postgres table"
The gateway store has **no migration tool** (`store/pg.py:1-5` says so). Tables are created by one
idempotent `_SCHEMA` string executed on connect (`pg.py:17-39,89-90`). Live DB confirms only
`conversation` + `turn` (plus legacy `plan/claim/run`) exist — no `slide_index`. And routes depend on
the `ConversationStore` **ABC** (`store/base.py`), which the in-memory test double `MemoryStore`
(`tests/conftest.py`) fully implements — so adding slide-index methods to that ABC forces a matching
`MemoryStore` change or route tests break.

**Resolution:** (a) append `CREATE TABLE IF NOT EXISTS slide_index (...)` to `_SCHEMA` (idempotent, no
alembic); (b) model slide-index access as a **separate `SlideIndexStore` ABC + `PgSlideIndexStore` +
`MemorySlideIndexStore`**, mirroring the `ConversationStore` pattern, so the conversation ABC and its
test double stay untouched. Columns per D4: `id, girder_item, params_hash, status, progress, encoder,
mag, patch_size, segmenter, n_patches, feature_ref, error, created_at, updated_at`, unique on
`(girder_item, params_hash)`.

### F5 — should-fix · Trident recipe details: object model, method/attr names, dtype
The design's mental model has fixable inaccuracies that would surface the moment the real seam is
wired:
- The steps are **WSI-object methods**, not a `Processor` — `slide = load_wsi(...)` then
  `slide.segment_tissue / slide.extract_tissue_coords / slide.extract_patch_features`. Segmentation
  feeds coords via the `slide.gdf_contours` **side-effect** (`WSI.py:738`), not an argument; the real
  script also runs `slide.visualize_coords`.
- Coords h5 attrs: level-0 side length is **`patch_size_level0`** (correct in design), but the mag
  attr is **`target_magnification`**, not `target_mag` (`IO.py:671-681`); bare `patch_size` is the
  *target-mag* size, not level-0.
- Features h5 holds **both** `features` and `coords` (index-aligned, self-contained — no re-join
  needed; `WSI.py:1029`). Dtype is **fp16 only for `conch_v15/keep/musk`; fp32 for `conch_v1` and most
  encoders** (`load.py:385` etc.). So the design's blanket "fp16" is wrong — and the one text-search
  encoder (`conch_v1`) is fp32. Store whatever Trident emits; don't assume fp16.
- Trident's own license is **CC-BY-NC-ND 4.0** (`github/TRIDENT/pyproject.toml`) — the non-commercial
  flag applies to the *toolkit*, not only CONCH weights.

**Resolution:** correct §4's pipeline description and D5's attr name; drop the "fp16" assumption; add
Trident-itself to the licensing note (§8).

### F6 — should-fix · the Preprocess panel (2b-2) is blocklist-bound; re-scope this pass
A right-rail tab is **not** "two hardcoded spots" — it is **three edits across two files**, and two of
them are on the do-not-commit blocklist:
- rail button → `src/components/ViewerApp.jsx` (`RightRail`, `:121-185`) — not blocklisted;
- tab-bar entry → `src/components/panels/RightPanel.jsx` `allTabs` (`:50-78`) — **blocklisted**;
- id→component render + import → `RightPanel.jsx:135-140` (+ `:4-9`) — **blocklisted**.
The tissue-contour overlay mounts in `ViewerPanel.jsx:466-470` — **also blocklisted** — and **no
GeoJSON / N-vertex polygon overlay exists** (only points in `NucleiOverlay`, 4-corner rects in
`RegionOverlay`), so the contour renderer is **net-new drawing code**, not reuse.

**Resolution:** the committable, on-page-testable slice for this goal is **backend only**:
- **Inc 2b-1** (preprocess service + resolver + stub Trident seam + service artifact cache + Girder
  attach seam + `slide_index` store + gateway proxy routes) — zero frontend, zero blocklist.
- **Inc 2b-3** (`find_regions` server tool) — surfaces through the **existing** Copilot panel's tool
  trace (`CopilotPanel.jsx` / `copilotTurn.js`, **not** blocklisted); the on-page E2E is "ask the
  copilot to find regions → tool card + grounded summary in chat."
- **Inc 2b-2** (the `preprocess` tab) and the **green-candidate contour/region overlay** are
  **deferred** — they cannot be committed under the blocklist and are net-new UI. Document, don't
  build, this pass.

### F7 — should-fix · pin the async ownership: queue in the worker, DB in the gateway
Confirmed there is **zero** async/background infra in `services/agent` (no queue, no `create_task`
jobs, no jobs table). The turn route is single-shot streaming; `run_segmentation`/`describe_region`
are synchronous in-request httpx. A minutes-long preprocess **must not** run in a gateway request.

**Resolution (make §4 explicit):** the **single-consumer job queue lives in `services/preprocess/`**
(an in-process worker thread + a job registry — Flask/WSGI, so a background thread, mirroring nothing
that exists yet = net-new but small). The gateway `POST /slides/{item}/preprocess` does a **fast**
httpx `POST /run` (enqueue, returns immediately) and **creates/updates the durable `slide_index`
row**; the panel/`find_regions` read status via the gateway (`GET /slides/{item}/index`), which reads
Postgres and, while `running`, may proxy the worker's live `/status` for stage/percent, reconciling
the row to `ready`/`failed` on terminal. **Only the gateway writes Postgres** (resolves §8's
cross-service-DB open question — worker owns transient progress, gateway owns the durable record).

---

## Notes (fold into §8, non-blocking)

- **N1 — inline artifact.** `ArtifactHandle.meta` only survives when the handle is built **inline** in
  `run_server_tool` (like `describe_region`, `tools.py:261-265`); neither store's `put()` forwards
  `meta`. `find_regions` must build `kind="regions"` with `meta={query, regions:[…]}` inline, ref="".
- **N2 — wiring names.** New config is `preprocess_service_url: str = ""` (env
  `AGENT_PREPROCESS_SERVICE_URL`, empty ⇒ tool disabled) in `common/config.py`; a `get_preprocess_url`
  route dep mirrors `get_pathvlm_url`; `ToolContext` gains `preprocess_url`; the turn route builds it
  at `routes.py:207-210`. Real file paths are nested (`gateway/`, `store/`, `common/`, `loop/`).
- **N3 — GPU contention (unchanged from §8).** Trident feature extraction is minutes of GPU coresident
  with CellViT-SAM-H + MedGemma on one A6000. The single-consumer queue serializes it; accept slower
  concurrent inference during a build. `conch` weights land in `~/.cache/huggingface/hub/models--
  MahmoodLab--conch` (lowercase repo id), not the Trident cache.

---

## Recommendation

Fold **F1** (the blocking text-search correction — `conch_v1` re-projected, drop `conch_v15` from the
text set, call the `conch` package directly) and **F2–F7** into the design, then write the **Inc 2b-1**
task-by-task TDD plan (preprocess backend, stub-first) plus **Inc 2b-3** (`find_regions`), which
together are the committable, on-page-E2E-able slice. Defer **Inc 2b-2** (the Preprocess tab) and the
contour/region overlay as explicitly blocklist-bound, net-new UI. Dev E2E resolves real slides from
`/home/chen/data2` and the live public DSA collections (BRCA-DEMO, TCGA-BRCA, …); the stub path needs
neither GPU nor Girder write access.
