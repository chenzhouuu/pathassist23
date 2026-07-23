# Inc 2b (pivoted) — Slide preprocessing (Trident) + a Preprocess panel, feeding `find_regions`

> **Supersedes** the `…-inc2b-find-regions-plan.md` (Girder-per-tile + PLIP auto-index) — that approach
> is abandoned (see §1). **Implements** the Inc 2 design's §3.2/§4 intent (whole-slide retrieval index +
> `find_regions`), re-architected onto **Trident** feature extraction and a **user-driven Preprocess
> panel**.
> **Status:** 🟢 design — decisions locked with Chen (2026-07-23); **reviewed + amended**
> (`…-inc2b-trident-preprocess-design-review.md`: 1 blocking + 6 should-fix folded in below).
> **Depends on:** the shipped copilot spine (SDK loop, two-class tools, Postgres store, typed SSE) +
> Inc 2a (`describe_region`, the pathvlm service, the magnification-aware reader).

## 0. TL;DR — what changed and why

The original Inc 2b built the retrieval index *inside* pathvlm by reading the slide **tile-by-tile over
Girder HTTP** and encoding each tile with **PLIP**, auto-triggered invisibly from a chat turn. We are
replacing that wholesale:

| | Original Inc 2b (abandoned) | **Pivoted Inc 2b (this doc)** |
|---|---|---|
| Read | Girder `/tiles/region` HTTP, per tile | **Trident** on the **source WSI file** (OpenSlide/CuCIM) |
| Tissue-aware | ✗ indexes glass/background too | ✓ HEST/GrandQC/Otsu **tissue segmentation** first |
| Encoder | PLIP (ViT-B/32, weak) | **Trident encoder registry**; **image default `conch_v15`**, **text-search default `conch_v1` (re-projected)** — see D2/F1 |
| Trigger | invisible auto-index in a chat turn | **first-class Preprocess panel** — user picks params, watches progress (panel deferred; see §7) |
| Artifacts | fp16 blob in a service cache volume | Trident h5 → **service artifact cache** keyed by params_hash, **attached to the Girder item when writable** (D3/F3) |
| Control/status | (none — the F2 gap) | **Postgres `slide_index`** control plane (TissueLab split) |
| `find_regions` | did the indexing itself | **lightweight consumer** of a ready index (**`conch` package** text→patch cosine) |

**Why the pivot is right (all grounded on this box):** Trident is already vendored (`github/TRIDENT`,
v0.3.0), CONCH + HEST-seg weights are cached, and CONCH has already been run over TCGA-BRCA/NSCLC. The
v1 `services/pathagent` did exactly this shape (Trident preprocess → CONCH patch features → cosine
retrieval; **fully recovered** from git `75d5523^`) — deleted in the greenfield rebuild, but the
pattern is proven and re-portable. This makes the feature index **reusable across the whole product**
(retrieval now, slide-level classification / similar-region / heatmaps later) — the TissueLab "compute
features once, reference everywhere" thesis.

## 1. Why not the per-tile / PLIP approach
- **No tissue segmentation** → the index fills with glass/background patches, polluting retrieval.
- **Thousands of HTTP round-trips** vs one OpenSlide file handle + GPU-batched encode.
- **PLIP ≪ CONCH / UNI** for pathology.
- The only advantage of per-tile reads was "no source-file access needed" — resolved by §3 (recovered
  v1 Girder file resolver + download).

## 2. Decisions locked (2026-07-23, Chen) — amended per review

| # | Decision |
|---|---|
| **D1 — Direction** | **Full pivot.** New Trident preprocess worker + Preprocess panel + Postgres index control + h5 artifact sink; `find_regions` becomes a lightweight retrieval consumer. |
| **D2 — Encoder** | **Multi-encoder, user-selectable** (panel dropdown from Trident's `encoder_registry`). **Text-search caveat (F1, corrected):** `find_regions(query: str)` needs a **vision-language** index whose patch features share the text space. In the vendored Trident that is **`conch_v1` built with `with_proj=True, normalize=True`** (default `conch_v1` features are pre-projection → invalid for text cosine) and **`musk`** — **NOT `conch_v15`** (it is a vision-only checkpoint with no text tower). So: **image default `conch_v15`; text-search default `conch_v1` (re-projected)**; text-capable set = `{conch_v1, musk}`. Image-only encoders still power future image→image "find similar to this ROI"; the panel badges which encoders enable text search. Text-encode + tokenize go through the **`conch` package directly** (Trident exposes no text API), and `conch`/`musk` are **optional Trident extras** the service image must install. |
| **D3 — Storage** | **h5 artifact sink is a seam (F3).** Default sink = a **service-local artifact cache** (mounted volume) keyed by a **params hash** (encoder+mag+patch_size+segmenter+version) — survives restart, needs no Girder write. **When the caller can write the item, also attach** the features h5 + coords h5 + contours GeoJSON as Girder files (DSA-native, multi-worker-shared). Girder write requires **item write permission**; a non-owner on a *public* slide 403s (the Inc 2c annotation precedent), so attach is best-effort, never the source of truth. The `slide_index` row (Postgres) is the durable record and points at wherever the h5 lives (`feature_ref`). |
| **D4 — Control plane** | **Postgres `slide_index` table** (in the copilot DB) is the durable index record + job status. Arrays never touch Postgres (TissueLab split). Created idempotently by appending to `_SCHEMA` (no alembic; F4). Accessed through a **separate `SlideIndexStore`** (ABC + Pg + Memory), not the conversation ABC. |
| **D5 — Coordinates** | Trident coords h5 stores patch coords at **level 0** (attrs `patch_size_level0` = level-0 side length, `target_magnification` = target mag; NOT `target_mag` — F5). Each patch → a level-0 bbox, so `find_regions` returns level-0 boxes for free. |
| **D6 — Async** | Heavy build is a **visible, user-initiated action** (F7): a **single-consumer GPU job queue lives in the preprocess service**; the gateway route only enqueues + owns the Postgres row (never blocks, never runs Trident in-request). |

## 3. Source-file access (recovered v1 pattern — F2)

Trident needs a **local file path**, not HTTP tiles. Re-port the recovered v1
`slide_resolver.resolve_slide(item_id, dest_dir, settings, girder_token)` + `girder_download.py`
(git `75d5523^`), which tries, in order:
1. **Local by `item_id`** — glob a configured `PREPROCESS_SLIDES_ROOT` for a file named `item_id`
   (validated against path/glob injection).
2. **Local by Girder file `name` + byte `size`** — `GET /item/{id}/files` for the largest WSI's
   `{name, size}`, then find a same-named, same-size file already under `slides_root` (size guards
   against same-named slides from different cases).
3. **Download** — stream `GET /file/{id}/download` → `.part` → atomic `os.replace` into a scratch dir,
   cached by name. Works for any backend incl. remote S3.

Dev points `PREPROCESS_SLIDES_ROOT` at `/home/chen/data2` (the **BRACS-164x** + **~4,577 TCGA `.svs`**
on disk today) → tiers 1–2 hit instantly. Prod (S3 assetstore, no local path) leaves it empty → tier 3.
All access stays **Girder-auth'd** — thread the caller's `Girder-Token` (the v1 worker defaulted it to
`None`, serving only public items; we close that gap). *Correction to the old draft:* v1 never read a
Girder **assetstore path** and never used **`/mnt/dsa-cache/`** (that is the large_image FUSE tile-byte
cache, not a browsable `.svs` store).

## 4. Service architecture

```
Preprocess panel (React, new right tab — DEFERRED this pass, §7)
        │  POST /api/copilot/slides/{item}/preprocess {encoder,mag,patch_size,segmenter,…}
        │  GET  /api/copilot/slides/{item}/index         (list/status, polled)
        ▼
services/agent (gateway)                        ── control plane ──►  Postgres `slide_index`
        │  fast POST /run to the worker (enqueue, non-blocking)  (item, params_hash, status,
        │  creates/updates the durable slide_index row           progress, encoder, mag, patch_size,
        │  reads status for the panel / find_regions             segmenter, n_patches, feature_ref,
        ▼                                                         error, created_at, updated_at)
services/preprocess  (NEW GPU worker service — single-consumer in-process queue)
        │  1. slide_resolver(item, token) → local .svs (§3)
        │  2. Trident WSI object: slide.segment_tissue → slide.extract_tissue_coords(level-0)
        │       → slide.extract_patch_features(encoder)          [stub seam: no GPU/Trident in CI]
        │  3. write {features.h5, coords.h5, contours.geojson} to the artifact cache (params_hash);
        │       attach to the Girder item when writable (D3/F3)
        │  4. expose progress via GET /status  (worker owns transient progress)
        ▼
artifact sink  ── service cache (default) ─┬─►  {cache}/{item}/{params_hash}/features.h5, coords.h5, …
                                           └─►  Girder item files (best-effort, when writable)
```

- **`services/preprocess/`** (new, GPU): Flask (matches cellvit/pathvlm; keeps the base env torch-free),
  wraps Trident via the **WSI object** (`slide = load_wsi(...)`, then `slide.segment_tissue /
  slide.extract_tissue_coords / slide.extract_patch_features`; segmentation feeds coords via the
  `slide.gdf_contours` side-effect — F5). **Stub/real seam** exactly like pathvlm's MedGemma: a
  deterministic stub encoder + a tiny synthetic slide exercise the full pipeline
  (resolve→segment→patch→encode→sink→status) with **no GPU/Trident**; real Trident+CONCH lands behind
  the seam (manual smoke), like CellViT (R8→R11) and MedGemma (Inc 2a). Endpoints: `POST /run`,
  `GET /status`, `POST /find_regions`, `GET /health`. **Single-consumer job queue** (an in-process
  worker thread) serializes GPU work against CellViT + MedGemma on the one A6000. Its own Dockerfile
  with Trident + torch + openslide + h5py + the `conch`/`musk` extras.
- **Gateway (`services/agent`)** owns the durable **`slide_index`** Postgres row (created on trigger,
  reconciled to ready/failed on completion) and the panel-facing routes. New config
  `preprocess_service_url` (env `AGENT_PREPROCESS_SERVICE_URL`, empty ⇒ disabled) mirrors
  `pathvlm_service_url`; a `get_preprocess_url` dep mirrors `get_pathvlm_url`; `ToolContext` gains
  `preprocess_url`. **Only the gateway writes Postgres** (F7). Files are nested:
  `gateway/routes.py`, `store/pg.py`, `common/config.py`, `loop/*`.
- **Retrieval** (`find_regions`, §6): given a ready **text-capable** index, load the features h5
  (from the cache / Girder), encode the query with the **`conch` package** text tower (`conch_v1`
  `encode_text` + its tokenizer — NOT a Trident method), cosine vs patch features, top-K → level-0
  bboxes + scores. Lives in the preprocess service (`POST /find_regions`); the gateway tool is a thin
  client.

## 5. The Preprocess panel (frontend) — deferred (F6)

A new right-rail tab **`preprocess`** would slot beside `copilot` — but registering a tab is **three
hardcoded edits across two files** (`ViewerApp.jsx` RightRail button + `RightPanel.jsx` `allTabs` +
`RightPanel.jsx` render switch/import), and the tissue-contour overlay mounts in `ViewerPanel.jsx` —
**`RightPanel.jsx` and `ViewerPanel.jsx` are on the do-not-commit blocklist**, and no GeoJSON/polygon
overlay exists yet (net-new drawing code). So the panel is **deferred** out of the committable slice
(§7). Its spec, when built:

- **Status header** — driven by `slide_index`: *not preprocessed* / *preprocessing… (stage, %)* /
  *ready: CONCH v1 @ 20× · 8,412 patches · 2h ago*.
- **Config form** (advanced collapsed): **encoder** dropdown (registry; **`conch_v1`/`musk` badged
  "🔍 text search"**), **magnification** 5/10/20/40, **patch size** 256/512, **segmenter**
  HEST/GrandQC/Otsu, seg threshold, remove holes/artifacts/penmarks toggles. Defaults: image
  `conch_v15` / text-search `conch_v1` / 20× / 256 / HEST.
- **Trigger → stage progress** (segmentation → patching → feature extraction) via polling.
- **Ready card** — n_patches, tissue area, encoder, a tissue-contour overlay (GeoJSON), and a line:
  *"these features now power Copilot region search."*
- **Reuse** — same params present → *"✓ already preprocessed"*; different params → a new index (keyed
  by params hash).

## 6. `find_regions` as a thin consumer

Once a **text-capable** index is ready, the copilot's `find_regions` tool (server class, wired via a
new `ctx.preprocess_url`) posts `{item, query, k, token}` to the preprocess service, which text-encodes
the query with the **`conch` package** and returns top-K level-0 bboxes + scores. The tool returns a
`ToolOutcome`:
- **ready** → summary *"Found K regions relevant to '<query>' (top score 0.NN)."* + an **inline**
  `ArtifactHandle(kind="regions", ref="", count=K, meta={query, regions:[{x,y,width,height,score}]})`
  — built inline in `run_server_tool` (meta only survives on inline handles — N1), like `describe_region`.
- **not indexed / image-only index** → *"This slide isn't preprocessed for text search yet — build a
  `conch_v1` index first."* (no spinning).

Grounding (prompt): `find_regions` returns **candidates by image↔text similarity, not verified
findings** — locate with `find_regions`, then confirm morphology with `describe_region` before
asserting. If not indexed, say so; do not spin.

## 7. Re-slicing (buildable order, each testable, stub-first) — amended per F6

- **Inc 2b-1 — Preprocess backend (committable, this pass).** `services/preprocess/` + slide_resolver
  (recovered v1) + Trident pipeline **seam** + artifact-cache sink (+ Girder-attach seam) + Postgres
  `slide_index` (`SlideIndexStore` ABC/Pg/Memory) + async job/`status` + gateway proxy routes + config
  wiring. **Stub-first:** stub encoder + tiny synthetic slide exercise resolve→segment→patch→encode→
  sink→status with **no GPU/Trident**; real Trident+CONCH behind the seam (manual smoke). Zero
  frontend, zero blocklist.
- **Inc 2b-3 — `find_regions` (committable, this pass).** Retrieval endpoint (`conch` text→patch
  cosine, behind the same stub/real seam) + the server tool (inline `kind="regions"` handle) + client
  + `_SYSTEM` grounding + config/ToolContext wiring. Surfaces through the **existing** Copilot panel's
  tool trace (`CopilotPanel.jsx`, not blocklisted) — the on-page E2E. Depends on 2b-1 producing an
  index.
- **Inc 2b-2 — Preprocess panel (DEFERRED — F6).** The `preprocess` tab + contour/region overlay:
  blocklist-bound (`RightPanel.jsx`, `ViewerPanel.jsx`) and net-new GeoJSON overlay drawing. Build when
  the dashboard WIP is resolved / the blocklist lifts.
- **Inc 2c (unchanged) —** RegionOverlay green-candidate rendering, reasoning-trace panel, adaptive-mag
  fly-in (also blocklist-bound frontend).

## 8. Risks / open questions
- **GPU contention.** Trident feature extraction is minutes of GPU, coresident with CellViT-SAM-H +
  MedGemma on one A6000 (48 GB). Serialize with the single-consumer queue; accept that a big preprocess
  run slows concurrent inference. Consider a nightly/batch mode later. (`conch` weights cache to
  `~/.cache/huggingface/hub/models--MahmoodLab--conch`.)
- **Trident packaging.** Heavy deps (torch, openslide, timm=0.9.16, transformers, h5py) + the
  **optional** `conch`/`musk` git extras (a plain Trident install omits them). Its own image, pinned
  like the cellvit/pathvlm driver-535 base.
- **Source-file access in prod.** The S3 assetstore → download tier (§3.3) must be validated on the
  real deploy; dev uses `PREPROCESS_SLIDES_ROOT` local paths.
- **Text-retrieval encoder (D2/F1).** Only `conch_v1` (re-projected) / `musk` indexes serve text
  `find_regions`; the tool must make that explicit and refuse cleanly on an image-only index.
- **Licensing.** **Trident itself is CC-BY-NC-ND 4.0**; CONCH is CC-BY-NC-ND; UNI/Virchow/etc. each
  have their own terms. Commercial intent is undecided — the multi-encoder choice lets the user pick a
  permissively-licensed encoder; flag per-encoder license in the panel.
- **Girder attach permission (D3/F3).** Best-effort; a non-owner on a public slide 403s. The service
  cache is the always-available sink; the Postgres row is the source of truth.
- **Cross-service DB (resolved — F7).** The worker owns transient `/status`; the **gateway** owns the
  durable `slide_index` row and reconciles on completion. Only the gateway writes Postgres.

---

**Next step:** the **Inc 2b-1** task-by-task TDD plan (Preprocess backend, stub-first), then **Inc
2b-3** (`find_regions`). Panel (2b-2) deferred.
