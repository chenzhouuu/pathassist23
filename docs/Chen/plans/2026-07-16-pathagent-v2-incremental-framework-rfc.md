# PathAgent v2 — Incremental Framework RFC

> **Status:** RFC / build spec for the first vertical slice. Narrower than the canonical architecture
> (`2026-07-16-pathagent-v2-conversational-copilot-architecture.md`) and shaped by its review
> (`...-architecture-review.md`).
> **Principle:** *An extensible framework is defined by its seams, not its features.* Build the contracts
> right now with thin implementations behind them; grow the machinery gradually, without rewrites.
> **Date:** 2026-07-16 · **Author:** Chen (with Claude)

---

## 1. Decisions locked (2026-07-16)

| Decision | Choice |
|---|---|
| Spine depth | **Thin-but-right-seams** — minimal implementations behind non-negotiable contracts |
| Service | **Greenfield `services/agent/`**, port reusable infra from `services/pathagent` |
| Tool #1 | **CellViT++** (built from scratch) — but **stub-first** so the spine isn't gated on GPU work |
| Tool #2 | **Histolytics** (spatial stats) |
| v1 task | **Exploratory** ROI inflammatory-cell detection/classification → count/density/clustering → overlay → follow-up. **NOT** an ITWG sTIL% assay. |
| Removal | **Nothing deleted first.** New Agent ships as a flagged tab; `pathagent`, PathChat, `claudeApi`/`geminiApi` stay. |
| Mode | **Research/exploratory only.** No validated-clinical claims yet. |

---

## 2. The seams (this IS the framework — build once, keep forever)

These six contracts are cheap now and brutal to retrofit (per review §3.3–3.6, §5.5). Everything else is
deferred *behind* them.

### 2.1 Control-plane store — Postgres, NOT Zarr
Workflow truth lives in a transactional store. Zarr holds **only arrays** (masks, contours, embeddings).
Minimal tables:
```
conversation(id, case_id, actor_id, created_at)
turn(id, conversation_id, role, text, created_at)
task(id, conversation_id, state, taskcontract_id, spec_json, created_at)
plan(id, task_id, revision, plan_json, plan_digest, status)
approval(id, plan_id, actor_id, envelope_json, approved_at)
run(id, task_id, plan_id, state, started_at, ended_at)
invocation(id, run_id, tool_ref, input_refs, params_json, idempotency_key, state)
artifact_manifest(id, run_id, tool_ref, schema_uri, zarr_uri, digest, acl_json, state)
claim(id, task_id, subject, predicate, value, unit, scope_json, evidence_ids, method_versions, status)
blackboard_fact(id, case_id, kind, payload_json, evidence_ids, lifecycle, created_at)
cache_index(cache_key, artifact_manifest_id, created_at, invalidated_at)
```
`blackboard_fact.lifecycle ∈ {proposed, observed, verified, corrected, retracted, superseded}`.
NL summaries are never the authoritative record (review §3.3).

### 2.2 `ArtifactRef` — opaque, authorized handle
The planner, tools, and (future) sandbox receive an **opaque id**, never a raw Zarr/filesystem path.
Resolution goes through `artifact_manifest` with an ACL check bound to actor+case+slide (review §3.4, §5.5).

### 2.3 Tool invocation contract — stateless
Replaces TissueLab's hidden `/init→/read→/execute` node state (review §3.4):
```
POST /invocations {invocation_id, tool_ref@digest, input_artifact_refs[], params, output_namespace, idempotency_key}
GET  /invocations/{id}                → state
GET  /invocations/{id}/events?after=n → progress (resumable)
POST /invocations/{id}/cancel
GET  /schema                          → the tool's JSON Schema (self-describing)
```
Idempotent by key; a tool writes to a run-scoped namespace and publishes a `COMMITTED` manifest atomically.
Published artifacts are never overwritten.

### 2.4 Claim — deterministic, LLM never emits the number
```
Claim { subject, predicate, value, unit, scope{case,specimen,block,slide,region},
        evidence_artifact_ids[], method_versions{tool,model,taskcontract}, uncertainty, status }
```
Claude *explains* a Claim; the authoritative value comes from the canonical result object, rendered
deterministically (review §3.5).

### 2.5 Tool registry entry — declarative, with lifecycle + license
```json
{ "name":"cellvit_seg_classify", "tool_ref":"cellvit@<digest>",
  "lifecycle":"experimental",           // experimental→evaluated→validated→approved→deprecated
  "consumes": {"schema_uri":"...","modality":"H&E","stain":"H&E","artifacts":["slide_ref","roi"]},
  "produces": {"schema_uri":"...","zarr_group":"CellViT","datasets":["contours","centroids","class_id","class_prob","embedding"]},
  "code_license":"Apache-2.0 + Commons Clause", "weight_license":"<component-specific — legal review>",
  "device":"gpu", "vram_gb":<n> }
```
Capability filter (deterministic) narrows the registry by modality/stain/artifacts/lifecycle/license
**before** the LLM sees a catalog (review §4.5).

### 2.6 Cache key — content-addressed
`key = hash(tool_digest + code/deps digest + weight digest + canonical params + ordered upstream artifact
digests + slide content digest + normalized ROI/MPP/coord-frame + schema/ontology versions +
taskcontract version + seed)`. Hits must pass ACL + integrity + stale-input checks (review §3.3).

---

## 3. Control flow (thin version)

```
turn → scope resolver (case/slide/ROI; ask if ambiguous)
     → Claude proposes TaskSpec  → minimal TaskContract bind (research mode)
     → capability filter → Claude proposes 1–N step plan (tool names enum-constrained to eligible set)
     → deterministic compile + THIN validate (schema + produces⊇consumes + units/coord-frame)
     → plan-digest approval (one human gate; envelope = cost/time/egress/expiry)
     → run: stateless /invocations per step, artifacts → Zarr, manifests+cache → Postgres
     → THIN QC (deterministic preconditions: stain/MPP/tissue coverage/empty-result/range/units)
     → Claim builder (deterministic) → grounded answer + overlay
     → blackboard_fact rows (referencing manifests)
```
Task state machine starts minimal: `RECEIVED → SPECIFIED → PLANNED → AWAITING_APPROVAL → RUNNING →
{OUTPUT_VALIDATING → COMPLETED | ABSTAINED | FAILED}`. Grows toward the review's fuller machine later.

**Surprise/abstention (thin):** deterministic checks first (empty result, wrong stain, low tissue), LLM only
for residual anomalies. "No tumour detected" renders as *"could not reliably detect tumour; stopped"*, never
*"there is no tumour"* (review §3.5).

---

## 4. Extension points — how "gradually add on" works

Each future capability is **additive behind a stable seam** — no core rewrite:

| To add… | You do… | Seam it rides |
|---|---|---|
| **A new tool** | register entry + a service speaking `/invocations` | 2.3, 2.5 |
| **A new task** | write a declarative TaskContract (YAML) | 2.5, §3 |
| **Domain knowledge** | add versioned KB docs; cite in answers | Claim evidence |
| **A QC/safety check** | add a deterministic gate to the validate/QC step | §3 |
| **Validated (clinical) mode** | flip a TaskContract to `validated`; add signed versions + validation_report | 2.5 lifecycle |
| **SlideChat perception** | register it as a `read_slide`/`describe_region` tool emitting an Observation | 2.3 |
| **Code-gen (sandboxed)** | add a sandboxed tool, research-mode only, non-authoritative | 2.3 + isolation |
| **Active learning** | correction→candidate-annotation→governed model release (new weight digest) | 2.4, cache invalidation |
| **Fuller state machine / calibration / reader study** | thicken the controller + trust plane | §2.1, §3 |

The invariant (revised per review §3.1): *the core engine has no task-specific imperative branches; tasks are
declarative TaskContracts. Exploratory mode composes eligible tools freely but cannot emit validated clinical
claims.*

---

## 5. First vertical slice (v0.1) — task list

**Track A — Spine (against a stub tool; not gated on GPU):**
1. Greenfield `services/agent/` (FastAPI). Port from `pathagent`: `gateway/auth.py` (Girder token),
   `gateway/queue.py` (RQ), SSE helper, `worker/slide_resolver.py`, `common/cache_keys.py`, relevant tests.
2. Postgres control store (§2.1) + migrations. `ArtifactRef` + manifest resolution with ACL (§2.2, §5.5).
3. Stateless `/invocations` contract (§2.3) + a **stub tool** returning canned nuclei to a run-scoped Zarr
   namespace + committed manifest.
4. Registry (§2.5) + capability filter. Minimal TaskContract loader (research mode).
5. Turn loop + scope resolver + Claude planner (enum-constrained) + thin compile/validate + one approval gate.
6. Claim builder (§2.4) + grounded-answer render. Blackboard rows. Content-addressed cache (§2.6).
7. **Gate:** end-to-end on a real DSA slide with the stub tool: plan → approve → run → claim → answer →
   follow-up reuses cache. Crash/retry/reconnect/auth tests pass.

**Track B — Real tools (parallel):**
8. **CellViT++ node** behind `/invocations` (GPU): Girder-auth slide access (S3-via-Girder or `/mnt/dsa-cache`),
   nuclei seg + cell classification + embeddings → Zarr `/CellViT/*`. Swap in for the stub.
9. **Histolytics node** behind `/invocations`: consume CellViT centroids+classes → count/density/Ripley's K /
   Moran's I / DBSCAN clustering → Zarr `/Spatial/*`.

**Track C — UI (new tab, flagged):**
10. `agentSlice` (Zustand) + `agentApi.js` (SSE via `fetch` reader — carries Girder token).
11. `agent/` panel: Composer · **Plan card** (shows scope/numerator-denominator/coverage/cost; Apply;
    older→Expired) · **Run trace** (ephemeral checklist → `Tools(n)` footer) · **Result/Claim card**.
12. `NucleiOverlay` (WebGL2, `mat3` viewport uniform, flat `Int32Array`, viewport-scoped streaming).
13. Register the tab behind a role/flag in `RightPanel.jsx` + `ViewerApp.jsx`; keep panel mounted across
    rail toggles.

**Proving demo (the exploratory task):**
> *"In this ROI, how many inflammatory cells are there and how dense?"* → CellViT++ → Claim + overlay.
> *"Are they clustered?"* → **reuse cached segmentation**, run only Histolytics → Claim + cluster overlay.
> *"Show me where."* → highlight. Three turns, shared within-case memory, no recomputation. Labeled exploratory.

---

## 6. Deferred (behind which seam)

Per the review, mapped so each lands without a rewrite:
- Governed sTIL% TaskContract (tumour boundary + stroma + exclusions + area denominator + validation) → 2.5.
- Validated vs research modes, full task state machine → §2.1/§3.
- Semantic typed-DAG compiler (full type lattice) → §3 validate step.
- SlideChat perception (needs WSI-QC → patch grid → CONCH embed → adapter) → 2.3.
- Code-gen sandbox (microVM, no net, output QC) — **disabled in v1** (review §3.6) → 2.3.
- Active learning + model governance → 2.4 + cache invalidation.
- Calibration / abstention metrics, reader study → trust plane.
- Per-patient / cross-case / episodic memory → §2.1.

---

## 7. Repo & deploy corrections (from the review, verified)

- **Do not delete `pathagent` first** — port its auth/queue/SSE/slide-resolver/cache/tests (review §5.1).
- **Removal blast radius was wrong:** `claudeApi` (AnnotationCanvas, AIPanel) and `geminiApi` (wsiAnalysis,
  AnnotationCanvas, PanelsPanel) power Ki-67/annotation/WSI — **do not delete**. Only `pathChatApi` is
  AskPA-specific. (review §5.2)
- **`PathAssistModel/`** is a working TIAToolbox-HoVer-Net Girder/S3/Celery service — a ready fallback/second
  tool node (review §5.1).
- **Production routing is nginx per-site** (`/api/ → girder_upstream`); add a higher-priority `/api/agent/`
  location, disable SSE buffering, forward auth headers. Vite proxy is dev-only. (review §5.3)
- **Slides are S3-backed via Girder assetstore** (+ `/mnt/dsa-cache/` FUSE) — access via Girder authorization;
  identify by Girder file id + size + digest, not filename. (review §5.4)

---

## 8. What v0.1 explicitly does NOT claim

- Not an ITWG sTIL% score (guideline defines a method; it is not ground truth).
- Not a diagnostic device; research/exploratory use, labeled as such.
- No autonomous long-horizon runs, no code-gen, no model retraining, no cross-case memory.
- No deletion of existing AI surfaces until the new slice passes parity + rollback.
