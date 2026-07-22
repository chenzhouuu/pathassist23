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
| `2026-07-22-…-cell-classification-typed-counts-design.md` | **Increment 1** design: surface CellViT's per-nucleus PanNuke class → typed counts + colour-by-class overlay. **Amended per review** (name-first classes, `type_prob` dropped, per-element `lineColor`) | 🟢 design final |
| `2026-07-22-…-cell-classification-design-review.md` | Adversarial, code-grounded review of the Increment 1 design (1 blocking + 4 should-fix findings, all folded into the design) | ✅ review complete |
| `2026-07-22-…-cell-classification-typed-counts-plan.md` | **Increment 1 implementation plan** — 10 task-by-task TDD tasks (CellViT ×3, agent ×4, frontend ×2, system prompt ×1) | 🔵 ready to execute |

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

**Where we are / next step:** the copilot's real-CellViT + persistence spine is shipped
(current-implementation). The active front is **Increment 1** — cell classification + typed counts —
whose design is reviewed and amended and is ready to turn into a task-by-task TDD implementation plan.
