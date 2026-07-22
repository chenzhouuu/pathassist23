# PathAgent v2 — TissueLab-Pattern Toolbox Agent · Implementation Plan

> **Status:** Draft plan — awaiting sign-off. No code written yet.
> **Date:** 2026-07-15
> **Author:** Chen (with Claude)
> **Supersedes:** `2026-07-06-wsi-agents-integration-plan.md` (v3) and all M0–M4 PathAgent reports.
> **Context:** `2026-07-14-cpath-toolbox-agent-literature-review.md`

---

## 0. Decisions locked with Chen (2026-07-15)

| # | Decision | Choice |
|---|---|---|
| 1 | How to take TissueLab | **Port the pattern, own the code.** No Penn code in-tree. |
| 2 | First tools | **CellViT++** (nuclei seg + cell classification) → **Histolytics** (spatial stats) |
| 3 | CodingAgent | **Keep code-gen, but sandboxed** |
| 4 | Commercial intent | **Undecided** → default to the license-safe path (consistent with #1) |

---

## 1. Why we are not vendoring TissueLab (evidence)

Verified directly against the clone at `github/TissueLab` (commit `0ee1ed0`), not from the paper.

| Finding | Evidence |
|---|---|
| **No Linux model bundles exist.** Catalog is public (HTTP 200) and lists **8 bundles / 4 models**, `darwin-arm64` + `win-x86_64` only. `bundles_service.py` filters `platform × arch` → on Linux resolves to `[]`. | `https://storage.googleapis.com/tissuelab-2025.firebasestorage.app/bundles/catalog.json` |
| **Models are not in the repo.** Weights ship as opaque 1.5–4.3 GB prebuilt binaries from GCS. `storage/nodes/` absent; no `credentials/`. Registry advertises **14 nodes; only 4 have any bundle.** InstanSeg, CellCharter, VISTA, BiomedParse, TotalSegmentator, Ark, CardiacMR have none. | `bundles_service.py:50-131`, `storage/model_registry_preset.json` |
| **No auth whatsoever.** `core/auth.py` returns a hardcoded `AuthUser(uid="local")`; auth middleware is a 12-line pass-through. `/api/**` fully unauthenticated, mitigated only by `host="127.0.0.1"`. | `app/core/auth.py`, `app/middlewares/auth_middleware.py`, `main.py:227-233` |
| **Unsandboxed RCE.** Every workflow ends in a CodingAgent step that `exec()`s LLM-written Python in-process with full privileges. CORS is `allow_origins=["*"]`. | `app/api/tasks.py:351-357`, `main.py:166-173` |
| **Single-user by construction.** Slide state is a module-global `sessions` dict keyed by an `X-Instance-ID` header. | `app/services/load_service.py:58-85` |
| **Celery/Redis/ZMQ are dead code.** Nothing imports celery, zmq, or redis; `redis` isn't even a declared dep. Reality: thread pools + in-memory dicts. Task state dies on restart; cannot scale past `workers=1`. | `app/config/celery_config.py`, `app/services/redis_task_storage.py` (zero importers) |
| **`services/factory/` is dead code.** Not imported anywhere; copy-paste stubs that aren't instantiable (`get_model()` unimplemented → `TypeError`). **This is not the tool factory the paper describes.** | `app/services/factory/*` |
| **No agentic loop.** `WorkflowAgent` = stateless single-shot LLM calls. Plans once → human clicks Run → separate scheduler runs a **linear chain**. The agent never observes whether the plan succeeded. | `app/services/agent/workflow_agent.py` |
| **Tools are prose in a prompt.** "Tool calling" = emitting a node-name string into a JSON field. I/O types are English (`"WSI path, pixel_size"`). `schema: null` on all 14 nodes. Nothing prevents a hallucinated impl. | `workflow_agent.py:358-384`, `model_registry_preset.json` |
| **License.** Penn Academic: cl.4 non-commercial + no distribution; **cl.9 — programs created based on the Software are derivatives owned by PENN**; cl.8 title stays with Penn. | `LICENSE` |

**Conclusion.** Vendoring buys a tool-less orchestrator that we would rewrite anyway (Linux nodes, auth, multi-user, sandbox), while inheriting a Penn-owned derivative. The *ideas* are the asset; the code is not.

## 2. What we ARE taking (the pattern)

From the backend:
1. **Registry-as-data** → rendered into the planner's prompt as a capability catalog.
2. **Node-as-HTTP-service** with the `/init` → `/read` → `/execute` lifecycle. Genuinely good isolation: each tool owns its own heavy env; the orchestrator stays dependency-light.
3. **Zarr as the shared memory layer** — nodes exchange **references** (`zarr_path`, `zarr_group`), never arrays. Params handed over via `{group}/userData`.
4. **Plan → human confirms → execute.** The human gate is a feature for clinical trust, not a limitation.
5. **👍/👎 → re-rank implementation candidates** in the next plan.
6. **Active learning via Zarr**: low-confidence candidates → relabel → commit ground truth → node retrains → overlay recolors.

From the frontend (patterns, re-implemented in our Vite/Zustand idiom):
7. **Plan-as-artifact** — structured plan card with *Apply* hand-off; only the newest is live (older → `Expired`).
8. **Sub-stage nodes** — `preProcessed` (compute once/slide) / `rerunnable` / `autoRunNext`. Makes HITL cheap.
9. **Ephemeral trace, durable answer** — live tool checklist → collapses to a `Tools (n)` footer.
10. **Progressive disclosure** — tool → args → result preview, one `expandedIdx` per list.
11. **Uniform status grammar** — `pending | active | done | error` everywhere.
12. **Uncertainty-first review + `Y`/`N` keyboard labeling.**
13. **WebGL2 overlay**: `mat3` viewport uniform + flat `Int32Array` + subarray views; viewport-scoped streaming with hash debounce + request versioning.
14. **Keep the agent panel mounted** so closing the rail never kills a run.

## 3. What we deliberately IMPROVE (the "dramatically changed" part)

| TissueLab | PathAgent v2 |
|---|---|
| I/O declared in English prose; `schema: null` | **JSON Schema per tool** → static graph validation before run |
| Tool "call" = emit a name string; hallucination possible | **Real function-calling / enum-constrained** tool names |
| One-shot planner, never sees results | **Closed loop**: observe outputs → re-plan (still human-gated) |
| `exec()` in-process, full privileges | **Sandboxed**: subprocess, no network, read-only Zarr, CPU/mem/wall caps |
| No auth; single-user global dict | **Girder-token auth; per-user/per-case isolation** |
| Celery/Redis declared but dead | **Actually use** the existing Redis + RQ we already run |
| `CUDA_VISIBLE_DEVICES=0` hardcoded | Configurable device / queue |
| Mac + Windows only | **Linux-native, GPU** |

## 4. Target architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│ PathAssist — React 18 + Vite + Zustand + TanStack Query      [EXISTING]    │
│  OpenSeadragon viewer · Girder auth · annotation layer                     │
│  ┌────────────────── RIGHT PANEL: NEW TAB "Agent" ──────────────────────┐  │
│  │ composer · plan card (Apply) · run trace · workflow view             │  │
│  │ review/active-learning · WebGL nuclei overlay · results              │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬────────────────────────────────────────────┘
                    /api/agent │ (nginx + vite proxy)  ·  Girder-Token
┌──────────────────────────────▼────────────────────────────────────────────┐
│ Agent Gateway (FastAPI)   services/agent/                    [NEW, OURS]  │
│  auth(Girder) · registry(tools.json) · planner(LLM) · validator(schema)   │
│  scheduler(DAG, RQ+Redis) · memory(Zarr refs) · sandbox(code-gen)         │
│  feedback(👍/👎 re-rank) · SSE stream                                      │
└───┬────────────────────────────────────────┬──────────────────────────────┘
    │ /init → /read → /execute (HTTP)        │ refs only
    ▼                                        ▼
┌──────────────────────┐             ┌──────────────────────────┐
│ Tool nodes (ours)    │             │ Zarr store (per case)    │
│  cellvit++  (GPU)    │◄───────────►│  /CellViT/{contours,     │
│  histolytics (CPU)   │   read/write│    centroids,classes,emb}│
│  (each: own venv,    │             │  /Spatial/{ripley,moran} │
│   own port, FastAPI) │             │  /user_annotation/...    │
└──────────┬───────────┘             └──────────────────────────┘
           │ slide pixels
           ▼
┌───────────────────────────────────────────────────────────────┐
│ Girder 5 / DSA  — slides, tiles, annotations   [EXISTING, SoT] │
└───────────────────────────────────────────────────────────────┘
```

**Girder stays the source of truth** for slides/tiles/annotations. Zarr holds **derived** data only (nuclei, features, stats). We do **not** port TissueLab's tile server — the viewer keeps using Girder tiles.

## 5. Repo layout

```
services/agent/                       ← NEW (replaces services/pathagent/)
  pyproject.toml
  src/pathagent/
    gateway/      app.py routes.py auth.py deps.py sse.py
    registry/     tools.json  registry.py  schemas.py
    planner/      planner.py  prompts/*.txt  validate.py
    scheduler/    dag.py  runner.py  state.py
    memory/       zarr_store.py  refs.py
    sandbox/      runner.py  policy.py
    feedback/     store.py  rank.py
    nodes/        client.py            ← /init /read /execute client
  nodes/                               ← each tool = its own service + env
    cellvit/      app.py  requirements.txt  Dockerfile
    histolytics/  app.py  requirements.txt  Dockerfile
  tests/
src/
  api/agentApi.js                      ← NEW (replaces wsiAgentApi.js)
  components/panels/agent/             ← NEW
    AgentPanel.jsx  Composer.jsx  PlanCard.jsx  RunTrace.jsx
    WorkflowList.jsx  ResultCard.jsx  ReviewPanel.jsx
  components/viewer/overlays/NucleiOverlay.jsx   ← WebGL2
  store/agentSlice.js                  ← NEW Zustand slice
```

## 6. Contracts

### 6.1 Tool registry entry (`registry/tools.json`)

Improves on TissueLab: real schemas, explicit deps, license field.

```json
{
  "name": "cellvit_segment_classify",
  "category": "NucleiSegClassify",
  "displayName": "Nuclei Segmentation + Classification (CellViT++)",
  "description": "Segments nuclei and assigns cell types on H&E.",
  "endpoint": "http://cellvit:8101",
  "license": "Apache-2.0 + Commons Clause",
  "device": "gpu",
  "consumes": {"type":"object","properties":{
      "slide_ref":{"$ref":"#/defs/GirderItem"},
      "roi":{"$ref":"#/defs/RectPx0"},
      "mpp":{"type":"number"}},
      "required":["slide_ref"]},
  "produces": {"zarr_group":"CellViT",
      "datasets":["contours","centroids","class_id","class_prob","embedding"]},
  "substages":[
    {"key":"segment","label":"Segmentation","preProcessed":true},
    {"key":"embed","label":"Embedding","preProcessed":true},
    {"key":"classify","label":"Classification","rerunnable":true}
  ]
}
```

### 6.2 Node lifecycle (ours, TissueLab-shaped)

```
POST /init     {config}                    → {ok, model_version}
POST /read     {zarr_path, zarr_group,     → {ok, inputs_resolved}
                dependencies, params}
POST /execute  {}                          → SSE progress → {ok, outputs:{zarr_group,...}}
GET  /health                               → {ok}
GET  /schema                               → the tool's JSON Schema (self-describing)
```
Arrays never cross the wire — only refs. `/execute` is **not** retried (long-running; retry duplicates work).

### 6.3 Plan (planner output, schema-validated)

```json
{"steps":[{"step":1,"tool":"cellvit_segment_classify",
           "args":{"slide_ref":{"itemId":"..."},"mpp":0.25},
           "candidates":["cellvit_segment_classify","stardist_segment"]},
          {"step":2,"tool":"histolytics_spatial",
           "args":{"stats":["ripley_k","morans_i"],"classes":["tumor","lymphocyte"]}},
          {"step":3,"tool":"code_analysis","args":{"question":"..."}}],
 "reason":"..."}
```
`tool` is **enum-constrained to the registry** (not free string). Validation: schema → registry membership → dependency satisfaction (produces ⊇ consumes) — **before** the human ever sees it.

### 6.4 SSE event vocabulary (frontend contract)

```
{type:"route",     mode:"chat|code|workflow"}
{type:"plan",      steps:[...], reason}          → renders the Plan Card
{type:"run_start", runId}
{type:"tool_call", step, tool, args, status:"running"}
{type:"tool_result",step, status:"done|error", preview}
{type:"substage",  step, key, progress}          → sub-stage progress bars
{type:"chunk",     content}                      → streaming prose
{type:"final",     answer, artifacts:[...]}
{type:"error",     message}
```

## 7. Milestones

### M0 — Removal + scaffolding
- Delete `services/pathagent/`, `src/api/wsiAgentApi.js`, `src/components/panels/PathAgentPanel.jsx`, `src/components/panels/agentViewerSync.js`.
- Strip the agent slice from `src/store/index.js` (`:95-96`, `:237-259`); unregister the tab in `RightPanel.jsx`; remove the rail icon in `ViewerApp.jsx`.
- Scaffold `services/agent/` (FastAPI + Girder auth passthrough + `/health`), route `/api/agent` in `vite.config.js` **before** the catch-all `/api` → Girder proxy (ordering matters: TissueLab-style paths would otherwise be swallowed by Girder).
- **Done when:** viewer builds clean with no agent code; `/api/agent/health` returns 200 behind a Girder token.

### M1 — Registry + node contract + first node (CellViT++)
- `registry/tools.json` + loader + JSON-Schema validation + `/api/agent/tools`.
- `nodes/cellvit/`: FastAPI service, own venv, GPU, implements `/init /read /execute /health /schema`. Reads slide pixels via Girder; writes nuclei to Zarr `/CellViT/*`.
- `memory/zarr_store.py`: per-case path derivation, refs, `{group}/userData` params, process-safe synchronizer.
- **Done when:** `POST /api/agent/tools/cellvit_segment_classify/run` on a real DSA slide writes contours/centroids/classes to Zarr, streaming sub-stage progress.

### M2 — Planner + validation + DAG scheduler
- `planner/`: catalog rendering from the registry, enum-constrained tool names, schema-strict output.
- `validate.py`: static graph check (produces ⊇ consumes) before human review.
- `scheduler/`: DAG over RQ+Redis (real this time), per-user/per-case run state, SSE.
- **Done when:** a question yields a validated plan; on approval it executes end-to-end with live events.

### M3 — Agent UI (the redesign)
- `agentSlice.js` (Zustand), `agentApi.js` (SSE via `fetch` reader — `EventSource` can't send the Girder token header).
- `AgentPanel` = Composer · PlanCard (Apply; older → `Expired`) · RunTrace (ephemeral checklist → `Tools (n)` footer) · WorkflowList (sortable cards) · ResultCard.
- Keep panel mounted across rail toggles. Uniform status grammar.
- **Done when:** a pathologist asks a question, sees the plan, edits/approves it, and watches it run.

### M4 — Second node (Histolytics) + sandboxed code-gen
- `nodes/histolytics/`: Ripley's K/L/G, Moran's I (global/local), DBSCAN/TLS, diversity indices — consuming CellViT centroids+classes from Zarr.
- `sandbox/`: subprocess, **no network**, read-only Zarr mount, CPU/mem/wall caps, artifacts to an export dir; returns a small JSON dict (no arrays/bytes).
- **Done when:** "count tumour cells and test for spatial clustering" runs `cellvit → histolytics → code_analysis` and returns a cited number + plot.

### M5 — Overlays + active learning
- `NucleiOverlay.jsx`: WebGL2, `mat3` viewport uniform, flat `Int32Array`, viewport-scoped streaming w/ hash debounce + request versioning.
- `ReviewPanel`: uncertainty-first candidates, `Y`/`N` labeling, threshold histogram, batch commit → Zarr `user_annotation` → node retrains → overlay recolors. Sub-stage `rerunnable` so only classification re-runs.
- **Done when:** relabelling 20 cells measurably shifts classification without re-segmenting.

### M6 — Feedback + hardening
- 👍/👎 → re-rank candidates in the next plan.
- Provenance annotation per run → Girder. Guardrails ("research use only"). Latency budgets, observability.

## 8. Risks / open items

- **CellViT++ is Apache-2.0 + _Commons Clause_ → resale-restricted.** Fine internally; **blocks commercial resale**. Since commercial intent is undecided, keep the registry swappable (StarDist / InstanSeg are more permissive fallbacks). Weight licenses differ from code licenses — record `license` per tool.
- **GPU**: CellViT++ needs one. Confirm hardware + whether nodes are co-located or remote.
- **Slide access**: does the agent host have direct assetstore paths, or must nodes pull via the Girder API? Affects node I/O.
- **Vite `/api` proxy ordering** — `/api/agent` must be matched before the Girder catch-all.
- **`exec()` sandbox is security-critical.** Treat as a hard gate before any multi-user exposure.
- **Zarr concurrency** under multi-user needs `ProcessSynchronizer`.
- **Clean-room hygiene**: we read TissueLab to learn the pattern. Do not copy Penn source. Cite the paper for architecture; write our own code.
