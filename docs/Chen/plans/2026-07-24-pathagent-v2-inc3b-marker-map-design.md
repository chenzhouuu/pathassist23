# Inc 3b — Virtual-mIF marker map & phenotype map (agent-independent)

> **Status:** design, grilling-confirmed 2026-07-24 (13 decisions); **review-folded** 2026-07-24
> (2 blocking + 6 should-fix from `…-inc3b-marker-map-design-review.md`).
> **Supersedes two Inc 3a decisions** — see §11.
> **Increment:** 3b. Parent: `2026-07-24-…-inc3a-cell-biomarker-phenotype-design.md`.

---

## 1. What this is

Inc 3a made cell-level virtual biomarkers work *inside a copilot turn*: draw an ROI, the agent
calls `phenotype_cells`, and dots appear. Three things are wrong with that as a product:

1. **The overlay is dots that scale with zoom.** At any zoom the nucleus is a 2.5 px circle. It
   reads as a scatter plot pasted on histology, not as an image of the tissue.
2. **It only exists inside the agent.** There is no way to just *look at* a slide's virtual
   proteome.
3. **It is ROI-only.** There is no whole-slide view, which is the view that actually shows
   tissue architecture.

Inc 3b turns the virtual proteome into a **first-class, agent-independent imaging modality**: a
pyramidal, pan/zoom-able **virtual-mIF composite** (per-marker pseudo-colour, additive, on black)
plus a **phenotype map** (nuclei painted at their true shape, coloured by lineage), both rendered
by OpenSeadragon exactly like the H&E itself.

**Visual target** — the "True CODEX / Virtual CODEX" figure the user supplied: whole-section
multi-marker composite on black at 5 mm scale, the same rendering holding down to 200 µm, a
grey DAPI structural channel, and marker panels (Structural / Immune, lineage / functional) with
one fixed colour per marker.

## 2. The physical constraint that shapes everything

At 40× a nucleus is ~10–12 px. Zoomed out far enough to see a whole section, **a nucleus is
smaller than one screen pixel**. Drawing 1–2 M polygons at that zoom is not merely expensive, it
is invisible. So:

> The whole-slide view is inherently a **raster**. Nucleus *shape* only carries information above
> a certain zoom. Both are therefore served as a **tile pyramid**, and the browser gets vectors
> only for the handful of tiles under the cursor when it needs per-cell facts.

This is the single idea the rest of the design falls out of.

## 3. Decisions (grilling ledger)

| # | Decision |
|---|---|
| **D1** | Cell layer is computed **whole-slide** and **rasterised server-side into a pyramid**. The frontend treats everything as OSD layers. Far view degrades naturally to a phenotype density field; near view is true nucleus shape. Vectors are fetched per-viewport only for interaction. |
| **D2** | Compute belongs to **`biomarker:8022`** (GigaTIME weights + GPU affinity already there). Control plane reuses the existing `preprocess_artifacts` table with `kind="biomarker"`, `parent_hash=seg_hash` → `/tasks` polling, progress and restartability come free. UI is a **new, independent `Markers` panel**, not a Preprocess sub-stage. |
| **D3** | Tiles are **composited server-side into one RGB PNG**. Disk holds 20 single-channel probability planes; the tile URL carries the current selection, colours and display transfer function. The frontend has exactly **one** marker layer. Colour / threshold / gamma changes are free (URL params). Cost: a selection change re-pulls the on-screen tiles (~200–500 ms, cacheable). |
| **D4** | Stored resolution: **marker 1 µm/px**, **phenotype 0.25 µm/px (native)**. ≈ **1.9 GB/slide** including coarse levels → ≈ 280 slides in the 544 GB free on `data2`. |
| **D5** | **region and whole-slide are the same job**, differing only by `bbox` (`null` ⇒ whole slide). One pipeline, one artifact shape, one rendering path. |
| **D6** | Repeated region jobs **accumulate into one artifact**. `art_hash` excludes `bbox`; a **coverage bitmap** records which tiles are computed; affected coarse levels are rebuilt after each extension; re-running a covered area is idempotent. |
| **D7** | **Preset panels** with fixed per-marker colours (Structural / Immune / Functional / Lineage), plus free selection + colour override savable as a custom preset. Phenotype colours are **permanently bound** (Okabe-Ito extended) so two slides can be compared. DAPI `#808080` serves as the grey structural channel. |
| **D8** | Three **mutually exclusive** display modes: **H&E / Markers / Phenotype**. Each owns its own controls. |
| **D9** | Positivity thresholds are **whole-slide uniform**, estimated by sampling ~2 % of tissue tiles through GigaTIME (no CellViT needed) and taking Otsu per marker. Per-marker sliders in the panel; changing one re-runs only the gate + re-rasterises the phenotype pyramid (minutes, CPU, no GPU). |
| **D10** | Per-cell records are written as **per-tile sidecars** + a slide-level `summary.json` → hover tooltips, region statistics, CSV export. No database. |
| **D11** | The agent becomes **another frontend over the same pipeline**: `phenotype_cells` looks up the artifact, reads sidecars if covered, otherwise enqueues a region job and waits. Single source of truth. The Inc 3a overlay layer (`PhenotypeOverlay.jsx`, `phenotypeColors.js`, `phenotypeUtils.js`, store `copilotPhenotypes`) is **deleted**. |
| **D12** | A second **`cellvit-batch`** instance isolates GPU contention (pure compose, +2.7 GB VRAM). Interactive traffic keeps `cellvit:8020`; batch jobs hit `cellvit-batch:8020`. |
| **D13** | **Three phases**: ① region → pyramids → panel (final shape, no long-job machinery) ② whole-slide job + coverage + batch instance ③ sidecars / hover / stats / export + agent absorption + delete the old layer. |

### Free consequences (not separate decisions)

- **Phenotype filtering** ("show only Cytotoxic T") is the same mechanism as marker selection:
  `?show=Cytotoxic%20T,Tumour` on the phenotype tile URL. The server filters before colouring.
- **Missing prerequisite**: with no ready `segmentation` artifact the panel says so and offers a
  one-click `POST /slides/{item}/segment` (existing route). It never silently starts one.

## 4. Architecture

```
                         ┌──────────────── browser ────────────────┐
                         │  Markers panel        OSD viewer        │
                         │  mode H&E/Mk/Ph   ┌── H&E (Girder)      │
                         │  preset + checks  ├── marker composite  │  ← one custom tileSource
                         │  sliders          ├── phenotype         │  ← one custom tileSource
                         │  progress/coverage└── (hover → sidecar) │
                         └───────────┬─────────────────────────────┘
                                     │ /api/copilot/…
                         ┌───────────▼──────────── gateway (copilot:8010) ────────┐
                         │ POST /slides/{item}/biomarker      → enqueue           │
                         │ GET  /slides/{item}/artifacts      → rows (+reconcile) │
                         │ GET  …/biomarker/{h}/tile/…        → proxy (auth)      │
                         │ GET  …/biomarker/{h}/cells         → proxy (auth)      │
                         │ preprocess_artifacts: kind="biomarker", parent=seg_hash│
                         └───────────┬────────────────────────────────────────────┘
                                     │
                ┌────────────────────▼─────────── biomarker:8022 ─────────────────┐
                │ JobQueue (1 consumer)                                           │
                │  ├ read tissue mask  ← preprocess cache  /cache/{item}/seg/…    │
                │  ├ sample 2 % tiles → GigaTIME → per-marker Otsu → thresholds   │
                │  ├ for each 4096² CORE tile inside tissue (read with 256 HALO): │
                │  │    read pixels (local OpenSlide, else Girder)                │
                │  │    GigaTIME → 23×H×W probabilities (over core+halo)          │
                │  │    ├ downsample ×4 → marker plane tiles (1 µm/px)            │
                │  │    ├ CellViT-batch → contours (haloed frame)                 │
                │  │    ├ KEEP only contours whose centroid ∈ core  (B1)          │
                │  │    ├ pool from the HALOED mIF → gate → phenotype             │
                │  │    ├ rasterise full contours, crop to core → phenotype tiles │
                │  │    └ per-cell records → sidecar                              │
                │  ├ rebuild affected coarse levels                               │
                │  └ update coverage bitmap + summary.json                        │
                │ GET /biomarker/{item}/{hash}/tile/{layer}/{z}/{x}/{y}.png       │
                │ GET /biomarker/{item}/{hash}/cells/{x}_{y}.json                 │
                └────────────────┬────────────────────────────────────────────────┘
                                 │ (batch only)
                        cellvit-batch:8020   ← nucleus contours, isolated from interactive
```

### Service changes at a glance

| Service | Change |
|---|---|
| `biomarker` | new: `jobs.py` (queue, copied shape from preprocess), `artifacts.py` (paths + hash + coverage), `pyramid.py` (write/read/downsample), `tiles.py` (composite + colourise), `thresholds.py` (sampling + Otsu), `wholeslide.py` (the stage), `slides.py` (local OpenSlide resolver, Girder fallback), `routes` for enqueue/status/tile/cells. Compose: `+ ${PREPROCESS_SLIDES_DIR}:/data2:ro`, `+ biomarker_cache:/cache`, `+ preprocess_cache:/pcache:ro`; `openslide-python` in `Dockerfile.trident` only (review S5). |
| `cellvit` | **no code change to the model path**; a second compose service `cellvit-batch` off the same image. `infer._cellvit_segment_array` must also return each cell's `contour` (already present in `cells.json:545`, currently discarded), and `_clip_to_region` must filter contours in lockstep. |
| `agent` gateway | new routes (enqueue/tile-proxy/cells-proxy); `kind="biomarker"` reconcile; `phenotype_cells` rewritten (phase 3). |
| frontend | new `MarkersPanel.jsx` + `markerUtils.js` + `markerPresets.js` + `MarkerLayers.js` (OSD layer manager); `RightPanel` tab; delete `PhenotypeOverlay.jsx` + `phenotypeColors.js` + `phenotypeUtils.js` + store `copilotPhenotypes` (phase 3). |

## 5. On-disk artifact layout

```
/cache/{item}/biomarker/{art_hash}/
  meta.json                     # params, slide level-0 dims, per-layer level_offset + level
                                # count, marker names, phenotype palette, thresholds,
                                # threshold_rev, pipeline version
  coverage.json                 # {"core": 4096, "done": [[tx,ty], …]}  (level-0 core tiles)
  summary.json                  # counts_by_phenotype, flag_counts, n_cells, area_mm2, …
  markers/{z}/{x}_{y}.npz       # 20 NAMED uint8[256,256] members — one per channel (S2)
  pheno/{z}/{x}_{y}.png         # paletted PNG, index 0 = transparent background
  cells/{x}_{y}.npz             # per-tile cell records (level-0 core-tile grid)
```

**Why one `.npz` per marker tile rather than 20 PNGs.** A composite of 8 markers would otherwise
be 8 file opens per tile per request; one npz is a single open. `numpy.savez_compressed` needs no
new dependency (the base image already has numpy) — importantly, `pyarrow` is *not* introduced.

**Why 20 named members rather than one stacked `[20,256,256]` array (review S2).** A stacked
array must be decompressed whole to read any channel. Named members let
`np.load(f)["CD8"]` inflate that member alone, so a 4-marker composite decompresses ~260 KB
instead of 1.3 MB — a 5× cut on the hottest path in the system, at identical file count and size.

**Layer alignment (review S1).** The two pyramids have different native resolutions (1 µm/px vs
0.25 µm/px), so their level-0 rasters differ by 4×. Every `tileSource` therefore declares the
**slide's** level-0 dimensions as `width`/`height`, and each layer's own coarseness is expressed
as a `level_offset` in `meta.json` (marker = 2 octaves, phenotype = 0). The frontend never
hardcodes it. Without this the two modes would not register against the H&E or each other.

**Phenotype tiles are paletted, not RGB.** Index 0 is background; index *i* is
`PHENOTYPE_ORDER[i-1]`. This is what makes `?show=` filtering and re-colouring a server-side
palette swap instead of a re-render, and it is what lets coarse levels be built by
**"non-background first, then mode"** — a plain average would dissolve nuclei into grey haze
because palette indices are nominal, not numeric.

### Hash

```
art_hash = sha1("bio|p={seg_hash}|mres={marker_mpp}|pres={pheno_mpp}"
                "|rad={nucleus_radius_um}|thr={threshold_mode}|ver={PIPELINE_VERSION}")[:16]
```

`bbox` is deliberately absent (D6). `seg_hash` transitively carries the slide and segmenter
params. Changing the sampled-threshold *values* by slider does **not** change the hash — it
rewrites `pheno/` and `summary.json` in place and bumps `meta.json.threshold_rev`.

### Coverage & concurrency

### Job tiling — core + halo (review B1)

A job's unit of work is a **4096² level-0 core tile read with a 256 px halo**:

```
CORE = 4096      # > _min_native_side for any real mpp, so cellvit's _pad_to_min stays a no-op
HALO = 256       # > 2× the largest plausible nucleus (~40 px at 0.25 µm/px)

read   [x-HALO, y-HALO, CORE+2·HALO]²
detect → contours in the haloed frame
keep   only contours whose CENTROID falls in the core   ← exactly-once ownership
pool   the marker disk from the HALOED mIF              ← complete disk at core edges
draw   the FULL contour, then crop the raster to the core
```

Centroid ownership partitions the plane, so every nucleus is claimed by exactly one tile — no
proximity dedup, no tunable threshold. This is what prevents the failure mode that would otherwise
dominate the map: without a halo, CellViT's edge-dedup does not span separate calls, so every
nucleus on a tile seam would be **counted twice, rasterised as two clipped fragments, and gated
from a truncated pooling disk** — a visible grid of chopped nuclei across the whole slide.

4096 cores also cut the tile count ~16× versus 1024 (≈190 per slide instead of ≈3000), cutting
per-call CellViT fixed overhead proportionally.

### Coverage & concurrency

`coverage.json` lists completed level-0 core tiles. A job:

1. computes its tile list = (bbox ∩ tissue mask) − coverage,
2. writes each tile's outputs, appending to coverage under an **exclusive lock file** in the
   artifact dir (`.lock`, `fcntl.flock`),
3. rebuilds every coarse tile whose footprint intersects the new tiles,
4. rewrites `summary.json` from the union.

Two jobs on the same artifact are serialised by the single-consumer `JobQueue`, so the lock
guards only against a second *process* (gunicorn is `-w 1`, so this is belt-and-braces).

## 6. Tile server

```
GET /biomarker/{item}/{art_hash}/tile/markers/{z}/{x}/{y}.png
      ?ch=CK:00ffff,CD8:8000ff,CD68:00ff00      # selection + colour, ordered
      &dapi=808080:0.35                          # optional grey structural channel
      &lo=0.15&hi=0.95&gamma=0.8                 # display transfer function

GET /biomarker/{item}/{art_hash}/tile/pheno/{z}/{x}/{y}.png
      ?show=Tumour,Cytotoxic%20T                 # optional lineage filter (default: all)
      &alpha=0.9
```

Compositing is additive with saturation, which is what makes it read like fluorescence:

```
v_c   = clip((p_c - lo) / (hi - lo), 0, 1) ** gamma        # per channel, per pixel
RGB   = clip( Σ_c  v_c · colour_c , 0, 255 )
```

Missing tile (outside coverage or outside tissue) ⇒ a **fully transparent 256×256 PNG**, built
once as a module constant (~100 bytes). It is *not* a `204` (review B2): OSD 4.1.1 loads tiles
through an `Image` element, so a bodiless response fires `onerror`, marks the tile failed, raises
`tile-load-failed` and enters retry/backoff — hundreds of failing requests per pan on a
partially-covered slide. A transparent PNG renders as the same hole with none of that.

Both routes are **read-only, cache-friendly** (`Cache-Control: public, max-age=…`, ETag from
`art_hash + threshold_rev + query`). The gateway proxies them so the browser's Girder token is
checked once and the biomarker service is never exposed directly (D3 of Inc 3a: tokens stay
server-side).

## 7. Thresholds (D9)

```
sample  : ~2 % of tissue job tiles, deterministic (seeded by art_hash), capped at 256 tiles
forward : GigaTIME only — CellViT is NOT needed → minutes, not hours
per mkr : histogram over sampled pixels (inside tissue only) → Otsu
guard   : the Inc 3a degeneracy guard still applies — if a marker's histogram is not
          separable (separation < 0.15 of range, or positive fraction < 1 %), its threshold is
          None and the marker cannot gate a lineage. It is still *displayable* as a channel.
```

Thresholds land in `meta.json` and are reported in the panel next to each slider, labelled
`auto`. Dragging a slider sets `threshold_rev += 1` and enqueues a **re-gate** job that reads
`cells/`, re-runs `markers.LINEAGE_RULES` / `FUNCTIONAL_FLAGS`, rewrites `pheno/` and
`summary.json`. No GPU, no model, no CellViT.

**This replaces Inc 3a's per-ROI adaptive threshold** — see §11.

## 8. Frontend

### Mode model (D8)

```
[ H&E ] [ Markers ] [ Phenotype ]        ← radio, exactly one active

H&E        : the Girder tile source alone (today's behaviour)
Markers    : black background · DAPI grey channel (default on, 0.35) · marker checkboxes
             from the active preset · lo/hi/gamma sliders
Phenotype  : black background · nuclei painted by lineage · lineage checkboxes ·
             per-marker threshold sliders · H&E fade-in slider (0 by default)
```

Only one data layer is ever mounted, so the two never fight for legibility, and switching modes
is `viewer.world.removeItem` + `addTiledImage`.

### Presets (D7)

| Preset | Channels |
|---|---|
| Structural | `CK` cyan · `Transgelin` magenta · `CD34` green · `Actin-D` red |
| Immune | `CD3` red · `CD8` purple · `CD4` cyan · `CD20` blue · `CD68` green · `PD-L1` yellow |
| Functional | `Ki67` yellow · `PHH3-B` orange · `Caspase3-D` red · `PD-1` green · `T-bet` blue |
| Lineage | `CK` cyan · `CD3` red · `CD138` magenta · `CD68` green · `CD34` blue |

`FAP`, `CD40`, `CD44`, `FOXP3` from the reference figure are **not** in GigaTIME's 23 channels;
`α-SMA ≈ Transgelin (SM22α)` and `CD31 ≈ CD34` are documented near-equivalents, labelled as such
in the legend so nobody reads them as the real antibody.

Phenotype colours (fixed, Okabe-Ito extended, luminous on black):

```
Tumour #E69F00 · Endothelial #56B4E9 · Plasma cell #CC79A7 · B cell #0072B2
Cytotoxic T #D55E00 · Helper T #009E73 · T cell #F0E442 · Myeloid #999999
Mast cell #FF61C9 · Other #4D4D4D
```

### Hover (phase 3)

`mousemove` → level-0 coordinate → owning job tile → fetch `cells/{x}_{y}.npz` (LRU-cached in
the browser) → nearest centroid within N px → tooltip with lineage, functional flags and the
gate-deciding marker probabilities. Same copy discipline as Inc 3a: **predicted marker-positivity
probability**, never "intensity", never a clinical claim.

## 9. Phasing (D13)

**Phase 1 — region → pyramids → panel.** `bbox` required. Skips only the *incremental* machinery
(extending an existing artifact, rebuilding coarse levels on extension) — the artifact shape is
already final. Delivers: threshold sampling, core+halo tiling, GigaTIME streaming, **both full
pyramids including all coarse levels** (review S4 — without them a region is invisible until you
zoom to 1:1), `coverage.json`, **`cells/` sidecars** (review S3 — they are a byproduct the
pipeline already computes; only their *consumers* are deferred), the tile server, the gateway
proxy, and `MarkersPanel` with three modes + presets + display sliders (`lo`/`hi`/`gamma`).
Minutes to first picture.

**Phase 2 — whole slide.** `bbox: null`, tissue-mask-driven tiling, incremental accumulation
against an existing coverage, coarse-level rebuild on extension, `cellvit-batch`, local OpenSlide
reads, progress/ETA in the panel, coverage outline on the slide. Opens with a **measured**
tile-rate benchmark before any ETA is shown.

**Phase 3 — query & absorb.** Hover tooltips, region statistics, CSV export, positivity-threshold
sliders + re-gate, `phenotype_cells` rewritten against the artifact, and deletion of the Inc 3a
overlay layer.

## 10. Risks

| Risk | Mitigation |
|---|---|
| **Whole-slide runtime is an extrapolation** (1–3 h from a single 1024² ROI), never measured. | Phase 2 opens with a measured tile-rate benchmark on one real slide before any ETA is shown to a user. |
| CellViT-SAM-H dominates the runtime. | `cellvit-batch` isolation (D12); tissue-mask restriction; the job is resumable via coverage, so a slow slide is not an all-or-nothing wait. |
| Disk: ~1.9 GB/slide, 544 GB free and already 85 % used. | `meta.json` records size; the panel shows per-slide footprint; artifacts are deletable by `art_hash`. Phase 2 adds a size guard that refuses to start when free space < 3 GB. |
| Coarse-level phenotype downsampling losing nuclei. | "non-background first, then mode" (§5), with a unit test asserting a single nucleus survives 4 levels of downsampling. |
| Seams between separately-thresholded regions. | Eliminated by construction — thresholds are slide-level and stored once in `meta.json` (D9). |
| Nuclei double-counted / chopped at job-tile seams. | Eliminated by core+halo tiling with centroid ownership (§5, review B1). |
| `phenotype_cells` blocking a copilot turn on a job longer than its 300 s timeout. | Agent-enqueued jobs are capped at **one 4096² core tile**; if the budget expires the tool returns an honest partial ("analysis started, N % done — the Markers panel will show it") plus the artifact handle, never an empty wait (review S6). |
| Whole-slide pixel reads over Girder are slow (PNG encode of a 4608² region per call). | Local OpenSlide tier in `slides.py` with a Girder fallback; compose mounts `/data2:ro`. A named Phase-2 task, not a footnote (review S5). |
| Marker-name near-equivalents (`Transgelin`≈α-SMA, `CD34`≈CD31) read as the real antibody. | Legend labels them explicitly; `markers.py` gains an `EQUIVALENTS` note surfaced in the UI. |
| GigaTIME's effective resolution is one 16 px token ≈ 4 µm; 1 µm/px storage is 4× oversampled. | Documented; the extra levels are decoder interpolation and are honestly labelled as such in the design, not sold as resolution. |

## 11. Corrections to Inc 3a

Two decisions in `2026-07-24-…-inc3a-cell-biomarker-phenotype-design.md` are **superseded**:

1. **"whole-slide as a 5th DAG node, `pheno_hash`, parent = `patch_hash`"** → parent is
   **`seg_hash`**. The whole-slide biomarker stage needs the *tissue mask*, not the patch grid;
   binding it to `patch_hash` would force an irrelevant tiling parameter into the hash and make
   the artifact rebuild whenever the encoder's patch size changed.
2. **"per-ROI adaptive threshold (Otsu), positivity relative to the region"** → **slide-level
   uniform thresholds**. Per-ROI thresholds make adjacent regions of one slide use different
   positivity standards, which (a) produces visible tile seams in an incrementally-assembled map
   and (b) makes whole-slide counts meaningless. The adaptive *spirit* is preserved — the
   threshold is still estimated from this slide's own distribution, just once, from a sample of
   the whole tissue.

Inc 3a's degeneracy guard, gate table, pooling radius, `align.py` and the "presence probability,
not intensity" discipline all carry over unchanged.
