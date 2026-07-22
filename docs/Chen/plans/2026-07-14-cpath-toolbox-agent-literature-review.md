# Computational-Pathology Toolbox Agents — Literature Review

> **Date:** 2026-07-14
> **Author:** Chen (with Claude)
> **Purpose:** Reframe "PathAgent" from a single fixed diagnostic reasoning loop into a
> **tool-calling agent over a library of computational-pathology (CPath) primitives** — nuclei/cell
> segmentation, cell classification, morphometric/statistical feature analysis, spatial statistics,
> biomarker quantification (a TIAToolbox-style capability layer that the LLM invokes as tools).
> **Method:** deep-research fan-out (5 angles, 22 sources fetched, 25 claims adversarially verified,
> 22 confirmed) + targeted follow-up on the agentic sub-topic the verifier under-sampled.

---

## 0. The core reframing (read this first)

The current `services/pathagent` is a **navigation-and-reasoning agent**: a hardcoded LangGraph
(Router → Triage → Navigate ⇄ Describe → Diagnose → Verify → Summary) whose only real capability is
producing a *verified breast-cancer subtype* (IDC vs ILC). Its "tools" (`nodes.py:48`:
`["navigate", "classifier", "kb", "verify"]`) are **labels for fixed graph nodes, not callable
functions**. There is no nuclei segmentation, cell classification, morphometry, or spatial analysis
anywhere in the code.

The literature on "pathology agents" splits cleanly into **two archetypes**:

| | **Archetype A — Navigation / reasoning agent** | **Archetype B — Tool-orchestration agent** |
|---|---|---|
| **What it does** | Walks the slide, describes ROIs, reasons to a diagnosis/VQA answer | Plans a pipeline and **invokes analysis functions** (segment → classify → quantify → spatial-stats) |
| **Capability surface** | Foundation-model features + an MLLM | A **registry/library of CPath tools** |
| **Output** | Diagnosis / report / VQA answer | Quantitative measurements, maps, statistics, *and* a diagnosis |
| **Examples** | PathAgent (arXiv 2511.17052), SlideSeek/PathChat+, PathNavigate, WSI-Agents, PathFinder | **TissueLab**, **NOVA** |
| **Your repo** | ← **this is what you built** | ← **this is what you now want** |

**The pivot is real and well-precedented.** Two 2025 systems (TissueLab, NOVA) are almost exactly the
design you described, and the toolkit ecosystem to draw tools from is mature, open, and mostly
permissively licensed.

---

## 1. Prior art for Archetype B (the design you want)

### 1.1 TissueLab — the closest blueprint  ⭐
*"A co-evolving agentic AI system for medical imaging analysis"* — arXiv 2509.20279 ·
`github.com/zhihuanglab/TissueLab` · fully open source (installers + web portal).

This is the single most on-target precedent. Mechanism:

- **LLM as orchestrator, not perceiver.** ChatGPT-4o "plans workflows, generates code, and invokes
  function calls" but **never sees raw gigapixel pixels**.
- **Tool factory / dynamic registry.** Instead of a fixed toolbox, a candidate pool is selected per
  query: `M_cand = LLM(query, M_factory)` — the LLM looks up a *tool factory*, checks available data
  outputs, and assembles a workflow from domain-relevant expert models. Tools are **DAG task nodes**
  behind a **modular plugin architecture with standardized interfaces** (each node declares its I/O
  requirements).
- **Editable memory layer (HDF5).** All intermediate state (masks, embeddings, tables) is persisted
  to a shared local HDF5 store; tools pass *references*, not data. The LLM issues **semantic function
  calls to query the HDF5 structure** (dataset names + metadata), avoiding "token overload and
  attention dilution." Workflows stay "transparent, auditable, and adaptable."
- **Bundled tools:** StarDist (nucleus instance seg), NuClass (in-house zero-shot nuclei typing),
  MUSK + PLIP (patch embeddings), CellCharter (spatial-omics clustering), TotalSegmentator +
  BiomedParse (radiology).
- **Co-evolution / human-in-the-loop:** clinician annotations retrain lightweight heads (e.g.
  XGBoost) in minutes; a feedback-guided policy reranks candidate models on accept/reject. Reported
  colon tumor-cell ID from ~0 → 82.1% in 5 min → 94.9% in 30 min.

**Takeaway for us:** the *tool-factory + HDF5 memory-layer + semantic-function-call* pattern is
directly transplantable. It is the architectural answer to "how does an LLM drive CPath tools over a
gigapixel image without drowning in pixels."

### 1.2 NOVA — code-generating agent over 49 tools
*"NOVA: An Agentic Framework for Automated Histopathology Analysis and Discovery"* — arXiv 2511.11324.

- The LLM **generates and iteratively runs Python code** ("translates scientific queries into
  executable analysis pipelines"), and can **create new tools ad hoc**.
- **Integrates 49 domain-specific tools** built on open-source software (e.g. nuclei segmentation,
  whole-slide encoding).
- Benchmark: **SlideQuest** — 90 pathologist-verified questions spanning data processing, quantitative
  analysis, and hypothesis testing (emphasis on multi-step reasoning + coding, *not* diagnostic recall).

**Contrast with TissueLab:** NOVA is *code-generation* (maximally flexible, harder to sandbox/verify);
TissueLab is *structured function-calling over a plugin registry* (safer, more auditable). For a
clinical viewer, TissueLab's structured approach is the safer default; NOVA's code-gen is the
"discovery mode" ceiling (and matches the NOVA blueprint already noted in your v3 design doc §10).

### 1.3 Archetype-A systems (what you already have — for contrast)
- **PathAgent** (arXiv 2511.17052, training-free) — Navigator (CLIP RoI scoring) + Perceptor (VLM
  description) + Executor (LLM 5-step reason/zoom/conclude loop). **Only 3 functions, via NL prompts,
  no tool registry.** This is essentially your current repo's design, published. Evaluated on VQA
  (SlideBench-VQA, WSI-VQA, WSI-Bench, PathMMU, PathVQA).
- **SlideSeek + PathChat+** — PathChat+ is a pathology MLLM (1M+ instructions, 5.5M QA turns);
  SlideSeek is a supervisor-explorer multi-agent loop for open-ended differential diagnosis (DDxBench).
- **PathNavigate** (arXiv 2605.23559) — training-free, surprise-guided scan + shared slide memory for
  WSI-VQA.
- **WSI-Agents** (arXiv 2507.14680) — the multi-agent verification design your current PathAgent
  already borrows for its ICV/Fact/Consensus layer.
- Others in the same family: multi-agent diagnostic copilot (2506.20964), PathoSage (2606.07549),
  QCAgent report generation (2603.01647), PathMem (2603.09943).

**These do not give you nuclei counts, morphometry, or spatial statistics.** They answer questions;
they don't run analyses. That is exactly the gap you identified.

---

## 2. The CPath tool library (what the agent would invoke)

### 2.A End-to-end toolkits / frameworks (the backbone libraries)

| Toolkit | License (code) | What it exposes | Fit |
|---|---|---|---|
| **TIAToolbox** (Warwick TIA Centre) | **BSD-3** *(weights CC-BY-NC 4.0)* | Stain norm (Ruifrok/Macenko/Reinhard/Vahadane), `NucleusInstanceSegmentor` (HoVer-Net), `SemanticSegmentor` (tissue), `PatchPredictor`, `DeepFeatureExtractor`, graph-based WSI modeling, `WSIReader` | Strong permissive backbone of wrappable primitives |
| **HistomicsTK** (Kitware / DSA) | Apache-2.0 | Color deconvolution, nuclei segmentation, **rich feature module** (see §2.C) | ⭐ **Already in your stack** — HistomicsTK is part of Digital Slide Archive, which runs on **Girder**, the backend PathAssist already uses |
| **Histolytics** (Hautaniemi Lab, 2025) | Open (peer-reviewed, CSBJ) | **Panoptic seg** bundling Cellpose/StarDist/HoVer-Net/CellViT (weights on HF) + morphological profiling (20+ nuclear metrics) + **full spatial-ecology suite** (see §2.D) | ⭐ **Most H&E-native, all-in-one** match to your target primitive set |

> **Key integration insight:** HistomicsTK is not a new dependency — it is the analysis library of the
> **Digital Slide Archive / Girder** platform your viewer is built on (per `CLAUDE.md`: "on top of
> Girder 5 / Digital Slide Archive"). Its morphometric/statistical/graph primitives are the lowest-cost
> tools to wrap first.

### 2.B Task-specific segmentation & classification models (SOTA, wrappable)

All below are open and produce **structured JSON/GeoJSON** (natural tool wrappers). *Relative accuracy
rankings are NOT established here* — every head-to-head "we beat X" claim in the evidence set was
**refuted** on verification, so treat SOTA labels as time-bounded and benchmark-specific.

| Model | Task | License | Why it wraps cleanly |
|---|---|---|---|
| **CellViT / CellViT++** (TIO-IKIM) | Nuclei instance seg **+ cell classification** | Apache-2.0 **+ Commons Clause** (source-available, resale-restricted) | ViT+SAM, 1024² gigapixel inference, GeoJSON→QuPath. **CellViT++ decouples seg from classification** — retrain only a lightweight cell-type head; ships out-of-the-box modules + AutoML + web viewer |
| **InstanSeg** (QuPath team) | Cell/nucleus instance seg | Open (PyPI `instanseg-torch`) | Embedding-based; **fully TorchScript-serializable** (runs outside Python), QuPath extension, NVIDIA + Apple GPU — engineered for portability |
| **StarDist** | Instance seg **+ classification** (`n_classes` head) | Open | Two primitives in one lib; ranked **#1 on CoNIC-2022** seg+class leaderboard |
| **PathoSAM** (`computational-cell-analytics/patho-sam`) | Nucleus seg (automatic **+ interactive**) | Not confirmed (claim refuted) | SAM trained on 14 datasets; author-claimed SOTA (Feb-2025 snapshot); good for interactive/ROI use |
| **HoVer-Net**, **Cellpose** | Nuclei seg (baselines) | Open | Available *inside* TIAToolbox / Histolytics — wrap the toolkit, get these for free |

### 2.C Morphometric / statistical feature extraction

**HistomicsTK `features` module** (already in your Girder stack) — the concrete per-object primitives:
- `compute_morphometry_features` — area, perimeter, eccentricity, solidity, circularity, fractal
  dimension, Hu moments
- `compute_intensity_features` — min/max/mean/median/std/skew/kurtosis, histogram energy/entropy
- `compute_haralick_features` — 26 GLCM texture descriptors (contrast, correlation, ASM, IDM, entropy)
- `compute_gradient_features` — gradient magnitude stats + Canny edge stats
- `compute_fsd_features` — Fourier shape descriptors
- `compute_global_cell_graph_features` — Voronoi / Delaunay / MST density + neighbor statistics
- `compute_nuclei_features` — the aggregate profile (feeds cell classification)

Each is a **one-function-per-tool** primitive. (Radiomics-style texture is also coverable by PyRadiomics
if wanted, but HistomicsTK already spans the pathology cases.)

### 2.D Spatial analysis / spatial statistics / TME

| Tool | Language / license | Input | Named primitives (each ≈ one tool) |
|---|---|---|---|
| **Histolytics** | Python, open | H&E masks (its own seg) | Delaunay / KNN / Distband **cell graphs**; **Ripley's K/L/G**; **global + local Moran's I**; **DBSCAN** for lymphoid aggregates / **TLS**; **diversity indices** (Simpson, Shannon, Gini, Theil) |
| **SpatialQPFs** | **R**, open (Genentech) | **Tabular cell centroids + types** (downstream of seg) | Ripley's K/G, Clark-Evans; pair/mark correlation; global/local Moran's I, Geary's C, Getis-Ord, Lee's L; colocalization (Morisita-Horn/Sørensen/Jaccard); variograms |
| **Squidpy** (scverse) | Python, BSD-3 | **Spatial-omics** (Visium/Xenium/Slide-seq), *not H&E* | `spatial_neighbors`, `nhood_enrichment`, `co_occurrence`, `spatial_autocorr` (Moran's I) |
| **Topological Tumor Graphs** | method (Cancer Res 2020) | Cell detections | Proximity-threshold cell graph (<35 µm) for TME modeling |
| **SASHIMI** | R + Python, browser, open | AI-segmented images | Extraction/visualization/computation of spatial metrics over segmented WSIs |

**Clean pipeline decomposition** (validated by SpatialQPFs' + Histolytics' explicit design):
`segment → classify (centroids + cell types) → spatial-statistics`. The spatial layer consumes the
*output of the segmentation layer*, which is precisely how you'd chain tools in the agent.

> **Modality caveat:** Squidpy is a **molecular** (spatial-transcriptomics) branch — it belongs to a
> future multimodal path, not the H&E image branch. For H&E, **Histolytics (Python) is the primary**;
> SpatialQPFs adds breadth at the cost of R interop.

---

## 3. Licensing landscape (matters before any product use)

- **Permissive / safe to wrap & redistribute:** TIAToolbox *code* (BSD-3), HistomicsTK (Apache-2.0),
  Squidpy (BSD-3), Histolytics + SpatialQPFs (open repos), InstanSeg, StarDist.
- **Watch-outs:**
  - **TIAToolbox pretrained weights = CC-BY-NC 4.0** (non-commercial) even though code is BSD-3.
  - **CellViT = Apache-2.0 + Commons Clause** → source-available, **resale-restricted** (internal
    tool-wrapping fine; can't sell it).
  - **PathoSAM license unconfirmed** (the licensing claim was refuted in verification — verify before use).
  - This mirrors the non-commercial constraints already flagged in your v3 doc for Trident/CONCH/TITAN.
- **Rule of thumb:** verify *weight* licenses separately from *code* licenses; keep a per-tool license
  field in the tool registry.

---

## 4. Coverage gaps & caveats (be honest about these)

- **Agentic sub-topic under-verified by the harness.** The automated verifier confirmed the *toolkit*
  half strongly (8 findings, all 3-0) but produced **zero confirmed claims** for the agentic half —
  it simply didn't sample those claims (budget: 25 of 107). The TissueLab/NOVA/PathAgent
  characterizations in §1 come from **single-source targeted fetches** (their papers), not the
  adversarial pass — treat them as well-sourced but not triple-verified.
- **Tasks not covered by confirmed evidence:** tissue/tumor-segmentation SOTA specifics, **mitosis
  detection**, **gland segmentation**, **TILs quantification** models, and **WSI-level MIL feature
  aggregation** (beyond TIAToolbox's brief graph mention). These are known, active areas — they exist,
  they're just outside this evidence set. (Your existing Trident/ABMIL stack already covers the MIL
  aggregation slot.)
- **No accuracy rankings.** All "outperforms X" claims (InstanSeg > StarDist/Cellpose/HoVer-Net; a
  kidney-FM comparison) were **refuted (1-2)**. Only capability/existence survived. Don't pick a
  segmenter on these papers' self-reported superiority — benchmark on your own data (PanNuke / Lizard
  / CoNIC).

---

## 5. How this maps onto a PathAgent redesign

**Keep** LangGraph, the Gateway, the Girder/Trident feature cache, the SSE streaming, and the
WSI-Agents verification layer. **Change** the middle: replace the fixed
Navigate→Describe→Diagnose chain with a **planner over a tool registry**.

1. **Tool registry (new).** A real registry (`@register_tool`) — distinct from the current
   `common/registry.py`, which is only a Redis *job-status* store. Each tool = `{name, description,
   JSON-schema args, output-schema, license, backend}`. Seed it by wrapping:
   - *Segmentation/classification:* `NucleusInstanceSegmentor` (TIAToolbox/HoVer-Net) or CellViT++;
     StarDist for joint seg+class.
   - *Morphometry/stats:* HistomicsTK `compute_*_features` (lowest cost — **already in the Girder/DSA
     stack**).
   - *Spatial:* Histolytics primitives (Ripley's K, Moran's I, DBSCAN-TLS, diversity indices).
   - *Existing:* the CONCH concept-similarity map and BRCA ABMIL classifier become *two tools among
     many*, not the whole pipeline.
2. **Planner node replaces `router`.** An LLM planner selects + orders tools (à la TissueLab's
   `M_cand = LLM(query, M_factory)`); the LangGraph cycle executes the plan and can re-plan.
3. **Editable memory layer (adopt from TissueLab).** Persist masks / feature tables / stats to the
   feature cache (HDF5/parquet keyed by `itemId`); tools pass **references**, the LLM queries
   **metadata** — never raw pixels or million-row tables in the prompt.
4. **Verification still applies** — but now it can check *quantitative* claims ("mitotic count = 14/10
   HPF") against the tool outputs, a stronger faithfulness signal than text-only ICV.
5. **Output geometry unchanged** — nuclei polygons / heatmaps / graphs are GeoJSON → the existing
   HistomicsUI annotation layer + OSD overlays (your v3 §8 coordinate contract already handles this).

**Fastest first slice:** wrap **HistomicsTK nuclei-seg + `compute_nuclei_features`** (in-stack, Apache-2.0)
and **one Histolytics spatial stat** (e.g. Moran's I / Ripley's K) as three registry tools, add a
planner node, and demo "count and characterize nuclei in this ROI, then test for spatial clustering" —
end-to-end tool-calling on a real slide. That single vertical proves the archetype-B pivot.

---

## 6. References

**Agentic pathology (Archetype B — target design):**
- TissueLab — *A co-evolving agentic AI system for medical imaging analysis*, arXiv 2509.20279 · `github.com/zhihuanglab/TissueLab`
- NOVA — *An Agentic Framework for Automated Histopathology Analysis and Discovery*, arXiv 2511.11324
- (contrast) PathAgent — *Interpretable Analysis of WSI via LLM Agentic Reasoning*, arXiv 2511.17052
- (contrast) SlideSeek / PathChat+; PathNavigate arXiv 2605.23559; multi-agent copilot arXiv 2506.20964; WSI-Agents arXiv 2507.14680

**Toolkits:**
- TIAToolbox — Nature Comms Medicine s43856-022-00186-5 · `github.com/TissueImageAnalytics/tiatoolbox`
- HistomicsTK — `digitalslidearchive.github.io/HistomicsTK` (Kitware / Digital Slide Archive)
- Histolytics — CSBJ 2025, PMC12664990 · `github.com/HautaniemiLab/histolytics`

**Segmentation / classification models:**
- CellViT — Med. Image Analysis 2024, S1361841524000689 · CellViT++ arXiv 2501.05269 · `github.com/TIO-IKIM/CellViT{,-plus-plus}`
- InstanSeg — arXiv 2408.15954 · `github.com/instanseg/instanseg` · `github.com/qupath/qupath-extension-instanseg`
- StarDist (histopathology) — IEEE ISBI 2022, arXiv 2203.02284 · CoNIC organizers Graham et al., Med. Image Analysis 2024
- PathoSAM — *Segment Anything for Histopathology*, arXiv 2502.00408 · `github.com/computational-cell-analytics/patho-sam`

**Spatial statistics:**
- Squidpy — Nature Methods 2021, s41592-021-01358-2 · `github.com/scverse/squidpy`
- SpatialQPFs — Scientific Reports 2024, PMC11605059 · `github.com/Genentech/SpatialQPFs`
- Topological Tumor Graphs — Cancer Research 2020, 80(5):1199 · SASHIMI — arXiv 2512.06116
