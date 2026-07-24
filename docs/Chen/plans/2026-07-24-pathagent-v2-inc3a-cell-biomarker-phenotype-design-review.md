# Inc 3a design review — cell-level biomarker phenotyping (GigaTIME × CellViT)

> Adversarial, code-grounded review of `2026-07-24-pathagent-v2-inc3a-cell-biomarker-phenotype-design.md`.
> Grounded in the GigaTIME-Flash reference code (`scripts/gigatime_flash_tcga_wsi_inference.ipynb`,
> `scripts/archs.py`) and the live agent/frontend code, not from memory of the papers.
>
> **Verdict: 1 blocking · 6 should-fix · 3 open.** The architecture (new `biomarker` service, single
> `phenotype_cells` tool mirroring `run_segmentation`, phenotype-coloured nuclei overlay) is sound and
> reuses the existing seams cleanly. The blocking issue is a **semantic mislabel of what GigaTIME
> outputs**; the should-fixes are alignment/robustness gaps that would bite at the GPU smoke.

## What's already right (confirmed against code)

- **Tool shape mirrors `run_segmentation` exactly.** `tools.py:193` resolves `region = args.bbox or
  scope.roi`, `slide_ref = scope.item_id` (`:205`), caps area at `_MAX_SEG_AREA = 4096²` (`:153,:211`),
  calls the service with `ctx.girder_token`, and persists geometry via `ctx.artifacts.put`. `phenotype_cells`
  drops into this pattern with one new `ToolContext.biomarker_url` field (`ToolContext` at `tools.py:45`
  already carries `girder_token` + `cellvit_url`).
- **Service template is real.** `services/cellvit/src/cellvit_service/app.py` is a 77-line Flask app with
  injectable `READ_REGION`/`SEGMENT` seams and a main-thread `warm_up()` — the `biomarker` service is a
  near-copy with a `predict_mif` seam.
- **Overlay reuse is genuine.** `NucleiOverlay.jsx:37` already does `fillStyle = colorForClass(classes[i])`
  with a legend (`presentClasses`, `:84`). Phenotype colouring = a `phenotypeColors.js` sibling of
  `pannukeColors.js` + passing `classes = phenotype-names`. Zero overlay-engine changes.
- **CellViT returns level-0 centroids** (`app.py:56` `offset_points(..., region.scale)`), so a cell's
  location is already in the coordinate space the mIF must be indexed in.

## Blocking

### B1 — GigaTIME output is a marker-**presence probability**, not an intensity

The design (§0, §5, §7, §8) calls the per-cell vector an "mIF **intensity**" vector. The Flash forward
ends in **`return torch.sigmoid(logits)`** and the notebook annotates the result *"(23, 512, 512),
sigmoid probs"*; the original CNN trains with `BCEDiceLoss` against **binary** marker masks and
`db_test.py` binarizes with `output > 0.5`. So each channel is a per-pixel **probability that the marker
is present [0,1]**, learned against thresholded mIF — not a calibrated fluorescence intensity.

**Why it matters:** a demo that says *"CD8 intensity 0.42"* misrepresents the quantity and inflates the
claim. Pooling still works — the per-cell value is a **mean presence-probability** — and it composes even
better with the per-ROI adaptive threshold. But every user-facing string, the tooltip, the persona block,
and §5's "source of truth" wording must say **predicted marker-positivity probability**, and note the
authors' own default cut is 0.5. This is a correctness fix to the scientific claim, not an architecture
change. **Fold into the design before the plan.**

## Should-fix

### S2 — Never materialize the full-ROI raster
A `4096²×23` float32 mIF is ~1.5 GB. The design says "mIF stays in the process" but not that it is never
held whole. Specify: the service tiles the ROI into 256-windows (as the notebook does), pools the cells
whose centroid falls in each window, and **discards the window raster** — only per-cell scalars survive.
Peak memory is one window, not the ROI. (§5/§6.)

### S1 — Input magnification is unpinned
The notebook reads at `INFERENCE_LEVEL=0`, `PATCH_SIZE=512`, *"NO pre-resize"* — it feeds **native**-
resolution tiles, and the training mpp is undocumented in the repo. If our slide's native magnification
differs from GigaTIME's training scanner, the physical FOV per window differs and predictions drift. Pin
the expected input mpp and make the region read magnification-aware (Inc 2 already made magnification
first-class). The centroid→mIF-pixel map must divide by the **actual read scale**, not assume 1:1. (§4/§5
+ a new risk.)

### S4 — Assert the centroid ↔ mIF alignment invariant
The `biomarker` service reads the region for GigaTIME **and** calls CellViT for centroids. CellViT may
internally rescale a 20× region for memory (per the R11 GPU follow-up) yet returns level-0 centroids;
GigaTIME reads level-0 native. Both must resolve to the **same** level-0 bbox pixels. Add an explicit
invariant — `pixel = (centroid − bbox_origin) / read_scale`, bounds-checked — and a fixture test that a
known centroid lands on the intended mIF pixel. A silent half-patch offset here mis-phenotypes every cell
(this is the same failure class as `infer.py`'s centroid-offset comment in CellViT).

### S3 — Port the checkpoint key-remap verbatim; do not hand-roll
Loading Flash is not `load_state_dict(torch.load(...))`. The notebook unwraps `ckpt["state_dict"]`, strips
`module.`, and remaps `encoder.` → `encoder.base_model.model.` and `.base_layer.` → `.` (the LoRA
wrapping), then `load_state_dict(strict=False)`; input is `rgb/255` then ImageNet `MEAN=[.485,.456,.406]`/
`STD=[.229,.224,.225]`. Phase 1 must reproduce this remap exactly and assert missing/unexpected-key
counts match the notebook's — a wrong remap loads a **randomly-initialised** ViT that still runs and
returns plausible-looking garbage. Make it an explicit phase-1 task with a load-fidelity assertion.

### S5 — `phenotype_cells(bbox=null)` must fail cleanly in 3a
The design maps `bbox=null` → the Inc 3b whole-slide job, but 3a ships first. Until 3b lands, null must
return the exact `run_segmentation` message pattern — *"Whole-slide phenotyping isn't available yet — draw
a region on the slide (or pan to one) and ask again."* (`tools.py:200`) — never a silent attempt or a
hang.

### S6 — Guard the adaptive threshold against degeneracy
Otsu on a marker that is uniformly negative (or positive) in a region invents a split in noise — the exact
over-reading the Inc 2b calibration work rejected (the removed z-score). Require a minimum separation /
positive fraction before calling any cell `marker⁺`; below it, declare **"no positive population for this
marker in this region"** rather than gating on noise. This directly protects the low-quality markers in
④ below. (§5.)

## Open (lock during implementation)

- **O1 — the gate table.** Lineage priority when a cell is multi-positive (CK⁺CD8⁺ → tumour or T?), the
  exact Myeloid marker set, and whether DAPI-QC **drops** or merely **flags** low-DAPI cells. §5 gives a
  v1; confirm it at the plan.
- **O2 — per-cell payload size.** Shipping all 23 probabilities for thousands of cells bloats the
  artifact and the DSA annotation. Prefer: ship lineage + flags + the few gate-deciding values per cell;
  keep the full vector server-side (fetch-on-demand if ever needed). Decide in §7.
- **O3 — reliability weighting.** With per-channel Pearson from 0.70 (CK) to 0.13 (CD20), a CD20-gated "B
  cell" is far weaker than a CK-gated "tumour". Option: tag low-reliability markers in the tooltip / down-
  weight or exclude them from gating. Future, but note it so the demo doesn't over-trust CD20/PD-1.

## Cross-check with the risk register

The design's risks ①(research-only), ②(uneven marker quality), ③(per-ROI thresholds not comparable),
④(centroid-disk approximation), ⑤(4th model on one GPU) all still stand. This review adds the **implementation-
level** failure modes the risk register didn't cover: output semantics (B1), raster memory (S2), load
fidelity (S3), and geometric alignment (S4) — the ones most likely to produce confident-but-wrong output
at the smoke rather than an obvious crash.
