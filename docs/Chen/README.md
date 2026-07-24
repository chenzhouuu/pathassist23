# PathAgent v2 — Design Docs Index

> Chen's working docs for the PathAssist copilot (PathAgent v2). Split into two buckets so the
> as-built system is easy to separate from proposals. **Last organized:** 2026-07-22.

**Organizing principle**

- **`current-implementation/`** — read these to understand the system **as it exists today** (shipped
  code on `feature/copilot-agent`). "Plan" docs whose work has fully landed live here.
- **`plans/`** — proposals, designs, and superseded/historical direction: work **not yet built**, plus
  reviews and background that inform it.

---

## 1. Current Implementation (shipped / as-built)

| Doc | What it is | State |
|---|---|---|
| `project-overview-and-competitors.md` | The PathAssist / Impart DX platform as-is + competitive landscape | current overview |
| `2026-07-16-…-conversational-copilot-architecture.md` | Canonical copilot architecture (vision, perception, memory, trust). **Execution model** later superseded by the orchestrator RFC below | architecture of record |
| `2026-07-20-…-orchestrator-agent-sdk-rfc.md` | The Claude-Agent-SDK loop architecture (no gate; two-class tools D3; handles D4; typed events D5). **This is the shipped design** — R7–R11 built to it | ✅ shipped (R7–R11) |
| `2026-07-21-…-cellvit-r11-plan.md` | R11: real CellViT-SAM-H segmentation, task-by-task | ✅ shipped |
| `2026-07-21-…-cellvit-r11-deployment-design.md` | R11 GPU service deployment (Flask service, compose wiring) | ✅ shipped |
| `2026-07-21-…-cellvit-gpu-followup-plan.md` | Post-R11 GPU hardening (real mpp, warm-up, 20x OOM/rescale, sub-patch padding) + spike verdict | ✅ shipped |
| `2026-07-21-…-dsa-annotation-persistence-plan.md` | `GirderAnnotationStore` — nuclei persist as DSA annotations, survive reload | ✅ shipped (commits `e70378e`→`8486469`) |

**Snapshot of what runs today:** a headless Claude-Agent-SDK loop in the FastAPI gateway drives a
two-class tool registry; **CellViT-SAM-H** segments a drawn ROI (real mpp, warm-up, ROI cap), returns a
count + level-0 centroids; the overlay renders cyan dots that track pan/zoom; results persist as durable
DSA `point` annotations that survive reload. Tokens ride server-side only (D3); bulk geometry is a handle
fetched out-of-band (D4).

## 2. Plans (not yet built / historical / background)

### Active — the next step
| Doc | What it is | State |
|---|---|---|
| `2026-07-22-…-inc2-wsi-reasoning-tools-design.md` | **Increment 2** design: harvest PathAgent (arXiv 2511.17052) — PLIP `find_regions` (Navigator) + MedGemma `describe_region` (Perceptor) as **shared tools**, Claude as Executor; magnification first-class; whole-slide PLIP index | 🟢 reviewed + amended (F1 resolved, F2–F6 folded) |
| `2026-07-22-…-inc2-wsi-reasoning-tools-design-review.md` | Adversarial, code-grounded review of the Inc 2 design (0 blocking + 5 should-fix + 1 open; F1 resolved by an in-repo magnification-read pattern) | ✅ review complete |
| `2026-07-22-…-inc2a-describe-region-plan.md` | **Inc 2a** `describe_region` TDD plan — 10 tasks (pathvlm service ×6, agent ×3, infra ×1), stub-first (à la CellViT R8→R11) | ✅ implemented locally; real MedGemma **deployed + GPU-smoke-verified** |
| **Inc 2c frontend** (RegionOverlay) | describe_region echoes an inline region artifact; `RegionOverlay.jsx` draws the "MedGemma N×" rectangle (tracks pan/zoom), trace chip, store `copilotRegions` | ✅ built + browser-E2E-validated locally (uncommitted; `ViewerPanel` mount rides atop dashboard WIP) |

### Increment 1 — cell classification + typed counts (shipped)
| Doc | What it is | State |
|---|---|---|
| `2026-07-22-…-cell-classification-typed-counts-design.md` | Increment 1 design: surface CellViT's per-nucleus PanNuke class → typed counts + colour-by-class overlay. Amended per review (name-first classes, `type_prob` dropped, per-element `lineColor`) | ✅ shipped |
| `2026-07-22-…-cell-classification-design-review.md` | Adversarial, code-grounded review of the Increment 1 design (1 blocking + 4 should-fix findings, all folded into the design) | ✅ review complete |
| `2026-07-22-…-cell-classification-typed-counts-plan.md` | Increment 1 implementation plan — 10 task-by-task TDD tasks (CellViT ×3, agent ×4, frontend ×2, system prompt ×1) | ✅ shipped |

### Increment 3 — virtual biomarkers & cell-level phenotyping (design)
| Doc | What it is | State |
|---|---|---|
| `2026-07-24-…-inc3a-cell-biomarker-phenotype-design.md` | **Inc 3a** design: fuse GigaTIME-Flash virtual mIF × CellViT nuclei → per-cell biomarker phenotype (new `biomarker` service :8022, `phenotype_cells` tool, phenotype-coloured overlay). Tier-2 of a two-tier virtual-proteomics stack (Tier-1 HEX/MICA deferred → Inc 3c). 9 grilling-confirmed decisions; review folded | 🟡 design, review-folded 2026-07-24; no code yet |
| `2026-07-24-…-inc3a-cell-biomarker-phenotype-design-review.md` | Adversarial, code-grounded review (1 blocking + 6 should-fix + 3 open). Blocking: GigaTIME outputs a marker-**presence probability** (sigmoid), not intensity. Should-fix: magnification pinning, windowed raster, checkpoint key-remap fidelity, centroid↔mIF alignment, null-bbox clean-fail, adaptive-threshold degeneracy guard | ✅ review complete, folded |
| `2026-07-24-…-inc3a-cell-biomarker-phenotype-plan.md` | **Inc 3a** task-by-task TDD plan — 15 tasks (biomarker service ×8, agent ×3, frontend ×2, infra ×1, verify ×1); real-weights-first, all review findings folded per-task. T8/T15 blocked on the gated Flash download | ✅ implemented locally + E2E-verified (dev stub); T8 real weights + GPU smoke pending |

### Superseded / historical
| Doc | What it is | Superseded by |
|---|---|---|
| `2026-07-06-wsi-agents-integration-plan.md` | Earliest WSI-agents integration plan | the copilot architecture line |
| `2026-07-15-…-tissuelab-pattern-plan.md` | TissueLab pattern port plan (still valid for repo mechanics / removal blast-radius) | `2026-07-16-…-architecture.md` |
| `2026-07-16-…-incremental-framework-rfc.md` | Incremental framework RFC (horizontal tracks) | the build ladder, then the orchestrator RFC |
| `2026-07-16-…-conversational-copilot-architecture-review.md` | Long-form review of the copilot architecture | — (historical review) |
| `2026-07-17-…-incremental-build-ladder.md` | Stub-first R0–R8 build ladder | execution model re-slotted by the orchestrator RFC (R7–R11) |

### Background / reference
| Doc | What it is |
|---|---|
| `2026-07-14-…-cpath-toolbox-agent-literature-review.md` | CPath toolbox-agent literature review (TissueLab / NOVA / SPARK; HistomicsTK / Histolytics tools) |

### Other track (not the copilot)
| Doc | What it is |
|---|---|
| `dashboard-redesign-demo.html` | Dashboard redesign demo — a separate frontend track (matches the uncommitted `src/components/dashboard/*` WIP), not the copilot |

---

**Where we are / next step:** the copilot's real-CellViT + persistence spine and **Increment 1**
(cell classification + typed counts) are shipped. The active front is **Increment 2** — WSI reasoning
tools harvested from PathAgent (PLIP Navigator + MedGemma Perceptor as shared tools, Claude as
Executor). Route A (dissolve, not black-box) + a whole-slide PLIP index are locked; the design is
reviewed and amended (F1 resolved via an in-repo magnification-read pattern, F2–F6 folded). **Inc 2a
`describe_region` is shipped locally with real MedGemma deployed + GPU-smoke-verified, and Inc 2c's
`RegionOverlay` (the "MedGemma N×" rectangle on the slide) is built and browser-E2E-validated** (all
local, uncommitted). Next is **Inc 2b** — the Navigator / whole-slide PLIP index — gated on the R12
async task surface.
