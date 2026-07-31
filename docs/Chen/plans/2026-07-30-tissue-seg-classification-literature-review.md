# Tissue Segmentation & Classification — TissueLab Re-Review + Model/Project Landscape

> **Date:** 2026-07-30
> **Author:** Chen (with Claude)
> **Context:** `2026-07-14-cpath-toolbox-agent-literature-review.md` (§4 explicitly listed
> *"tissue/tumor-segmentation SOTA specifics"* as a **coverage gap** — this document closes it).
> **Scope:** (1) what TissueLab's tissue layer actually is, verified against the clone, not the
> paper; (2) which models and projects to consider if we build tissue segmentation + classification
> into PathAssist.
> **Method:** local clone inspection (`github/TissueLab` @ `0ee1ed0`, 2026-05-16;
> `github/TRIDENT`) + targeted web search. Evidence quality is flagged per claim in §6.

---

## 0. The short answer

1. **TissueLab will not give you a tissue segmentation model.** Its `TissueSeg` / `TissueClassify`
   categories are real, but for *pathology* they resolve to **MUSK patch embeddings → a light patch
   classifier**. BiomedParse and TotalSegmentator are declared **radiology-only in its own
   registry**; VISTA has no Linux bundle; `services/factory/tissue_segmentation.py` is still a
   `# do something...` stub. The asset is the **pattern**, again — and its pathology answer happens
   to be *exactly the architecture our DAG already produces*.
2. **The cheapest real capability we can add is a patch-level tissue classifier over features we
   already compute.** `segment → tile → features` already stores a CONCH/UNI vector per 256 px @20×
   patch. A tissue class map is a linear head over that plus a paletted tile pyramid — and Inc 3b
   already built the pyramid (`pyramid.py` `write_pheno_tile` / `downsample_pheno` are
   task-agnostic class-raster code).
3. **Dense (pixel-level) tissue segmentation is a separate, heavier build** — take it only when
   128 µm patch cells are provably too coarse for the question being asked.
4. **A free win today:** Trident already ships `GrandQCSegmenter` + `GrandQCArtifactSegmenter`
   alongside the `hest` segmenter we use. GrandQC is the current reference for tissue detection +
   artifact QC (Nat Commun 2024). Switching/adding is a config change; only the weights need
   fetching (`local_ckpts.json` has empty paths for both; only `deeplabv3_seg_v4.ckpt` is on disk).

---

## 1. TissueLab re-review (clone @ `0ee1ed0`, 2026-05-16)

The 2026-07-15 review still holds structurally. What is new/sharper here is the **tissue-level**
picture, read straight from `app/service/storage/model_registry_preset.json`:

| Category | Registry members | What it really is |
|---|---|---|
| **TissueClassify** | `BiomedParseClassification`, `MuskClassification`, `TotalSegmentatorClassification` | Only **MuskClassification** is pathology. Its own description: *"Patch-based classification model for pathology whole slides. You must use MuskEmbedding node to generate patch embeddings first."* |
| **TissueSeg** | `MuskEmbedding`, `BiomedParseSegmentation`, `TotalSegmentatorSegmentation`, `VISTA` | `MuskEmbedding` = *"Generates patch embeddings … used downstream by patch classification"* — an **encoder filed under segmentation**. BiomedParse/TotalSegmentator are described as **radiology** (*"Tissue segmentation for radiology images"*). `VISTA` is the only histopathology segmenter and **has no Linux bundle**. |
| **NucleiSeg** | `SegmentationNode` (StarDist `2D_versatile_he`), `InstanSegNode` | The production path. StarDist is the declared default; InstanSeg *"only when explicitly requested"*. |
| **NucleiClassify** | `ClassificationNode` (NuClass) | Per-nucleus head over the segmentation output. |
| SpatialOmics / TaskSpecific / CodingAgent | CellCharter · Ark, CardiacMRSegmentation · GPT-4o Agent | — |

Three observations that matter for our decision:

- **Their "tissue segmentation" for pathology is patch classification.** There is no dense tissue
  decoder anywhere in the shipped system. `TissueSegEmbeddingFields.tsx` in the frontend confirms
  the intent: the tissue stage is parameterised by *embedding* fields.
- **The TIAToolbox icons are dead assets.** `tissue_segmentation_tia_toolbox_breast_cancer.png`,
  `..._tissue_mask.png`, `tissue_segmentation_biomedparse.png`,
  `tissue_segmentation_segment_anything.png` exist in `render/public/images/icons/`, but
  `grep -r "tia_toolbox"` over all `.py/.ts/.tsx/.json` returns **zero** hits. They are the
  *intended* implementation-candidate pool (the paper's `M_cand`), not shipped code.
- **`schema: null` on all 14 nodes, still.** Every I/O contract is English prose. Our Inc 2b/2c/3b
  artifacts (content-addressed hashes, typed stage params) are already strictly ahead here.

**Verdict unchanged:** port the pattern, own the code. What is *newly* worth stealing is the
`Embedding → Classification` two-node split for the tissue stage — it is the same
compute-once/re-head-cheaply structure our `feat_hash` already enables, and it is why re-gating a
tissue map should never re-run the encoder.

---

## 2. Disambiguating "tissue segmentation and classification"

The phrase covers four tasks with different data, models and costs. Deciding *which one* is the
first real decision.

| # | Task | Output | Typical resolution | Where we stand |
|---|---|---|---|---|
| **T0** | Tissue detection + artifact QC | tissue mask, blur/fold/pen mask | 1–10 µm/px | **Have** (`hest`); **GrandQC available unused** |
| **T1** | Tissue-region semantic classes (tumour / stroma / lymphocyte / necrosis / mucosa / muscle / debris …) | class map | patch (128 µm) or dense (0.5–2 µm/px) | **Nothing** — this is the gap |
| **T2** | Structure segmentation (glands, epithelium, vessels, nerves, TLS) | instance/semantic masks | dense, 0.25–0.5 µm/px | Nothing |
| **T3** | Region/slide-level classification (subtype, grade) | label + score | region or slide | **Have** (Inc 2c ABMIL, CONCH retrieval) |

Most requests phrased as "tissue segmentation and classification" mean **T1**, and T1 is where the
literature actually splits into routes.

---

## 3. What the existing stack already gives us for free

| Asset | Why it matters for T1 |
|---|---|
| `segment → tile → features` DAG, content-addressed | A tissue head parents on `feat_hash`; re-heading never re-encodes. Same trick as TissueLab's Embedding/Classification split, already implemented. |
| CONCH `conch_v1` (vision) / `conch_v1_text`, 256 px @20× | 128 µm patch cells. Vision variant for a trained head; text variant for **zero-shot** class prompts. |
| Inc 3b pyramid (`pyramid.py`, `tiles.py`) | `write_pheno_tile` / `downsample_pheno` (non-background-first + mode) and `colourise_pheno` are a **generic paletted class raster**, not phenotype-specific. A tissue map is the same artifact with a different palette. |
| Inc 3b core+halo tiling, coverage bitmap, job queue | Region-or-whole-slide with accumulation, already solved and E2E-verified. |
| Markers panel + OSD layer manager | A 4th display mode costs a radio button and a legend, not a new viewer. |

The honest limit: **patch-grid output is 128 µm/cell.** Adequate for tumour/stroma/immune maps and
for any downstream ratio or spatial statistic. Not adequate for gland or vessel boundaries (T2).

---

## 4. The model / project landscape

### Route A — Patch classification over foundation-model features  *(recommended first)*

| Project | What it is | Notes |
|---|---|---|
| **UNI** (Mahmood Lab, Nat Med 2024) | ViT-L/16 pathology encoder; the reference linear-probe baseline | Strongest all-round frozen encoder in the public benchmarks |
| **CONCH** (Mahmood Lab, Nat Med 2024) | Vision–language; **zero-shot** patch classification from text prompts | **Already in our stack** — a zero-shot tissue map is achievable with no training run |
| **Virchow2 / H-optimus-0/1 / Prov-GigaPath / Phikon-v2 / Hibou / Midnight** | Alternative encoders | Swappable in Trident's encoder factory |
| **MUSK** | TissueLab's own choice for this exact slot | Confirms the pattern |
| **F-SEG** (`deepathology/fseg`, arXiv 2409.05697) | **Unsupervised** semantic segmentation by NMF-factorising FM features; *no training at all* | Best "what tissue classes does this slide even have" probe before committing to a label set |

Evidence on encoder choice: a 15-model frozen-encoder benchmark with a shared lightweight decoder
reports Virchow2 0.706 ± 0.10, H-optimus-0 0.702 ± 0.11, Prov-GigaPath 0.702 ± 0.10, UNI 0.70 ± 0.10
— **the top four are inside one standard deviation of each other.** Read that as: *encoder choice is
second-order; label quality and decoder/head are first-order.* Do not re-plumb the pipeline to chase
a 0.006 delta.

### Route B — Dense supervised tissue segmentation

| Project | What it is | Notes |
|---|---|---|
| **TIAToolbox `fcn_resnet50_unet-bcss`** | Ready-made 5-class breast tissue segmentor (BCSS), WSI-capable via `SemanticSegmentor` | **The fastest baseline that exists.** BSD-3 code, but **weights are CC-BY-NC 4.0** |
| **Frozen FM encoder + light decoder** | The benchmark's own recipe | Best accuracy/effort ratio if we train anything dense |
| **SegFormer / UNet / DeepLabv3+** | Conventional dense baselines | What most 2025–26 papers still compare against |
| **HoVer-NeXt** (MIDL 2024) | Fast nuclei seg+class: 1.8 s/mm² @0.5 mpp, 5× faster than CellViT, PanNuke 47.7 mPQ | Cell-level, but the relevant alternative if CellViT throughput ever bites |

### Route C — Weakly supervised (patch labels only, no pixel annotation)

Directly relevant because **we can generate patch labels cheaply and pixel labels not at all.**

| Project | Idea |
|---|---|
| **ConStruct** (arXiv 2512.10316) | **CONCH ViT-B/16** prototypes + SegFormer structural distillation + text-guided prototype init; frozen backbones + light adapters; BCSS-WSSS / LUAD-HistoSeg |
| **DualProtoSeg** (arXiv 2512.10314) | Text- *and* image-guided prototype learning, same benchmarks |
| Multi-layer pseudo-supervision (arXiv 2110.08048), superpixel boundary correction (arXiv 2501.03891), multi-scale voting + online noise suppression (EAAI 2025) | The established WSSS-for-histology line |

ConStruct is the single most on-stack paper in this document: it is *literally* built on CONCH
features, the encoder we already cache.

### Route D — Promptable / text-driven segmentation

| Project | Reality check |
|---|---|
| **BiomedParse** (Nat Methods 2025) | 82 object types × 9 modalities, text-prompt only, 24 pathology object types. Genuinely capable — but note TissueLab files it under **radiology** |
| **PathSegmentor / PathSeg** (arXiv 2506.20988) | First pathology-specific text-prompted segmentor; **160 categories**, 275 k image–mask–label triples from 21 sources; +0.145 Dice over spatial-prompted, +0.429 over text-prompted baselines. **Weight availability unconfirmed — verify before planning around it** |
| **Path-SAM2 / SAM2-PATH** (arXiv 2408.03651) | SAM2 + UNI encoder + KAN head for pathology semantic seg |
| **SAM3** (arXiv 2604.18225, *"Is SAM3 ready for pathology segmentation?"*) | **No.** Text-only prompts poorly activate nuclear concepts; highly sensitive to visual-prompt type/budget; few-shot helps but is not robust to prompt noise |

Promptable segmentation is the most *agent-friendly* route (a tool whose argument is a string is
trivially callable by the Copilot), and the least *reliable* one today. Good exploratory tool, bad
foundation for a quantitative artifact.

### Route E — Tissue detection & QC (T0)

| Project | Notes |
|---|---|
| **GrandQC** (Nat Commun 2024, `cpath-ukk/grandqc`) | Tissue Dice **0.957**; artifact-free tissue Dice 0.919–0.938; tissue seg ~**0.4 s/WSI**, artifact seg 27–45 s/WSI. QC masks for the whole TCGA cohort released. **Already wrapped in Trident** as `GrandQCSegmenter` / `GrandQCArtifactSegmenter` |
| **HistoQC** | The older, rule-based QC standard; useful as a cross-check |
| Trident `hest` (current), `otsu` | What we run today |

---

## 5. Datasets & benchmarks (what any T1 claim must be measured on)

| Dataset | Content | Use |
|---|---|---|
| **BCSS** | 151 breast ROIs, pixel labels: TUM / STR / LYM / NEC / OTR | The default dense tissue benchmark |
| **BCSS-WSSS**, **LUAD-HistoSeg** | Patch-label variants of the above | The WSSS benchmarks (Route C) |
| **NCT-CRC-HE-100K** (+ CRC-VAL-HE-7K) | 100 k 224² patches, **9 classes** (ADI/BACK/DEB/LYM/MUC/MUS/NORM/STR/TUM) | The canonical patch-level tissue-classification set — ideal for Route A |
| **SegPath** (Patterns 2023) | IF-restaining-derived masks for **8 cell/tissue types** — objective GT, no pathologist drawing | The best answer to "we have no pixel annotations" |
| **PAIP**, **DigestPath**, **CAMELYON16/17** | Tumour-region segmentation challenges | External validation |
| **PanNuke / Lizard / CoNIC** | Nuclei | Cell-level only; relevant to CellViT, not T1 |
| Melanoma nuclei+tissue set (GigaScience 2025) | Joint nuclei **and** tissue benchmarks | Rare combined benchmark |

---

## 6. Evidence quality — read before quoting any of this

- **Model rankings are soft.** The 15-encoder segmentation benchmark is an OpenReview entry; its PDF
  is behind a bot check and the numbers above come from search-level extraction, **not** from
  reading the paper. The top-4 spread is within one σ regardless, which is the load-bearing claim.
- **The 2026-07-14 review's finding still stands:** every head-to-head *"we beat X"* claim it tested
  adversarially was **refuted**. Treat all SOTA labels here as time-bounded and benchmark-specific.
  Pick by license, throughput, and fit to our artifact shape — then benchmark on our own slides.
- **PathSegmentor's weight release is unverified.** Do not plan an increment around it before
  checking.
- **Licenses split code from weights.** TIAToolbox code BSD-3 / **weights CC-BY-NC 4.0**;
  CellViT Apache-2.0 **+ Commons Clause** (resale-restricted); TissueLab **Penn Academic**
  (non-commercial, and cl.9 makes derivatives Penn-owned — the reason we never vendored it);
  CONCH/UNI/Trident non-commercial. Keep a `license` field per tool in the registry.

---

## 7. Recommendation for PathAssist

Three increments, cheapest first. Each is independently shippable.

**Inc 4a — QC upgrade (hours).**
Add `grandqc` + `grandqc_artifact` as selectable segmenters in the preprocess DAG (the Trident
factory already supports both; only the checkpoints need fetching). Surface an artifact-fraction
number per slide. This makes every downstream number defensible — right now a pen mark or a fold
silently enters the tile list.

**Inc 4b — Tissue map as a 5th DAG stage (days).**
`tissue` stage, `parent = feat_hash`, head over the cached CONCH/UNI patch vectors →
K tissue classes → paletted tile pyramid **reusing Inc 3b's `pyramid.py` verbatim** → a 4th viewer
mode. Label source, in ascending order of cost:
1. **Zero-shot CONCH text prompts** — no training, ships day one, honest about being zero-shot.
2. **F-SEG (NMF)** — unsupervised, tells us what classes the slide actually contains before we
   commit to a taxonomy.
3. **Supervised linear/MLP head** trained on NCT-CRC-HE-100K (9-class) or BCSS patches — the version
   that produces quotable numbers.
Ship (1) and (3) as *different declared label sources* on the same artifact, never blended.

**Inc 4c — Dense tissue segmentation (weeks, only if 4b proves insufficient).**
Frozen FM encoder + lightweight decoder, trained weakly (ConStruct-style, on CONCH features we
already have) or fully (BCSS/SegPath). Benchmark against TIAToolbox `fcn_resnet50_unet-bcss` as the
baseline before writing any of it.

**Explicitly not recommended now:** SAM3-based prompting (evidence says not ready); vendoring
TissueLab (unchanged); a new encoder to chase benchmark deltas inside one σ.

---

## 8. References

**TissueLab & agentic:**
- TissueLab — *A co-evolving agentic AI system for medical imaging analysis*, arXiv:2509.20279 ·
  `github.com/zhihuanglab/TissueLab` · Penn Academic License
- Pathology-CoT — *Learning visual chain-of-thought agents from expert WSI diagnosis behaviour*,
  Nature Biomedical Engineering 2026

**Encoders / patch classification:**
- UNI — *Towards a general-purpose foundation model for computational pathology*, Nature Medicine 2024
- CONCH — *A vision-language foundation model for computational pathology*, Nature Medicine 2024 ·
  `github.com/mahmoodlab/CONCH`
- Virchow — arXiv:2309.07778 · Virchow2 · H-optimus-0/1 (Bioptimus) · Prov-GigaPath
- *Benchmarking foundation models as feature extractors for weakly supervised computational
  pathology*, Nature Biomedical Engineering 2025
- *A Benchmark of Foundation Model Encoders for Histopathological Image Segmentation*,
  OpenReview `VwGnY3YuMP` (2025)
- *Evaluating Vision and Pathology Foundation Models for Computational Pathology*, medRxiv 2025

**Tissue segmentation:**
- GrandQC — Nature Communications 2024, `s41467-024-54769-y` · `github.com/cpath-ukk/grandqc`
- TIAToolbox `fcn_resnet50_unet-bcss` — Nature Comms Medicine 2022 ·
  `tia-toolbox.readthedocs.io` (semantic-segmentation notebook)
- F-SEG — *Segmentation by Factorization*, arXiv:2409.05697 · `github.com/deepathology/fseg`
- ConStruct — arXiv:2512.10316 · DualProtoSeg — arXiv:2512.10314
- BiomedParse — Nature Methods 2025, `s41592-024-02499-w` · `microsoft.github.io/BiomedParse`
- PathSegmentor / PathSeg — *Segment Anything in Pathology Images with Natural Language*,
  arXiv:2506.20988
- Path-SAM2 / SAM2-PATH — arXiv:2408.03651 · *Is SAM3 ready for pathology segmentation?* —
  arXiv:2604.18225
- HoVer-NeXt — MIDL 2024, `proceedings.mlr.press/v250/baumann24a.html`

**Datasets:**
- BCSS (breast, 5 classes) · BCSS-WSSS · LUAD-HistoSeg
- NCT-CRC-HE-100K / CRC-VAL-HE-7K (9 tissue classes)
- SegPath — *Restaining-based annotation for cancer histology segmentation*, Patterns 2023
- PAIP · DigestPath · CAMELYON16/17
- Melanoma nuclei + tissue benchmark — GigaScience 2025
