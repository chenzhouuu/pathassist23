# PathAgent v2 · Inc 4 — Dense Tissue Segmentation (Route B) · Design

> **Date:** 2026-07-30
> **Author:** Chen (with Claude)
> **Status:** Design — awaiting sign-off. No code written.
> **Context:** `2026-07-30-tissue-seg-classification-literature-review.md` (Route B)
> **Reuses:** Inc 3b (`2026-07-24-…-inc3b-marker-map-design.md`) — tiling, pyramid, coverage,
> job queue, authenticated tile proxy, OSD layer manager.
> **Ask (verbatim):** 走路线 B,完成后端和前端的一起实现,并且可以给出 overlay,需要可以做
> both WSI-level 以及 region level.

---

## 0. What this is

A **dense, pixel-level tissue-class map** as a third imaging modality, alongside the H&E and the
Inc 3b virtual proteome. Five classes — Tumour / Stroma / Inflammatory / Necrosis / Others —
predicted at 0.25 µm/px, stored as a class raster + per-class probabilities at 1 µm/px, served as
an OpenSeadragon tile pyramid, and **stackable under** the existing marker and phenotype layers.

This is the T1 slot the 2026-07-30 literature review identified as the gap: T0 (tissue vs
background) is Trident's `hest`; T3 (slide-level) is Inc 2c ABMIL; T1 was empty.

---

## 1. Decision ledger (grilled with Chen, 2026-07-30)

| # | Decision | Choice | Why |
|---|---|---|---|
| **D1** | Model backend | **TIAToolbox `fcn_resnet50_unet-bcss` now, but `backend` is a named field in `art_hash`** | The only dense tissue model that exists today, and it is breast-trained against a mostly-breast cohort. A future self-trained decoder drops in as a second backend with no change to the artifact shape, the tile protocol, or the UI. |
| **D2** | Where it runs | **New `tissue` service on :8023** | Matches the cellvit/pathvlm/biomarker precedent: one model, one env, one Dockerfile, one GPU queue. Costs ~400 lines copied from biomarker; buys not sharing a single-consumer GPU queue with GigaTIME and not making `biomarker` a lie. |
| **D3** | What we store | **argmax class raster + 5-channel uint8 probabilities, both at 1 µm/px (`level_offset` 2)** | Probabilities are what allow alpha∝confidence, re-gating without recompute, and probability-weighted area. A region costs ~360 KB; a whole slide ~700 MB (vs Inc 3b's 2.6 GB markers layer, already accepted). |
| **D4** | Frontend shape | **Independent `Tissue` panel; layers become a stack, not a radio** | tissue is a *base map*, not a competing view. "Cytotoxic T cells inside the Tumour region" is only visible if tissue and phenotype can be on at once. Cost: refactor Inc 3b's shipped `mode` model into `{base, layers}`. |
| **D5** | Non-breast slides | **Run anywhere, no organ gate and no UI banner** | Tumour/Stroma/Inflammatory/Necrosis are morphological concepts that transfer across carcinomas. `backend: bcss_fcn_unet` stays in `meta.json` and the backend's provenance is in `/tissue/catalog`; it is simply not surfaced on every screen. *Noted concern: a screenshot taken out of context carries no indication of the training domain.* |
| **D6** | Scope of this increment | **Strictly the ask** | Service + gateway + panel + stackable overlay + region/whole-slide + area statistics + real-weight E2E. **Not** an agent tool, **not** downstream filtering of Inc 2c/3b, **not** a self-trained backend. |
| **D7** | Default render | **Class colours with alpha ∝ confidence** | Uncertainty becomes visible without a control. Probability-blend and outline-only ship as switchable alternatives — D3 already paid for both, and Inc 3b already has both renderers. |

**Inherited from Inc 3b without re-litigation** (D5/D6 there): region and whole-slide are the *same*
job differing only in `bbox` (`null` = whole slide); repeated regions **accumulate into one
artifact** via a coverage bitmap, because `art_hash` excludes `bbox`.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ PathAssist (React)                                                   │
│   RightPanel: Viewer │ Copilot │ Markers │ ★Tissue                   │
│   ViewerPanel: OSD layer stack                                       │
│     [base]    H&E  or  black                                         │
│     [overlay] tissue    ☐  opacity 0.45   ← NEW                      │
│     [overlay] markers   ☐                                            │
│     [overlay] pheno     ☐                                            │
└───────────────────────────────┬──────────────────────────────────────┘
                  /api/agent/…  │  Girder-Token (header auth)
┌───────────────────────────────▼──────────────────────────────────────┐
│ Agent Gateway :8010     control plane + authenticated tile proxy      │
│   POST /slides/{item}/tissue          → enqueue, insert artifact row  │
│   GET  …/tissue/{ah}/meta                                             │
│   GET  …/tissue/{ah}/tile/{layer}/{z}/{x}/{y}.png                     │
│   GET  /tissue/catalog                                                │
│   artifact rows ride the SAME preprocess_artifacts table, kind="tissue"│
└───────────────────────────────┬──────────────────────────────────────┘
┌───────────────────────────────▼──────────────────────────────────────┐
│ tissue service :8023   (NEW)                                          │
│   _arch.py   resnet50-UNet  (vendored from TIAToolbox, BSD-3)         │
│   model.py   backend registry + weight loading                        │
│   infer.py   1024→512 sliding window, probability accumulation        │
│   wholeslide.py  core+halo job, pyramid build, statistics             │
│   tiling.py pyramid.py slides.py jobs.py routes.py  ← from biomarker   │
└───────────────────────────────┬──────────────────────────────────────┘
        slide pixels │                       │ tissue contours
┌────────────────────▼──────┐   ┌────────────▼─────────────────────────┐
│ Girder 5 / DSA :9080      │   │ preprocess cache (seg_hash contours)  │
└───────────────────────────┘   └───────────────────────────────────────┘
```

`parent_hash = seg_hash`, exactly as Inc 3b: the tissue mask is what tells the job where to run and
what to leave transparent.

---

## 3. The model

### 3.1 Architecture (fully determined from the checkpoint, not guessed)

`/home/chen/data2/tissue_seg/fcn_resnet50_unet-bcss.pth` — 372 keys, 140 MB, downloaded and
inspected.

```
backbone  = torchvision resnet50            (checkpoint keeps an unused `fc`)
            features: stem 64@/2 · layer1 256@/4 · layer2 512@/8
                      layer3 1024@/16 · layer4 2048@/32
conv1x1   = Conv2d(2048, 1024, 1)
upsample2x= nearest, unpool_mat = ones(2,2)
uplist[i] = BN → ReLU → Conv3x3 → BN → ReLU → Conv3x3     (pre-activation)
            0: 1024 → 512   1: 512 → 256   2: 256 → 64   3: 64 → 64
clf       = Conv2d(64, 5, 1)
```

**`skip_type = "add"`, not concat** — the decisive evidence is that `uplist.0`'s input BN has
**1024** channels. Upsampled `conv1x1` output (1024) concatenated with `layer3` (1024) would be
2048; added, it is 1024. Every level checks out the same way (512+512, 256+256, 64+64).
Checkpoint parameter indices are 0/2/3/5 with 1/4 parameter-free — exactly the pre-activation
ordering.

Forward: `x/255.0` → encoder → decoder → `clf` at /2 → **softmax** → bilinear ×2 → centre-crop.

> **`image / 255.0` only. No ImageNet mean/std.** Getting the normalisation wrong produces a
> confidently wrong map rather than an obviously broken one, so this is asserted by a unit test that
> pins the output of a fixed input tile.

### 3.2 Why vendor rather than `pip install tiatoolbox`

TIAToolbox's **code is BSD-3** — copying `unet.py` with its copyright header is licensed and clean
(unlike TissueLab's Penn licence, cl.9 of which makes derivatives Penn-owned). Installing the
package would drag openslide-python, shapely, scikit-image, zarr, glymur and its own `WSIReader`
into the image for one 120-line network we already know the shape of, and we already have slide
reading. Precedent: `biomarker/_arch.py` does exactly this for GigaTIME-Flash.

Safety net: the vendored module must load the checkpoint with `strict=True` (name *and* shape
agreement across all 372 keys), and a real-tile test asserts the class map is not degenerate.

### 3.3 Licence

- code (vendored arch): **BSD-3**, header retained
- **weights: CC-BY-NC 4.0 — non-commercial**. Recorded in `meta.json` as `weights_license` and in
  `/tissue/catalog`. This is the same class of constraint already carried by Trident/CONCH/CellViT.

---

## 4. Artifact

### 4.1 Hash

```python
art_hash = sha1(f"tissue|p={seg_hash}|backend={backend}|mpp={store_mpp:g}|ver={PIPELINE_VERSION}")[:16]
```

`bbox` is deliberately absent (Inc 3b D6): it is *coverage*, not identity. `seg_hash` transitively
carries the slide and the segmenter parameters. `backend` is what lets a future self-trained decoder
coexist with the BCSS map instead of invalidating it.

`PIPELINE_VERSION = "inc4-1"`. Bump whenever anything that changes the **numbers** changes:
weights, normalisation, window geometry, feathering, downsampling rule.

### 4.2 Layout

```
/cache/{item}/tissue/{art_hash}/
  meta.json       backend, classes, palette, trained_on, weights_license,
                  slide dims + mpp, layer level_offsets, PIPELINE_VERSION
  coverage.json   {"core": 2048, "done": [[tx, ty], ...]}       level-0 core-tile indices
  summary.json    per-class pixel counts + area mm², TSR, covered_mm2
  classes/{z}/{x}_{y}.png    paletted, index 0 = transparent (outside tissue)
  probs/{z}/{x}_{y}.npz      5 named uint8 planes, one per class
```

Both layers are 256 px tiles at 1 µm/px, so `level_offset = 2` against a 0.25 µm/px slide — the
same offset Inc 3b's marker layer uses, so the two share level arithmetic.

### 4.3 Palette (high-contrast, permanently bound)

| index | class | colour | rationale |
|---|---|---|---|
| 0 | *(outside tissue)* | transparent | not a class — the model has no background output |
| 1 | Tumour | `#D55E00` vermillion | Okabe-Ito; maximally separated from stroma |
| 2 | Stroma | `#0072B2` blue | |
| 3 | Inflammatory | `#009E73` green | |
| 4 | Necrosis | `#CC79A7` magenta | |
| 5 | Others | `#999999` grey | nerves, vessels, blood, adipose — a grab-bag, so it reads as neutral |

Index 0 is **not** a model output. It is written wherever the pixel falls outside the `seg_hash`
tissue contours. Without this the model happily labels glass, and every area fraction is wrong.

---

## 5. Geometry and seams

Two nested tilings, and each has its own seam risk. Inc 3b measured a **6.94×** local-gradient
spike from butt-jointed windows and killed it by feathering; the same discipline applies here.

**Job tiling** — `CORE = 2048`, `HALO = 256` at level 0, reused verbatim from
`biomarker/tiling.py`. The halo is *exactly* the model's own context margin (1024 in → 512 out
discards 256 px per side), so a core tile's interior is predicted with full context.

**Window tiling inside a core** — 1024 px input, 512 px output, stride `512 - OVERLAP`.
Probabilities from overlapping windows are accumulated with a cosine (Hann) weight and divided by
the weight sum **before** argmax, so feathering happens in probability space and the argmax is taken
once, on the blended field.

`OVERLAP` is a parameter, **not a guess**: build with `OVERLAP = 0` first, measure the mean absolute
horizontal gradient of the probability field at the 512 pitch against a same-distance off-pitch
baseline (the Inc 3b metric), and raise it only if the ratio exceeds ~1.2. Whatever it lands on is
recorded in `meta.json` and folded into `PIPELINE_VERSION`.

**Downsampling** — the two layers differ, for the same reason Inc 3b's two layers did:

- `probs` → 2×2 **mean** (the correct aggregate for a probability) → `pyramid.downsample_marker`
- `classes` → 2×2 **non-background-first, then mode** → `pyramid.downsample_pheno`

Unlike Inc 3b's nuclei, tissue regions are large, so a mode would survive here; but reusing the
existing, tested function costs nothing and keeps the "outside tissue stays outside" invariant
(a parent pixel is transparent only when all four children are).

---

## 6. HTTP surface

### tissue service (:8023)

```
GET  /tissue/catalog
     → {backends: {bcss_fcn_unet: {classes, colors, trained_on, weights_license, mpp}},
        default_backend, core}
POST /tissue                       {slide_ref, seg_hash, bbox|null, backend?, girder_token}
     → {art_hash, job_id, status, scope: "slide"|"region"}
GET  /tissue/status/{job_id}
GET  /tissue/{item}/{ah}/meta      → meta + coverage + summary
GET  /tissue/{item}/{ah}/tile/classes/{z}/{x}/{y}.png ? show=Tumour,Stroma & alpha=0.45
                                                       & conf=1            ← alpha ∝ max(p)
GET  /tissue/{item}/{ah}/tile/probs/{z}/{x}/{y}.png   ? ch=Tumour:d55e00,… & lo & hi & gamma
GET  /tissue/{item}/{ah}/tile/outline/{z}/{x}/{y}.png ? show=… & width=2
GET  /tissue/{item}/{ah}/stats     ? bbox=x,y,w,h     → class fractions for a sub-rectangle
```

Three render endpoints, one storage. `classes` and `probs` are Inc 3b's `colourise_pheno` and
`composite` essentially unchanged; `outline` is a 3×3 neighbour-difference on the class raster.

`503` when the service has no weights; `400` for a bad channel/class spec (never a silent drop);
a missing tile is a transparent PNG, **never `204`** — OSD's `<img>` loader cannot handle a
no-content response (Inc 3b review B2).

### gateway (:8010)

Mirrors the biomarker block in `gateway/routes.py`: `_need_tissue`, `_MAP_REFUSALS`, an artifact row
with `kind="tissue"`, `_reconcile_artifact` gaining a `kind == "tissue"` branch, and
`list_slide_artifacts` polling tissue rows at the tissue worker. Tiles are proxied so the browser
sends a Girder token in a **header** (`loadTilesWithAjax` + `ajaxHeaders`), never in a URL.

---

## 7. Statistics

`summary.json`, recomputed whenever coverage grows:

```json
{"covered_mm2": 12.43,
 "pixels": {"Tumour": 41_233_912, "Stroma": 29_881_004, ...},
 "fraction": {"Tumour": 0.432, "Stroma": 0.310, ...},
 "fraction_soft": {"Tumour": 0.418, ...},
 "tsr": 0.418,
 "n_core_tiles": 47}
```

- `fraction` — argmax pixel share of **tissue** pixels (index 0 excluded from the denominator).
- `fraction_soft` — probability-weighted share. Both are reported; they differ where the model is
  uncertain, and that difference is information, not noise.
- `tsr` — stroma / (tumour + stroma), the conventional tumour–stroma ratio orientation. Reported as
  a number with its denominator, never as a risk category.
- The panel always shows `covered_mm2` next to the fractions: a fraction over 3 % of a slide and a
  fraction over the whole slide are not the same claim.

CSV export writes one row per class with pixel count, mm², both fractions, the backend name and
`covered_mm2`.

---

## 8. Frontend

### 8.1 The layer-stack refactor (the one risky change)

Inc 3b shipped a three-way mutually exclusive mode and it is E2E-verified. D4 changes it:

```js
// before
mode: 'he' | 'markers' | 'pheno'

// after
{ base: 'he' | 'black',
  layers: { tissue: {on, opacity, render, show, conf},
            markers: {on, …}, pheno: {on, …} } }
```

`markerUtils.js` keeps every pure helper; `layerSignature` gains the layer name so three layers can
be mounted with independent signatures. `markerLayers.js` grows from "one overlay" to "an ordered
set", with each layer keyed by name so a change to one never remounts another. The 21 existing
vitest cases in `markerUtils.test.js` are the safety net and are updated in the same commit.

Mount order is fixed (tissue → markers → pheno), not user-controllable: tissue is areal and would
bury the point-like layers if it could go on top.

### 8.2 The Tissue panel

```
┌─ Tissue ──────────────────────────────────────────┐
│  Backend  bcss_fcn_unet ▾        Research use only │
│                                                    │
│  [ Analyse region ]  [ Analyse whole slide ]       │
│  Ready — 47 core tiles · 12.4 mm²                  │
│                                                    │
│  Render  ● Classes  ○ Probability  ○ Outline       │
│  Opacity ▓▓▓▓▓▓░░░░  0.45                          │
│  ☑ alpha follows confidence                        │
│                                                    │
│  ☑ ■ Tumour        43.2 %   (soft 41.8 %)          │
│  ☑ ■ Stroma        31.0 %                          │
│  ☑ ■ Inflammatory  14.1 %                          │
│  ☑ ■ Necrosis       6.6 %                          │
│  ☐ ■ Others         5.1 %                          │
│                                                    │
│  TSR  0.418                          [ Export CSV ]│
└────────────────────────────────────────────────────┘
```

Region comes from the shared `copilotRoi` (the box drawn on the slide) — the identical mechanism
the Markers panel already uses; whole slide is `bbox: null`. `Others` is unchecked by default
because it is a grab-bag, but its number is always shown.

No ETA is displayed until a whole-slide run has actually been timed (Inc 3b's rule: never show an
ETA derived from an estimate).

---

## 9. Build order

TDD, each step green before the next.

| # | Step | Done when |
|---|---|---|
| T1 | `_arch.py` vendored + `model.py` | `strict=True` load of all 372 keys; a fixed input tile pins the output |
| T2 | `infer.py` sliding window + feathering | overlapping windows reproduce a single-window prediction inside the core |
| T3 | `artifacts.py`, `tiling.py`, `pyramid.py` (adapted from biomarker) | hash excludes bbox; coverage add/has/missing; outside-tissue stays index 0 through 4 levels |
| T4 | `wholeslide.py` core job + tissue-contour masking + pyramid build | a synthetic slide produces the expected tile grid, and a class straddling a seam is not chopped |
| T5 | `tiles.py` three renderers | class filter, confidence alpha, probability composite, outline; bad spec → 400 |
| T6 | `routes.py` + `app.py` + `jobs.py` | full Flask surface against a fake predictor, no GPU |
| T7 | `Dockerfile.trident`, compose entry, weight mount | container starts, `/tissue/catalog` answers |
| T8 | gateway routes + artifact reconciliation | `kind="tissue"` rows appear in `/tasks`, tiles proxy with header auth |
| T9 | `tissueApi.js` + `tissueUtils.js` (+ tests) | pure helpers covered |
| T10 | layer-stack refactor in `markerUtils`/`markerLayers` | existing 21 cases updated and green; three layers mount independently |
| T11 | `TissuePanel.jsx` + RightPanel tab + styles | build clean |
| T12 | **Real-weight region run** | one 2048² region on a real breast slide; classes visually sane; seam metric recorded |
| T13 | **Real-weight whole-slide run** | a full slide end to end; wall-clock and disk recorded; coverage complete |
| T14 | **Browser E2E** | job through the gateway, layer mounts, stacks with pheno, tiles fetched with 0 failures |

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| **Vendored arch subtly wrong** → confident garbage | `strict=True` on 372 keys catches naming/shape; a real-tile assertion catches wiring; the `/255.0` normalisation is pinned by test |
| **Layer-stack refactor breaks shipped Inc 3b behaviour** | the 21 vitest cases are updated, not deleted; browser E2E asserts markers and phenotype still render as before |
| **Whole-slide run is slower than the estimate** | the ~20–40 min figure is an *estimate*; T13 measures it, and nothing user-facing quotes a duration until then |
| **Disk** | ~700 MB per whole slide. A free-space guard refuses a whole-slide job below 3 GB (Inc 3b's rule) |
| **GPU contention** with cellvit/GigaTIME | tissue owns its own service and queue; A6000 has 26 GB free and resnet50-UNet@1024² needs ~3 GB |
| **Non-breast slides** (D5) | accepted by decision; provenance stays in `meta.json` and `/tissue/catalog` |
| **CC-BY-NC weights** | recorded per artifact; blocks commercial use of this backend, not of the pipeline — which is why `backend` is swappable (D1) |

---

## 11. Verified vs assumed

**Verified in this session:** the checkpoint downloads (HTTP 200, 147 MB) and its 372 keys give an
unambiguous architecture including `skip_type="add"`; TIAToolbox code is BSD-3 and weights are
CC-BY-NC 4.0; the A6000 has 26 GB free; `biomarker/pyramid.py`, `tiling.py`, `artifacts.py` are
task-agnostic and reusable; the Markers panel already implements region-vs-whole-slide through
`copilotRoi` and `bbox: whole ? null : roi`; the gateway already carries an authenticated tile-proxy
pattern for `kind="biomarker"` rows.

**Assumed, to be measured:** the ~25 ms/window and 20–40 min/slide throughput; that `OVERLAP = 0`
may suffice given the model's built-in 256 px context margin; that BCSS's five classes read sensibly
on this cohort's slides. T12/T13 turn each of these into a number.

---

## 12. Measured (2026-07-31) — see the implementation review for the full account

| Assumption in §11 | Outcome |
|---|---|
| `OVERLAP = 0` may suffice | **Confirmed, decisively.** Seam ratio 1.042 either way; `OVERLAP = 64` costs +44 % compute and changes **11 px of 1,048,576 by ≤ 1/255** with a bit-identical class raster. Stays 0. |
| BCSS classes read sensibly | **Yes.** Tumour tracks the H&E's tumour nests, Stroma the fibrous bands, Others the adipose/empty space. Confidence tracks focus: sharp fields 0.65–0.90, an out-of-focus half of the same slide (70× lower Laplacian variance) 0.56 and two classes only. |
| ~25 ms/window, 20–40 min/slide | **Not measured — the GPU was unavailable for the whole session** (a user training job held all 49 GB). Everything was run on CPU: **41 s per 2048² core**, i.e. ~4.9 h for this slide's 434 tissue cores. Nothing user-facing quotes a duration. |

Two design changes came out of the work and are folded into §4.1 and §3: `overlap` is part of
`art_hash` (it changes the numbers, so it is identity), and the backend falls back to CPU when the
shared card is full rather than marking the service unavailable.

---

## 13. Stopping a build (added 2026-07-31)

The design specified no cancel path, and a review of the panel found the consequence: a whole-slide
build is hours of work holding the service's **only** worker, and the sole way out was
`docker compose restart tissue`. Added, with the semantics stated here because they are the whole
point of the feature.

**A stop is cooperative and lands on a core-tile boundary.** A thread cannot be killed mid-tensor;
`Progress.stopping()` is polled once per core, which is the only place where coverage and its
tallies have just been persisted. Latency is therefore one core — **measured at 24 s on CPU**, and
a fraction of that on the GPU.

**A stopped build is a smaller map, not a broken one.** The pyramid is still built and
`meta.json` / `summary.json` are still written, so what was covered is viewable and measurable the
moment it stops. It reconciles onto the artifact row as `cancelled` — never `failed`, which would
discard real measurements — carrying its composition, its covered area, and `remaining`.

**Resume is the same button.** Coverage already made a second job extend the first; the panel just
labels it *Resume whole slide* once a build has been stopped.

**What made this more than a button: the tallies had to become atomic with the coverage.**
Coverage was persisted per core, the tallies only at the end of a job. Any interruption left the
two disagreeing, and the resumed job published the fractions of the cores *it* ran under the core
count and the area of **all** of them — measured at exactly **half the true area** on a 4-core
regression case. The tallies now live in `coverage.json` and ride the same atomic write. The rule
is one line: *tallies describe `done`*.

For artifacts predating that, `summary.json` is honoured only while its own `n_core_tiles` matches
the coverage; otherwise the job discards those rasters and recomputes. Discarding the rasters is
part of it — orphaned tiles are still served, and still counted by `/stats` over a bbox, so leaving
them would give one artifact two contradictory accounts of itself.
