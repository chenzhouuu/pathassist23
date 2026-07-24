# Inc 3a — cell-level biomarker phenotyping — task-by-task TDD plan

> **Implements** `2026-07-24-pathagent-v2-inc3a-cell-biomarker-phenotype-design.md` (review-folded) —
> the ROI, synchronous slice: a new `biomarker` service running **GigaTIME-Flash** virtual mIF, fused
> with CellViT nuclei into per-cell phenotypes, a `phenotype_cells` agent tool, and a phenotype-coloured
> cell overlay. Whole-slide (`pheno` DAG node) is Inc 3b, a separate plan.
> **Status: COMPLETE (2026-07-24) — real GigaTIME-Flash deployed + GPU-smoke + E2E verified.** All 15
> tasks done, incl. T8. Weights (`prov-gigatime/GigaTIME-flash/model.pth`, 95 MB) downloaded to
> `/home/chen/data2/models/gigatime/`; the real GPU path runs via `docker-compose.biomarker.yml`
> (`/health` mode:real). **Checkpoint remap matched 252/252 tensors (100%)** — the port is faithful. Real
> `/phenotype` gives structured, differentiated phenotypes (unlike the dev stub); the **C1 fix is
> validated on the real forward** (a 1000×900 ROI with 488/388px partial tiles phenotyped 172 cells, no
> error). Full agent E2E (real model) → a nuanced answer that itself surfaces the region-relative-cutoff
> caveat. Tests: biomarker 31 / agent 179 / frontend 132 green, ruff + build clean. 7 commits on
> `feature/copilot-agent`, **not pushed**; gateway `routes.py` + store/CopilotPanel/ViewerPanel wiring
> stays local (rides atop uncommitted Inc 2b/2c + dashboard WIP). Follow-ups only: L1 vs the authors' 50
> paired samples (not downloaded), O3 marker-reliability weighting, S1 resampling (v1 reads native + warns).
>
> **Shape:** *real-weights-first* (decision 3), reconciled with TDD by **injecting deterministic
> synthetic mIF arrays + a fake CellViT client** into every unit test; the real GigaTIME-Flash lands
> behind the `predict_mif` seam and is verified by an **L1 fixture regression + GPU smoke** (T8, T15),
> never in CI. We do **not** fabricate stub phenotypes for the demo — an honest "GPU worker needed"
> (503) beats invented positivity.

## Conventions
- **Strict TDD:** each task is Red (failing test) → Green (minimal impl) → Commit, except the two
  model/infra tasks called out (T1 scaffold, T8 real model).
- **Conventional Commits**, subject ≤50 chars, English. Scopes: `biomarker` (new service), `agent`
  (gateway), `copilot` (frontend). End each commit with the
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- **Never commit** the dashboard WIP (`package*.json`, `src/components/dashboard/*`,
  `RightPanel/LeftSidebar/ViewerPanel.jsx`, `index.css`, `vite.config.js`, `src/test/`),
  `.env`/secrets/`settings.json`, or stray `fix/`, `services/agent/.claude/`. **Do not push. Commit only
  when explicitly asked.**
- Run service tests from `services/biomarker` and agent tests from `services/agent` with absolute
  `cd … && uv run pytest tests/…`. Frontend: `npm test`.
- **Weights never in repo/env/data2-cleartext.** GigaTIME-Flash weights are the user's offline download
  to `/home/chen/data2/models/gigatime/` → container `/weights/gigatime`; the service loads with
  `HF_HUB_OFFLINE=1`. **T8 and T15 are blocked on that download**; T1–T7, T9–T14 are not.

## Contract (recap)
```
phenotype_cells(bbox?: {x,y,width,height}|null, focus?: str)
  → summary: "<N> cells — <n> Tumour, <n> Cytotoxic T (<n> PD-1⁺), … ; positivity relative to region"
  → artifact: { kind:"phenotype", count, cells:[{x,y,phenotype,flags,markers?}],
                counts_by_phenotype, thresholds, marker_names }
```
- Per-cell value = **mean marker-presence probability [0,1]** (GigaTIME sigmoid), **not** intensity (B1).
- `bbox=null` ⇒ whole slide ⇒ **not available in 3a**: return the `run_segmentation` clean-fail message
  (S5). ROI area capped at `_MAX_SEG_AREA = 4096²` (reused from `tools.py:153`).

---

## Service side — `services/biomarker/` (new; mirrors `services/cellvit/`)

### T1 — scaffold the biomarker service  ·  `feat(biomarker): scaffold service`
*Infra (minimal test).* `services/biomarker/{pyproject.toml, Dockerfile, .gitignore}` and
`src/biomarker_service/{__init__.py, config.py}`. `config.py` reads `GIRDER_BASE` (default
`http://localhost:9080/api/v1`), `BIOMARKER_WEIGHTS` (default `/weights/gigatime`, optional → no-model),
`BIOMARKER_CELLVIT_URL` (default `http://cellvit:8020`), and the gate/pooling constants. Mirror
`services/cellvit/` layout.
- **Test:** `tests/test_config.py` — defaults load; missing weights ⇒ `use_model is False`.
- **Green:** the config dataclass.

### T2 — checkpoint loader + verbatim key-remap  ·  `feat(biomarker): Flash loader + key remap`  · *(S3)*
`model.py`: build `vit_small_patch14_dinov2` + LoRA + conv decoder → 23-ch head + sigmoid (port
`archs`/the flash notebook), and `load_flash(path)` reproducing the notebook remap **exactly**
(`ckpt["state_dict"]`, strip `module.`, `encoder.`→`encoder.base_model.model.`, `.base_layer.`→`.`,
`load_state_dict(strict=False)`) with a **load-fidelity assertion** (missing/unexpected-key counts within
the notebook's known bounds — a wrong remap silently loads a random ViT).
- **Test:** `tests/test_loader.py` — over a tiny synthetic state_dict, the remap maps every key and the
  fidelity assertion trips on a deliberately-wrong prefix. *(No real weights needed.)*
- **Green:** the arch + remap.

### T3 — windowed dense inference seam  ·  `feat(biomarker): windowed mIF seam`  · *(S2)*
`infer.py::predict_mif(rgb, model) -> np.ndarray[23,H,W]`: tile the region into 256² windows, run each,
write into the output, **discard each window raster after pooling is done** (the pooling in T4 is called
per-window so the full `H×W×23` is never held — peak memory is one window). Input normalisation
`rgb/255` → ImageNet MEAN/STD → CHW. The model is injectable (tests pass a fake).
- **Test:** `tests/test_infer.py` — a fake model returning a constant per window; a 384×384 region tiles
  to windows and reassembles to `[23,384,384]`; normalisation constants asserted.
- **Green:** the tiling loop + normalisation.

### T4 — pooling + adaptive gating + phenotype  ·  `feat(biomarker): pooling + adaptive gating`  · *(S6,O1)*
`phenotype.py` (pure): `pool_cells(mif, centroids, r)` → per-cell 23-vector (centroid-disk mean, DAPI QC
flag); `region_thresholds(vectors)` → per-marker Otsu **with the degeneracy guard** (min separation /
positive fraction, else "no positive population"); `gate(vector, thresholds)` → `(lineage, flags)` from
the §5 table (priority order + Myeloid set = O1, locked here). Positivity is region-relative.
- **Test:** `tests/test_phenotype.py` — synthetic mIF + centroids: a CK⁺ cell → Tumour, a CD3⁺CD8⁺ cell →
  Cytotoxic T with a Ki67 flag; a uniformly-negative marker yields **no** positives (guard); low-DAPI cell
  is flagged. Pooling is a plain disk mean.
- **Green:** the three pure functions.

### T5 — centroid ↔ mIF alignment  ·  `feat(biomarker): centroid-to-mIF alignment`  · *(S4)*
`align.py::to_region_pixel(centroid, bbox_origin, read_scale)` = `(centroid − origin)/scale`, bounds-
checked; the invariant that a level-0 centroid maps to the intended mIF pixel regardless of any CellViT
rescale. Wire it into `pool_cells`' indexing.
- **Test:** `tests/test_align.py` — a known level-0 centroid under `scale=2` lands on the expected mIF
  pixel; out-of-bounds centroids are dropped, not clamped silently.
- **Green:** the mapping + bounds guard.

### T6 — CellViT centroid client  ·  `feat(biomarker): CellViT centroid client`
`cellvit_client.py::fetch_centroids(base_url, slide_ref, bbox, token)` → `{centroids, classes, scale, mpp}`,
async httpx, token server-to-server (mirror the agent's `segmenter.py`).
- **Test:** `tests/test_cellvit_client.py` — `MockTransport` returns a canned body; fields map; HTTP error
  surfaces as a catchable exception.
- **Green:** the client.

### T7 — `/phenotype` route  ·  `feat(biomarker): phenotype route`  · *(S1)*
`app.py`: `POST /phenotype {slide_ref, bbox, girder_token}` — validate bbox present + area ≤ cap;
**magnification-aware** region read (pin the expected input mpp; read at that scale, thread `read_scale`
into alignment — S1); fetch centroids (T6); `predict_mif` (T3); pool+gate (T4,T5); return
`{count, cells, counts_by_phenotype, thresholds, marker_names, bbox, mpp}`. `502` on Girder read failure;
`503` on the no-torch base image (never a fabricated result); `400` on bad/oversize bbox. `/health`.
- **Test:** `tests/test_phenotype_route.py` — inject a fake `predict_mif` + fake CellViT client (à la
  cellvit `test_segment_route`): 200 returns typed counts; missing bbox ⇒ 400; oversize ⇒ 400; a Girder
  error ⇒ 502.
- **Green:** the route.

### T8 — real GigaTIME-Flash + L1 fixture  ·  `feat(biomarker): real GigaTIME-Flash inference`  · *(blocked on download)*
*Model task (no CI; manual smoke).* Load real Flash via T2 from `/weights/gigatime`, `HF_HUB_OFFLINE=1`,
warm singleton on the worker main thread (mirror CellViT `warm_up`). **L1 regression:** on ≥1 of the
authors' 50 paired sample patches, assert our `predict_mif` matches `gigatime_flash_testing.ipynb`
per-channel to tolerance (same weights + inputs ⇒ same sigmoid map). Ships as a checked-in fixture test
that **skips without weights**.
- **Verify:** manual smoke + the L1 fixture when weights are present. Unit suite stays green without them.

---

## Gateway side — `services/agent/`

### T9 — biomarker phenotype client  ·  `feat(agent): biomarker phenotype client`
`biomarker_client.py::phenotype_cells(base_url, slide_ref, bbox, focus, token) -> PhenotypeResult`, async
httpx, generous timeout, token server-to-server (mirror `segmenter.py`).
- **Test:** `tests/test_biomarker_client.py` — `MockTransport` canned body maps to the result; timeout/HTTP
  error surfaces.
- **Green:** the client.

### T10 — `phenotype_cells` server tool  ·  `feat(agent): phenotype_cells server tool`  · *(S5,B1)*
- `tools.py`: `phenotype_cells` `LoopTool` (SERVER); add `biomarker_url` to `ToolContext`; a
  `run_server_tool` branch — resolve `region = args.bbox or scope.roi`, `slide_ref = scope.item_id`,
  **null bbox ⇒ the S5 clean-fail message**, area cap `_MAX_SEG_AREA`, call the client, build a
  **tool-derived** phenotype summary (counts only, never model-invented; "positivity relative to region"),
  persist geometry `{kind:"phenotype", count, points, classes:phenotypes, flags}` via `ctx.artifacts.put`,
  return the handle. Degrade cleanly with no `biomarker_url`.
- `sdk_tools.py`: `_SCHEMAS["phenotype_cells"]` (`bbox`, `focus`) with descriptions.
- **Test:** `tests/test_tools_phenotype.py` — injected fake client → typed summary + `ok`; null bbox ⇒ the
  clean-fail string; no-URL context degrades; `sdk_tool_names()` includes `mcp__pathagent__phenotype_cells`.
- **Green:** the branch + schema.

### T11 — ground phenotype output in the prompt  ·  `feat(agent): ground phenotype_cells in prompt`  · *(B1,①③)*
Extend `_SYSTEM` (`sdk.py`): virtual biomarkers are a **research-only, predicted, region-relative
marker-*positivity probability*** — never a clinical marker readout or an intensity; report phenotype
counts from the tool, don't invent positivity; per-region thresholds mean counts aren't comparable across
regions at absolute value.
- **Test:** `tests/test_sdk_loop.py` — assert the new clause substrings (mirrors Inc 1/2a prompt asserts).
- **Green:** the prompt edit.

---

## Frontend — `src/`

### T12 — phenotype colours + utils  ·  `feat(copilot): phenotype colours + utils`  · *(O2)*
`phenotypeColors.js` (sibling of `pannukeColors.js`): `colorForPhenotype(name)`, `presentPhenotypes(list)`.
Pure `phenotypeUtils.js`: counts/fraction formatting, and **payload shaping (O2)** — the overlay consumes
`{points, phenotypes, flags, topMarkers?}`, not all 23 values per cell.
- **Test:** `phenotypeUtils.test.js` + colour test — stable colour per phenotype; counts format; shaping
  drops the full vector.
- **Green:** the maps + helpers.

### T13 — phenotype cell overlay  ·  `feat(copilot): phenotype-coloured cell overlay`
`PhenotypeOverlay.jsx` — reuse the `NucleiOverlay.jsx` lifecycle (`imgToViewer`, viewport-event redraw)
but `fillStyle = colorForPhenotype(phenotypes[i])`; a legend (present phenotypes + counts + key functional
fractions, e.g. "68 Cytotoxic T, 22 PD-1⁺") and a **hover tooltip** showing the cell's phenotype, flags,
and its gate-deciding probabilities. Store state `copilotPhenotypes` (mirror `copilotRegions`/nuclei). No
raster.
- **Test:** component/store test — an artifact renders N dots in phenotype colours; legend counts match;
  tooltip shows a cell's phenotype + flags.
- **Green:** the overlay + store wiring.

---

## Infra

### T14 — compose + gateway wiring  ·  `chore(biomarker): compose + gateway wiring`
*Infra.* Add `biomarker` to `docker-compose.yml` (port `8022`, `GIRDER_BASE`, `BIOMARKER_CELLVIT_URL`);
the **trident override** carries the GPU/torch image, the data2 mount at `/weights`, and
`HF_HUB_OFFLINE=1`. Thread `AGENT_BIOMARKER_SERVICE_URL` (default `http://biomarker:8022`) into gateway
settings and populate `ToolContext.biomarker_url` where `cellvit_url` is set. Base image ⇒ 503; unset URL
⇒ tool unavailable + says so.
- **Verify:** `docker compose config` parses; a settings test if unit-testable; else manual.

---

## Verification (the gate)

### T15 — GPU smoke + L1/L2 + browser E2E  · *(blocked on download)*
- **GPU smoke:** real Flash warms; `/phenotype` on a real slide ROI returns plausible per-phenotype counts;
  peak memory sits alongside CellViT-SAM-H + MedGemma + CONCH (risk ⑤).
- **L1:** the fixture regression vs the authors' notebook (T8).
- **L2:** on a real ROI — CellViT centroids align to the mIF (DAPI-QC pass rate), tumour-rich vs immune-rich
  regions differ as expected, and the tool's reported counts equal the artifact tallies. Reported, not a CI
  threshold (no marker ground truth on our slides).
- **Browser E2E:** ask → `phenotype_cells` on a drawn ROI → phenotype-coloured overlay + legend → the
  copilot's answer cites tool counts and frames them as predicted/region-relative.

---

## Definition of done (Inc 3a)
- With **no** biomarker service configured: `phenotype_cells` degrades cleanly; suite green.
- With the service on the **base image**: an honest 503 → the tool says the GPU worker is needed (no
  fabricated phenotypes).
- With **real GigaTIME-Flash** deployed (T8): a drawn ROI returns per-cell phenotypes, coloured in the
  overlay, cited by the copilot as research-only, region-relative marker-positivity — smoke-verified.
- All new unit suites green; `ruff` clean; `npm test` + `npm run build` clean; nothing pushed; dashboard
  WIP untouched.

**Blocked-on-user:** T8/T15 need the gated Flash weights at `/home/chen/data2/models/gigatime/`. Every
other task proceeds without them.

**Next after 3a:** Inc 3b (the `pheno` whole-slide DAG node + global thresholds) and Inc 3c (HEX Tier-1:
`features(encoder=musk)` → 40-marker map + MICA prognosis).
