# Inc 3 — Virtual biomarkers & cell-level phenotyping (GigaTIME × CellViT)

> **Builds on** Inc 2b-3 (preprocess DAG: `segment → patch → features`) and Inc 2c (the CellViT
> service returning per-nucleus centroids + PanNuke class, and the two-class agent tool loop).
> **Status: DESIGN — grilling-confirmed 2026-07-24. No code yet.**
> **Review folded (2026-07-24):** see the companion `…-design-review.md` (1 blocking · 6 should-fix ·
> 3 open). The blocking correction is authoritative here: **GigaTIME outputs `torch.sigmoid(logits)`, a
> per-pixel marker-*presence probability* [0,1], not a fluorescence *intensity*** — the per-cell vector
> is a mean presence-probability. All "intensity" wording below is corrected accordingly. The other
> findings (magnification pinning, windowed raster, load-fidelity remap, centroid↔mIF alignment,
> null-bbox clean-fail, adaptive-threshold degeneracy guard) are folded into the implementation plan.
>
> This is Tier-2 of a **two-tier virtual-proteomics stack**. It turns the viewer's cell layer from
> "how many nuclei, of which PanNuke class" into "what *biomarker phenotype* is each cell" — CD8⁺
> cytotoxic T, CD68⁺ macrophage, PD-L1⁺ tumour, Ki67⁺ proliferating — by fusing a **virtual mIF**
> prediction (GigaTIME-Flash) with the **nuclei we already segment** (CellViT).
>
> **Not clinical.** Both source models are research-only; every number the copilot reports here is a
> relative, virtual prediction, never a diagnostic marker readout. See §12.

## 0. The two source works (deep-read, code-level)

| | **GigaTIME** (MSR, *Cell* 2025) | **HEX** (Stanford, *Nat Med* 2026) |
|---|---|---|
| Core | H&E → **per-pixel** virtual mIF image | H&E → **per-tile** protein-expression vector |
| Model | UNet++ CNN (`scripts/archs.py`); **Flash** = `vit_small_patch14_dinov2` + LoRA, image→image | MUSK ViT (`hf_hub:xiangjx/musk`, 384²) + MLP head 1024→256→128→**40** |
| Output | **23 channels**, dense, at 256-window resolution | **40 markers**, one scalar/tile |
| Weights | **gated** on HF, real; Flash `model.pth` is **self-contained, single repo** (no 2nd base) | ships only a **1.2 MB regression head** ("pipeline-only, *not* paper-trained"); MUSK from public HF |
| Downstream | tile→stitch whole-slide mIF | **MICA** (MCAT co-attention MIL) → prognosis / IO response |
| License | code Apache-2.0, **model research-only** | **CC-BY-NC-ND 4.0** (non-commercial, no-derivatives) |

**GigaTIME-Flash channels (order fixed by `db_test.common_channel_list`):**
`DAPI, TRITC, Cy5, PD-1, CD14, CD4, T-bet, CD34, CD68, CD16, CD11c, CD138, CD20, CD3, CD8, PD-L1,
CK, Ki67, Tryptase, Actin-D, Caspase3-D, PHH3-B, Transgelin`. DAPI is a **nuclear reference**;
TRITC/Cy5 are **background** channels the authors exclude → **~20 usable markers**. Per-channel
quality varies widely (authors' own Pearson: DAPI 0.70, CK/CD11c/CD68 ~0.52 … **CD20 0.13**,
Actin-D 0.11) — see risk ④.

## 1. Integration thesis — a two-tier virtual-proteomics stack

The two works are **complementary layers, not alternatives**:

```
Tier 1  HEX      whole-slide · tile-level · 40 markers + MICA prognosis    "where / global context"
Tier 2  GigaTIME whole-slide/ROI · pixel-level × CellViT nuclei            "what each cell is"
        × CellViT → per-cell phenotype
```

**Only GigaTIME can reach the cell.** It is per-pixel, so pooling each channel inside the nucleus
masks we already produce yields a per-cell marker vector → phenotype. HEX is per-tile (one 40-d
vector per tile) and cannot resolve single cells. The literal ask — *cell-level biomarker
prediction* — is therefore **Tier 2**, and it anchors this increment. HEX (Tier 1) is deferred to
**Inc 3c** (a marker-map DAG stage reusing `features(encoder=musk)`, already in our registry, +
optional MICA prognosis).

## 2. Agreed decisions (grilling ledger, 2026-07-24)

| # | Fork | Choice | Consequence |
|---|------|--------|-------------|
| 1 | First-increment anchor | **GigaTIME × CellViT cell-level** | Literal "cell-level"; real downloadable weights exist. HEX/MICA → Inc 3c. |
| 2 | Cell output semantics | **Continuous per-cell mIF vector = source of truth + transparent marker-gating → phenotype** | Numbers always come from mIF pooling; phenotype is an interpretable derived layer; no new classifier to train. |
| 3 | Build strategy | **Real-weights-first** | Inc 3a ships real phenotypes; front-loads gated download + GPU integration risk (user's call, overriding the usual stub-first). |
| 4 | GigaTIME variant | **GigaTIME-Flash** | Better quality, **8× less GPU memory**, 6× faster — decisive on a GPU already holding CellViT-SAM-H + MedGemma + CONCH. Self-contained single gated repo, small ViT. |
| 5 | Fusion / tool shape | **One `phenotype_cells` tool; fusion inside a new `biomarker` service** | Dense mIF (23×H×W) **never leaves the GPU service**; nuclei centroids (small) fetched service→service from CellViT; per-cell artifact returned for the viewer. |
| 6 | Positivity threshold | **Per-ROI adaptive (Otsu / high percentile)** | No calibration data for our slides; GigaTIME output is relative. Positivity is stated as *"relative to this region"*. |
| 7 | Viewer render | **Phenotype-coloured nuclei + legend / counts / hover tooltip** | Reuses the existing nuclei overlay; all per-cell artifact records (centroid + phenotype + key marker values), **no raster** shipped. |
| 8 | Weights / token | **User offline-downloads Flash to data2; service reads local with `HF_HUB_OFFLINE=1`** | HF token stays in the user's HF cache — never in the repo, a service env, or data2 as cleartext. One gated terms-acceptance (`prov-gigatime/GigaTIME-flash`); no 2nd base repo. |
| 9 | Scope | **Whole-slide allowed** → ROI synchronous **+** whole-slide as a cacheable job/DAG stage | Whole-slide is minutes of GPU; it becomes a 5th DAG node (Inc 3b), not a blocking tool call. Sequenced after the ROI slice. |

## 3. Scope & sequencing across increments

- **Inc 3a — ROI, synchronous (this design's core).** New `biomarker` GPU service + `phenotype_cells(bbox)`
  agent tool + phenotype-coloured nuclei overlay. Real GigaTIME-Flash weights. Bbox-scoped, seconds.
- **Inc 3b — whole-slide, async.** A 5th preprocess DAG node (`phenotype`) that reuses the patch grid,
  runs Flash + CellViT per tissue patch, fuses, aggregates, content-addressed. `phenotype_cells(bbox=null)`
  triggers/reads it. Global (slide-wide) adaptive thresholds. §9.
- **Inc 3c — HEX tier (deferred).** `features(encoder=musk)` → HEX head stage → 40-marker heatmaps +
  optional MICA prognosis. Not in this design beyond the thesis.

**This document specifies Inc 3a in full and Inc 3b at interface level.**

## 4. The model — GigaTIME-Flash

Built from `_create_vision_transformer("vit_small_patch14_dinov2", pretrained=False)`, LoRA adapters
on `qkv`/`proj`, then the **entire** state (ViT + LoRA + decoder) loaded from the single file
`prov-gigatime/GigaTIME-flash/model.pth`. Runs on **256×256 windows**; a larger tile is split into
256 windows and the dense outputs are re-tiled. Output is `torch.sigmoid(logits)` — a `[23, H, W]`
per-pixel **marker-presence probability** in [0,1] (trained with BCEDice against binary marker masks;
authors' default cut 0.5), **not** a fluorescence intensity. Input is `rgb/255` then ImageNet
`MEAN/STD`; the checkpoint needs the notebook's key-remap (`encoder.`→`encoder.base_model.model.`,
`.base_layer.`→`.`, strip `module.`, `strict=False`) — a wrong remap silently loads a random ViT.

| | |
|---|---|
| Repo (gated) | `prov-gigatime/GigaTIME-flash` — accept terms once |
| Weights on host | `/home/chen/data2/models/gigatime/gigatime_flash.pth` → container `/weights/gigatime/...` |
| Loading | `HF_HUB_OFFLINE=1`; construct arch in code, `load_state_dict(strict=False)` from the local file |
| Env root | `BIOMARKER_WEIGHTS` (default `/weights/gigatime`) |
| `model_ver` | `gigatime-flash-v1` |

The trident compose override already mounts data2 at `/weights` (same mechanism Inc 2c used for MIL).

## 5. Cell-level readout — the fusion (the heart of Inc 3a)

Given a bbox: (a) read the region (Girder, like CellViT's `fetch_region`); (b) run Flash → `[23,H,W]`
dense mIF (region-local px); (c) fetch nuclei **centroids + PanNuke class** from the CellViT service
for the same bbox; (d) pool, threshold, gate.

**Pooling (centroid-disk, v1).** CellViT emits centroids only, not masks. Pool each channel over a
disk of radius `r ≈ nucleus_radius + small margin` centred on the centroid, with `r` in level-0 px
derived from `mpp` (nucleus ≈ 7–10 µm ⇒ `r ≈ 6 µm / mpp`); the margin captures the peri-nuclear
membrane ring that membrane markers (CD3/CD8/CD20/CD68/PD-L1) sit on. Output per cell: a 23-vector of
**mean presence-probabilities** [0,1] — the source of truth. The service processes the ROI **window by
window** (256²) and pools only the cells whose centroid falls in each window, **discarding each window's
raster** — peak memory is one window, never the whole `H×W×23` ROI (a 4096² ROI would otherwise be
~1.5 GB). *(Refinement path: surface CellViT instance masks for exact pooling — deferred; it enlarges the
CellViT contract and the artifact. See risk ⑤.)*

**DAPI QC.** DAPI is the nuclear reference: a centroid whose pooled DAPI is below the region's nuclear
floor is flagged low-confidence (misplaced/empty), not silently phenotyped.

**Per-ROI adaptive threshold (decision 6).** For each marker, positivity threshold = Otsu on that
marker's per-cell distribution within the region (fallback: high percentile if Otsu degenerates on a
unimodal region). A cell is `marker⁺` iff its pooled value ≥ the marker's region threshold. All
positivity is **relative to this region** and labelled as such. **Degeneracy guard (review S6):** Otsu
on a uniformly-negative (or -positive) marker invents a split in noise — the same over-reading the Inc 2b
z-score was removed for. Require a minimum separation / positive fraction before calling *any* cell
`marker⁺`; below it, declare *"no positive population for this marker in this region"* rather than gating
on noise.

**Transparent gating → phenotype (proposed v1 table; adjustable).** The per-cell vector is the source
of truth; the phenotype is a pure function of the gates below. **Lineage** is assigned by first match
in priority order (resolves multi-positive cells); **functional flags** are independent and additive.

```
Lineage (first match wins):
  Tumour / Epithelial   CK⁺
  Endothelial           CD34⁺  (and CK⁻)
  Plasma cell           CD138⁺
  B cell                CD20⁺
  T cell                CD3⁺   → Cytotoxic T  CD3⁺CD8⁺
                                 Helper T     CD3⁺CD4⁺
                                 T (other)    CD3⁺ otherwise
  Myeloid / Macrophage  CD68⁺ | CD11c⁺ | CD14⁺ | CD16⁺
  Mast cell             Tryptase⁺
  Other / Unclassified  none of the above
Functional flags (any lineage):
  Proliferating  Ki67⁺ | PHH3-B⁺        Apoptotic  Caspase3-D⁺
  Checkpoint     PD-1⁺ , PD-L1⁺          Effector   T-bet⁺
```

A cell therefore reads e.g. *"Cytotoxic T cell · PD-1⁺ Ki67⁺"*. The exact priority order and which
markers define "Myeloid" are the one open detail to lock at review; everything else follows from it.

## 6. Service — a new `biomarker` service (`:8022`)

Mirrors the CellViT service (`services/cellvit`) almost line-for-line: Flask (no pydantic v2 in the
process), the region reader and the model behind injectable `app.config` seams, `warm_up()` on the
worker main thread, `/health`. GigaTIME-Flash runs in-process behind an `infer.predict_mif` seam.

```
POST /phenotype {slide_ref, bbox, girder_token?}      → 200 {count, cells:[{x,y,phenotype,flags,markers,dapi_ok}],
                                                              counts_by_phenotype, thresholds, marker_names, bbox, mpp}
                                                        502 if the Girder region read fails
                                                        503 on the base (no-torch) image — never a fabricated result
GET  /health                                           → {status, service:"biomarker", model}
```

The service **calls the CellViT service** (`BIOMARKER_CELLVIT_URL`, default `http://cellvit:8020`)
for `{centroids, classes}` on the same bbox, runs Flash once, pools + thresholds + gates, and returns
compact per-cell records — the dense mIF stays in the process. Only the **trident image** carries
torch + the model; the base image answers 503 (Inc 2c's rule: an honest "needs the GPU worker" beats
a fabricated phenotype). New compose service on the `agent` project network, data2 mounted at
`/weights`, `HF_HUB_OFFLINE=1`.

## 7. Agent tool — `phenotype_cells` (server class)

A **server** tool (like `run_segmentation` / `describe_region` / `find_regions`): returns a text
summary + an artifact handle; the dense geometry rides the artifact, out of the model's context (D4).

- **Schema** (`sdk_tools._SCHEMAS`): `{ bbox: <bbox|null>, focus?: string }`. `bbox` null ⇒ whole
  slide (Inc 3b job); a bbox ⇒ ROI. `focus` optionally steers the summary (e.g. "immune infiltrate").
- **Summary** (numbers tool-derived only): e.g. *"312 cells — 141 Tumour, 68 Cytotoxic T (22 PD-1⁺),
  40 Macrophage, … ; positivity is relative to this region."*
- **Artifact** `{kind:"phenotype", count, cells:[{x,y,phenotype,flags,markers}], counts_by_phenotype,
  thresholds, marker_names}` — the viewer renders it.
- **Gateway**: new `AGENT_BIOMARKER_SERVICE_URL` (default `http://biomarker:8022`); empty ⇒ the tool
  is unavailable and says so plainly (same pattern as pathvlm/preprocess).
- **Persona** (`sdk._SYSTEM`, one added block): virtual biomarkers are a **research-only, relative,
  predicted** signal — never a clinical marker readout; report phenotype counts from the tool, don't
  invent positivity; state that thresholds are per-region so counts are not comparable across regions
  at absolute value.

## 8. Viewer — phenotype-coloured nuclei overlay

Reuses the existing nuclei overlay lifecycle (the same one that renders `run_segmentation` points and
`TissueOverlay.jsx`'s projection/redraw). Each cell is a dot coloured by **lineage phenotype**, with:
a **legend** (phenotype → colour), a **counts panel** (per-phenotype totals + key functional
fractions, e.g. "68 Cytotoxic T, 22 PD-1⁺"), and a **hover tooltip** showing that cell's phenotype,
flags, and its top marker values. All data is the per-cell artifact (small records); **no raster** is
transferred. A single-marker mIF heatmap toggle is explicitly **deferred** (it would require shipping
a downsampled channel raster out of the GPU service).

## 9. Whole-slide (Inc 3b) — a 5th DAG node

Extends the content-addressed DAG by one node, exactly as Inc 2c added `pred`:

```
seg_hash → patch_hash → feat_hash → …            (existing)
                     ↘ pheno_hash                 (new; parent = patch_hash — needs tiles + region, not features)
pheno_hash = sha1("pheno|parent={patch_hash}|model={gigatime-flash-v1}|seg={cellvit_ver}|gates={gates_ver}|ver={PHENO_VER}")[:16]
{cache}/{item}/pheno/{pheno_hash}/phenotype.h5   # per-cell: x,y,lineage,flags-bitmask,marker-vector
```

The job walks the existing tissue patch grid, runs Flash + CellViT per patch, fuses per §5, computes
**slide-global** adaptive thresholds (one per marker over all cells), and writes a per-cell table. A
new `preprocess_artifact` row `kind='phenotype'`, `result` = `{counts_by_phenotype, n_cells,
model_ver, ...}`; `phenotype_cells(bbox=null)` submits/reads it via the job queue + `/status` polling
the DAG already has. The heavy CellViT-whole-slide cost is real — 3b ships after 3a.

## 10. Data model / persistence

Inc 3a (ROI) is **ephemeral by default** — the tool returns the artifact; if we persist ROI runs, it
is the same `preprocess_artifact` table with `kind='phenotype'`, `parent_hash=<bbox digest>`. Inc 3b
uses the content-addressed `pheno_hash` above. No new table; the DAG extends by one node type. The
`result` JSONB column added in Inc 2c carries the phenotype summary for list-time display.

## 11. Numerical fidelity / validation

- **L1 — port faithfulness.** Run our `infer.predict_mif` against the authors' `gigatime_flash_testing.ipynb`
  on the **50 paired H&E/mIF sample patches** (their Dropbox set): assert per-channel mean-intensity
  agreement to tolerance, and reproduce their reported per-channel Pearson ballpark. Same weights,
  same inputs ⇒ same mIF. Ships as a checked-in regression over a small fixture.
- **L2 — fusion sanity, on our slides.** On a real slide ROI, verify the pipeline end to end: CellViT
  centroids align to the mIF (DAPI-QC pass rate), phenotype fractions are biologically plausible
  (tumour-rich vs immune-rich regions differ as expected), and the counts the tool reports equal the
  artifact tallies. Reported in the smoke write-up; not a CI threshold (no marker ground truth on our
  slides).

## 12. Sequencing (phases)

1. **Weights + offline load.** User accepts terms and `hf download`s Flash to data2 (§8-decision).
   `infer.predict_mif` seam: construct arch, offline `load_state_dict`, 256-window tiling. L1 fixture
   regression. *(no HTTP/DB)*
2. **`biomarker` service.** Flask app mirroring CellViT; `/phenotype` + `/health`; CellViT service
   client; pooling + adaptive threshold + gate table (pure, unit-tested); 502/503 paths. App tests
   with the model + CellViT-client seams overridden.
3. **Compose + gateway.** New `biomarker` service in `docker-compose.yml` (+ trident override for the
   GPU/torch image, data2 mount, `HF_HUB_OFFLINE`); `AGENT_BIOMARKER_SERVICE_URL`; gateway proxy +
   availability guard.
4. **Agent tool.** `phenotype_cells` in the two-class registry (`tools.py` + `sdk_tools._SCHEMAS`),
   server executor, summary formatter (tool-derived numbers), persona block; loop + schema tests.
5. **Viewer.** Phenotype-coloured nuclei overlay (reuse the nuclei lifecycle), legend + counts panel +
   tooltip, store state; `*Utils.js` pure helpers (gate colours, count formatting) + tests.
6. **Verification.** GPU smoke on a real slide ROI, L1/L2, browser E2E (ask → phenotype_cells →
   coloured overlay → the copilot's answer cites tool counts).
7. **Inc 3b** (separate plan): the `phenotype` DAG node + whole-slide job + global thresholds.

Phases 1–4 are backend; 5 is frontend; 6 is the gate. Phase 1 is blocked on the user's gated download.

## 13. Risks / open points

- **① Research-only, non-clinical.** GigaTIME model + HEX are research licences (HEX is also
  no-derivatives). The persona and any UI copy must frame virtual biomarkers as predicted/relative,
  never as a clinical marker result. Non-negotiable.
- **② Marker quality is uneven.** Authors' own Pearson runs from ~0.70 (DAPI/CK) down to **0.13
  (CD20)**. A CD20-gated "B cell" is far less trustworthy than a CK-gated "tumour". The tooltip should
  expose the raw pooled value so a weak call is visible; consider tagging low-reliability markers.
- **③ Per-ROI thresholds don't compare across regions.** Adaptive positivity means "35% PD-1⁺ here"
  and "35% PD-1⁺ there" used different cut-offs. Stated in the summary and the panel; Inc 3b's global
  thresholds are the cross-region-comparable answer.
- **④ Centroid-disk pooling is an approximation.** No masks means membrane vs nuclear marker signal is
  pooled by a fixed disk, not the true cell footprint. Acceptable for v1; exact masks (surfacing
  CellViT instances) is the refinement.
- **⑤ A 4th big model on one GPU.** Flash is small (8× less memory than base GigaTIME) precisely so it
  can coexist with CellViT-SAM-H + MedGemma + CONCH — but ROI size must stay bounded and whole-slide
  must be a batched job. Watch peak memory at warm-up.
- **⑥ Building on unverified ground.** Inc 2b-3 / 2c are local-only and uncommitted; the CellViT
  service this fuses with is the same one Inc 2c validated. A phase-6 failure may be upstream.
- **⑦ HEX real weights are unavailable.** Inc 3c (Tier 1) can wire the MUSK-feature → head pipeline,
  but numbers stay demo-quality until real weights are obtained or a head is trained on CODEX-paired
  data we do not currently have. Flagged now so Tier 1 is scoped honestly later.
