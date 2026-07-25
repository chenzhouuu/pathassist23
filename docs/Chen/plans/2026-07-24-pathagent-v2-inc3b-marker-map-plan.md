# Inc 3b — implementation plan (task-by-task, TDD)

> Built to `2026-07-24-…-inc3b-marker-map-design.md` (review-folded).
> Conventions from Inc 2b/2c/3a: tests first where the logic is pure, real weights on the GPU path,
> `uv run pytest` from the service dir, ruff line-length 100.

**Phase 1 = T1–T13** (region → pyramids → panel) · Phase 2 = T14–T19 · Phase 3 = T20–T25.

Every task states its test first. Tasks marked **GPU** cannot run in CI (the biomarker base image
is torch-free); their pure parts are extracted and unit-tested, and the composed path is covered by
the manual GPU smoke (T13).

---

## Phase 1 — region → pyramids → panel

### T1 — `cellvit`: return per-nucleus contours
**Test** `services/cellvit/tests/test_infer.py`: the stub backend returns a `contours` list aligned
with `points`/`classes`; `_clip_to_region` drops a point *and* its contour together.
**Do** `_cellvit_segment_array` reads `c["contour"]` alongside `c["centroid"]`/`c["type"]`
(`cells.json` already carries it — `inference.py:545`); `_clip_to_region` filters all three in
lockstep; `geometry.offset_points` gains `offset_rings` for contour rings; `app.py` adds
`contours` to the `/segment` response. Backwards compatible: existing consumers ignore the field.

### T2 — `biomarker/markers.py`: presets, palette, equivalents
**Test** `tests/test_markers.py`: every preset channel exists in `CHANNEL_NAMES`; every
`PHENOTYPE_ORDER` entry has a colour; `EQUIVALENTS` only names real channels.
**Do** add `PRESETS` (Structural/Immune/Functional/Lineage → `[(marker, "#rrggbb")]`),
`PHENOTYPE_COLORS`, and `EQUIVALENTS = {"Transgelin": "α-SMA (SM22α)", "CD34": "CD31/CD34"}`.
Pure data, no imports.

### T3 — `biomarker/artifacts.py`: hash, paths, coverage
**Test** `tests/test_artifacts.py`: `art_hash` is stable and order-independent, changes with
`seg_hash`/resolutions/version but **not** with bbox; `tile_path` rejects `..`/`/` segments;
`Coverage.add` is idempotent and `Coverage.missing(bbox)` subtracts what is done.
**Do** `art_hash()`, `artifact_dir()`, `marker_tile_path()`, `pheno_tile_path()`,
`cells_path()`, `Coverage` (load/add/missing/save, `core=4096`), `PIPELINE_VERSION`.

### T4 — `biomarker/pyramid.py`: write, downsample, read
**Test** `tests/test_pyramid.py`:
- marker level 0 write→read round-trips per channel by name (S2), and only the requested member is
  loaded (assert via `np.load(...).files` membership, not timing);
- `downsample_marker` averages 2×2;
- `downsample_pheno` uses **non-background-first + mode** — a single 4-px nucleus survives 4
  levels of downsampling and does **not** become background (the design's stated risk);
- `levels_for(width, height, tile)` returns a correct level count.
**Do** pure numpy/PIL. `write_marker_tile(dir, z, x, y, dict[str, uint8[256,256]])`,
`read_marker_tile(dir, z, x, y, names)`, `write_pheno_tile` (paletted PNG, index 0 transparent),
`build_levels(dir, layer, coverage)`.

### T5 — `biomarker/tiles.py`: composite + colourise
**Test** `tests/test_tiles.py`:
- `parse_channels("CK:00ffff,CD8:8000ff")` → ordered `[(name, (r,g,b))]`; rejects unknown markers
  and malformed colours;
- `transfer(p, lo, hi, gamma)` clips and gammas correctly at the endpoints;
- `composite` of one full-intensity cyan channel gives `(0,255,255)`; two channels saturate rather
  than wrap (`255`, never `4`);
- `colourise_pheno(idx, show=…)` maps index→palette and blanks filtered-out lineages;
- `TRANSPARENT_TILE` is a valid 256×256 RGBA PNG with `alpha == 0` everywhere (B2).
**Do** pure numpy + PIL encode.

### T6 — `biomarker/thresholds.py`: sample + Otsu + degeneracy guard
**Test** `tests/test_thresholds.py`: `sample_tiles(mask_tiles, frac, cap, seed)` is deterministic
for a given seed, respects the cap, and never returns a non-tissue tile; `slide_thresholds` on a
synthetic bimodal marker recovers a threshold between the modes; on a uniform marker returns
`None` (the Inc 3a degeneracy guard, reused verbatim from `phenotype._guarded_threshold`).
**Do** reuse `phenotype._otsu` / `_guarded_threshold`; add histogram accumulation across tiles so
memory stays flat.

### T7 — `biomarker/tiling.py`: core+halo geometry (B1)
**Test** `tests/test_tiling.py`:
- `core_tiles(bbox, core)` covers the bbox exactly, no gaps/overlaps;
- `haloed_read_window(tx, ty, core, halo, slide_w, slide_h)` clamps at slide edges and reports the
  core's offset within the read window;
- `owns(centroid, core_origin, core)` is a **partition**: for a grid of tiles and random points,
  every point is owned by exactly one tile;
- a contour whose centroid is in the core but whose ring extends into the halo is kept whole.
**Do** pure integer geometry, no I/O. This is the module B1 hinges on, so it is tested hardest.

### T8 — `biomarker/wholeslide.py`: the stage (pure core extracted)
**Test** `tests/test_wholeslide.py` with injected fakes (synthetic mIF `tile_predict`, fake
contour source, in-memory slide reader):
- a 2-core-tile region produces marker tiles, pheno tiles, cells sidecars and `coverage.json`;
- a nucleus straddling the core boundary is counted **once** and rasterised **whole** (the B1
  regression);
- thresholds come from `meta.json` and are identical for both tiles (no seam);
- re-running the same bbox is idempotent (coverage unchanged, no duplicate cells).
**Do** `run_region(...)` orchestrating T3–T7 + `phenotype.pool_cells`/`gate` from Inc 3a.

### T9 — `biomarker/slides.py`: region reader with local tier
**Test** `tests/test_slides.py`: the resolver prefers a local file matching by name+size; falls
back to the Girder reader when absent; never raises on a missing local root.
**Do** port `preprocess/slide_resolver.py`'s matching tier; OpenSlide imported lazily (base image
has none — the fallback path is what CI exercises).

### T10 — `biomarker/jobs.py` + routes
**Test** `tests/test_job_routes.py` (Flask test client, fakes injected):
- `POST /biomarker` with a bbox returns `{art_hash, job_id, status:"queued"}`;
- `GET /biomarker/status/{job_id}` transitions queued→running→ready;
- `GET /biomarker/{item}/{hash}/tile/markers/0/0/0.png?ch=CK:00ffff` returns a PNG;
- an **uncovered** tile returns the transparent PNG, HTTP 200, not 204 (B2);
- a bad `ch` → 400; unknown `art_hash` → 404; no weights → 503.
**Do** copy `preprocess/jobs.py`'s `JobQueue` verbatim (single consumer), add the four routes.

### T11 — gateway: enqueue + reconcile + tile/cells proxy
**Test** `services/agent/tests/test_biomarker_routes.py`:
- `POST /slides/{item}/biomarker` upserts a row with `kind="biomarker"`, `parent_hash=seg_hash`;
- `GET /slides/{item}/artifacts` reconciles a `biomarker` row from the worker's status;
- the tile proxy forwards query params verbatim, passes through content-type and cache headers,
  and requires a Girder session (401 without);
- worker 404/409/503 are forwarded, anything else → 502.
**Do** `get_biomarker_url` already exists; add `BiomarkerRequest`, the routes, `_reconcile_artifact`
support for `kind="biomarker"`, and a streaming proxy.

### T12 — frontend: presets, layer model, panel
**Test** `src/components/panels/markerUtils.test.js` (vitest, pure):
- `channelParam([{name,color}])` → `"CK:00ffff,CD8:8000ff"`;
- `tileUrlFor(mode, base, hash, params)` composes the right path + query and is stable under key
  reordering (so OSD does not thrash tiles);
- `presetChannels("Immune")` returns the designed list;
- `describeStage(row)` maps artifact status → panel copy;
- `levelOffsetFor(meta, layer)` returns 2 for markers, 0 for phenotype (S1).
**Do**
- `src/components/viewer/markerPresets.js` — presets + phenotype palette + equivalents (mirrors T2);
- `src/components/panels/markerUtils.js` — the pure helpers above;
- `src/components/viewer/MarkerLayers.js` — mount/unmount one custom `tileSource` on the OSD
  world, declaring **slide level-0 dims** + `level_offset` (S1);
- `src/components/panels/MarkersPanel.jsx` — three-mode radio, preset picker, channel checkboxes
  with colour swatches, `lo`/`hi`/`gamma` sliders, DAPI toggle, run button (bbox from the current
  ROI), artifact status + progress, "no segmentation yet" state with a one-click segment;
- `src/api/biomarkerApi.js` — mirrors `preprocessApi.js`;
- `RightPanel.jsx` — new `markers` tab.

### T13 — **GPU** smoke + browser E2E (real weights)
Run the real stack (`docker-compose.yml` + `docker-compose.biomarker.yml`), enqueue one 4096²
region on a real BRACS slide, and verify **in Chrome**:
1. the job completes and the artifact row reaches `ready`;
2. `Markers` mode paints an additive pseudo-colour composite on black that tracks pan/zoom;
3. toggling a channel changes the picture and the legend;
4. `Phenotype` mode paints nuclei **at their true shape**, lineage-coloured, with no chopped nuclei
   at the 4096 core seam (B1 acceptance);
5. `H&E` mode restores the plain slide;
6. zooming out shows coarse levels (S4), zooming in shows nucleus shape;
7. uncovered area is a hole, and the console shows **no** `tile-load-failed` storm (B2 acceptance).

---

## Phase 2 — whole slide

- **T14** measured tile-rate benchmark on one real slide (no ETA is shown to a user before this).
- **T15** `cellvit-batch` compose service + `BIOMARKER_CELLVIT_BATCH_URL` routing.
- **T16** compose mounts: `/data2:ro`, `biomarker_cache:/cache`, `preprocess_cache:/pcache:ro`;
  `openslide-python` in `Dockerfile.trident`.
- **T17** tissue-mask-driven tile list from `contours.geojson`; `bbox: null` ⇒ whole slide.
- **T18** incremental extension: coverage subtraction, `.lock`, coarse-level rebuild of affected
  tiles only, `summary.json` recomputation.
- **T19** panel: progress + ETA + coverage outline on the slide; free-space guard (< 3 GB refuses).

## Phase 3 — query & absorb

- **T20** `cells/` readers + `GET …/cells/{x}_{y}` proxy; browser LRU.
- **T21** hover tooltip (lineage, flags, gate-deciding probabilities; "predicted positivity", never
  "intensity").
- **T22** region statistics from a drawn box + CSV export.
- **T23** positivity-threshold sliders + re-gate job (no GPU): rewrite `pheno/` + `summary.json`,
  bump `threshold_rev`.
- **T24** `phenotype_cells` rewritten against the artifact (lookup → read, else enqueue a single
  core tile, honest partial on timeout — review S6).
- **T25** delete `PhenotypeOverlay.jsx`, `phenotypeColors.js`, `phenotypeUtils.js`(+test), store
  `copilotPhenotypes`/`showPhenotypeOverlay`, and the `ViewerPanel` mount.

---

## Acceptance for the increment

- biomarker / agent / frontend test suites green; ruff + `npm run build` clean.
- T13's seven browser checks pass on **real GigaTIME-Flash weights** and **real CellViT**.
- No fabricated numbers anywhere: with no weights the service is 503 and the panel says so.
- Copy discipline: every user-facing number is a **predicted marker-positivity probability**,
  slide-relative, research-use-only.
