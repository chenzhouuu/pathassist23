# PathAgent v2 · Inc 4 — Dense Tissue Segmentation · Implementation Review

> **Date:** 2026-07-31
> **Reviews:** `2026-07-30-pathagent-v2-inc4-tissue-segmentation-design.md`
> **Method:** the design was implemented T1→T14; this records what the implementation and the
> measurements **changed about the design**, what they confirmed, and what is still open.
> Everything below is a measured number or a code fact, not a projection.

---

## 0. Verdict

The design survived implementation with **two real defects found and fixed**, **one parameter
decided by measurement rather than by the threshold the design proposed**, and **one claim
corrected**. Route B works end to end on real weights: 16/16 browser checks, 205 tiles, 0 failures.

---

## 1. Defects found and fixed

### B1 — `overlap` changed the numbers but was not part of the artifact identity

`art_hash` was `sha1(seg_hash | backend | store_mpp | version)`. `overlap` changes the probability
field, so two runs at different overlaps would have produced **different numbers under the same
hash**, accumulated into **one coverage set**, with no way to tell which core came from which. A
map that is quietly two maps.

Found by trying to A/B the parameter: both runs returned the same `art_hash`.

Fixed: `overlap` is in the hash. The A/B then produced `2d616d132f2e111b` and `bc67c44c53024aed`,
which is what made the comparison meaningful at all.

### B2 — a full GPU made the service go dark instead of falling back

`create_app` loaded the backend on `cuda:0` and, on failure, logged "load failed; serving as
unavailable". On a card shared with cellvit, GigaTIME, Trident **and whatever the user is
training**, that turns a *slow* answer into *no* answer. Hit immediately: the A6000 had 42 MB free.

Fixed: `_load_on_best_device` catches a CUDA OOM and loads on CPU, `/health` reports `device`, and
`TISSUE_DEVICE` forces the choice. Every measurement in this document was taken on **CPU** as a
result — which is itself the useful finding that a region job is minutes and a whole-slide job is
not worth starting without the card.

---

## 2. Decided by measurement, not by the design's rule

### `OVERLAP` stays 0 — and the reason is stronger than the design's threshold

Design §5 said: build with `OVERLAP = 0`, measure the seam gradient at the 512 px pitch, raise it
only if the ratio exceeds ~1.2. Measured on a 2-core stitched field:

| | probability seam ratio | class-boundary on/off pitch | windows/side | wall clock (2 cores) |
|---|---|---|---|---|
| `OVERLAP = 0` | **1.042** | 1.29 | 5 | 70 s |
| `OVERLAP = 64` | **1.042** | 1.29 | 6 | 101 s |

Rather than stop at "under the threshold", the two artifacts were differenced directly:

> **11 pixels of 1,048,576 differ, by at most 1/255. The class raster is bit-identical.**
> For +44 % compute.

So the answer is not "the seam is acceptable" but "**feathering does nothing here**". The reason is
structural and worth recording: this network already discards 256 px of context per side
(1024 in → 512 out), so abutting output blocks are each computed with real neighbouring tissue.
Inc 3b's marker map measured **6.94** because its windows were butt-jointed with *no* margin at
all. The two situations are not comparable, and copying Inc 3b's fix would have been cargo-culting.

---

## 3. A design claim that was wrong

Design §3.1 derived the architecture from the checkpoint and asserted `skip_type = "add"` and a
two-convolution decoder block. Both correct — but the design also implied the reference
configuration was reachable as written. It is not: TIAToolbox's `UNetModel` needs
**`decoder_block=[3, 3]`**, not `[3]`; with `[3]` the reference itself fails to load the checkpoint
(24 unexpected keys). Recorded because anyone reproducing this against upstream will hit it.

With the right configuration the vendored module is **bit-exact** against the reference:
`max|Δ| = 0.0`, argmax agreement 1.000000, at both 512 px and 1024 px inputs. That check is
`tests/test_arch_reference.py`, skipped unless tiatoolbox is installed — a development gate, not a
runtime dependency.

---

## 4. Confirmed by the implementation

- **Masking by the parent contours was not optional.** The first real region returned
  `fraction = all zeros, covered_mm2 = 0.0`. That was *correct*: the bbox fell outside every
  tissue polygon (`tissue_core_tiles` intersects bounding boxes, so it admits false positives by
  design). Without the mask the same region would have returned confident percentages for glass.
- **The integer level offset was the right call.** The slide is 0.2525 µm/px; asking for "1 µm/px"
  yields `offset = 2` and an exact factor of 4, so a 2048 core is exactly 512 stored px = 2×2 tiles
  and no core ever shares a tile with another. `meta.store_mpp` reports the resulting **1.0100**,
  not the round number requested.
- **Area arithmetic checks out independently**: one 2048² core at 0.2525 µm/px is
  0.517 mm × 0.517 mm = **0.267 mm²**, which is exactly what `covered_mm2` reported for one core.
- **Hard and soft fractions genuinely differ** where the model is unsure — Inflammatory was
  1.1 % hard vs 5.0 % soft on the E2E region. Reporting only one would have thrown that away.
- **The confidence ramp does what D7 wanted**: `conf=0` → alpha uniformly 255; `conf=1` → alpha
  101–255 (mean 190, σ 37) with **identical RGB**. Independently, on the first slide tested,
  model confidence tracked focus: sharp fields (Laplacian variance 284–404) gave 0.65–0.90, an
  out-of-focus half of the same slide (variance ≈ 4, i.e. **70× less**) gave 0.56 and collapsed to
  two classes. Out-of-focus tissue therefore renders faint without anyone configuring anything.

---

## 5. Frontend

The layer-stack refactor (D4) landed as designed: `overlayLayers.js` holds the general machinery,
`markerLayers.js` became the biomarker binding, and Markers/Phenotype remain mutually exclusive
*with each other* while either may stack over tissue. Base-layer opacity is a **resolved
preference** (`setBasePreference`) rather than a setter, because two panels can now be open and a
plain setter would let whichever rendered last win.

One discovery worth recording, not changed: the viewer's icon rail is built in `ViewerApp.jsx` and
**contains neither Markers nor Tissue** — both are reachable only through the right panel's own tab
strip. That is pre-existing (Inc 3b shipped the same way); the E2E therefore opens the panel first.

---

## 6. Measured results

**Backend** — one 2048² core on **CPU**, real BCSS weights, TCGA-3C-AAAU (TCGA-BRCA,
151392 × 37993, 0.2525 µm/px, 434 tissue core tiles):

| | |
|---|---|
| region, 1 core | ~35 s · 2 cores 70 s |
| composition (2-core region) | Tumour 31.8 % · Stroma 47.1 % · Necrosis 5.2 % · Inflammatory 1.1 % · Others 14.7 % |
| TSR | 0.597 |
| disk | 144 KB classes + 1.3 MB probs for 2 cores **including all 9 pyramid levels** |
| artifact | `classes/0..8`, `probs/0..8`, 2×2 level-0 tiles per core, exactly as designed |

**Browser E2E** — real gateway, real service, real weights: **16/16 checks, 205 tiles, 0 failed,
0 console errors.** Covers: gateway records a `kind="tissue"` row parented on `seg_hash`; the panel
lists all five classes with hard *and* soft percentages, TSR and covered area; the layer mounts and
its tiles load; all three render modes repaint; the default-hidden class already puts `show=` on
the tile URL and unchecking another class changes it; the viewer survives both panels being active.

---

## 7. Still open

- **The GPU path is unvalidated.** The card has been at 42 MB free for the whole session (a user
  training job). Everything above is CPU. The design's "~25 ms/window, 20–40 min/slide" estimate is
  therefore **still an estimate** and nothing user-facing quotes it.
- **The whole-slide run is in flight on CPU** (434 tissue cores, `bbox: null`, extending the same
  artifact through coverage). Its purpose is to exercise the tissue-tile-driven list and a
  wide-extent pyramid; the throughput number it yields will be a CPU number.
- **Free-space guard** (`min_free_gb`) is configured but not yet enforced in the job.
- **Scope held**: no agent tool, no downstream filtering of Inc 2b/2c/3b, no self-trained backend
  (D6).
