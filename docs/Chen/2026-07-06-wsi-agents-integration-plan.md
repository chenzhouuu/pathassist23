# PathAssist × Trident × WSI-Agents — Integration Design (v3)

> **Status:** Design (v3 — locked; approved to proceed to implementation planning)
> **Date:** 2026-07-06
> **Author:** Chen (with Claude)
> **Goal:** Use **PathAssist** (React WSI viewer) as the backbone and add an advanced,
> multi-agent LLM **pathology copilot** — "PathAgent" — as a new right-panel feature. The agent
> merges the **WSI-Agents** verification design with the **PathFinder** navigation loop, uses
> **SlideChat** for slide-level reasoning, and stands on **Trident** for features. It doesn't just
> answer — it **co-navigates the slide** with the pathologist and shows its evidence in the viewer.

Out of scope by explicit instruction: AskPA (existing chat), MIL-based models, licensing (noted as
a risk, deferred).

---

## 1. The systems, and what we borrow from each

**Core stack (the three we compose):**

| System | Role | Gives us | Lacks |
|---|---|---|---|
| **PathAssist** (this repo) | **Head / data plane** | OSD viewer, Girder/DSA backend, ROI selection, region-pixel fetch, annotation read/write, resizable tabbed right panel, auth, live `viewer` handle | Reasoning, foundation-model features |
| **Trident** (Mahmood Lab) | **Feature backbone** | WSI → seg → patch coords → patch/slide embeddings (CONCH/TITAN/…), cached | Reasoning, UI |
| **WSI-Agents** (Lyu et al., MICCAI'25) | **Trust layer** | Dual verification: internal consistency + external KB/classifier consensus → scored summary | Runs offline over *pre-computed* answers; no navigation; aging model zoo |

**Reference systems we build on (2025 landscape review):**

| System | Venue / license | What we take |
|---|---|---|
| **SlideChat** | CVPR'25 · **Apache-2.0, open weights** | Our **slide-level perceiver**. CONCH patch features → sparse-attention slide encoder → Qwen2.5-7B. Consumes exactly Trident's CONCH output; runs on one 24 GB GPU. |
| **PathFinder** | ICCV'25 · code pending | The **clinical navigation loop** — Triage → Navigate → Describe → Diagnose — that iteratively moves around the WSI via importance maps like a pathologist. |
| **Patho-Bench / SlideBench** | 2025 · open | The **M5 evaluation** harness (42 FM tasks + slide-level VQA). |
| **NOVA** | Nov'25 · `microsoft/nova-agent`, open | Blueprint for a future **"discovery mode"** (code-writing agent for biomarker analysis). Not v1. |
| **CPath-Omni** | CVPR'25 · open | Fallback unified patch+WSI model if SlideChat underperforms on a task. |

**The synthesis (the reason this is a research platform, not a reimplementation):** WSI-Agents and
PathFinder were both built for *offline benchmarks*. PathAssist is a *live viewer*. We fuse
PathFinder's navigation with WSI-Agents' verification and let the agent drive the actual
OpenSeadragon viewport — something no released system does in a real viewer.

---

## 2. Locked decisions

1. **Compute = Hybrid.** Self-host Trident + the open perception models (CONCH, TITAN, **SlideChat**,
   optionally PRISM) on your GPUs — the accuracy anchors. **GPT-4V** (OpenAI, keys server-side in the
   Gateway) is the reasoning/orchestration + ROI + report layer. The reasoning LLM is **pluggable**
   (hosted GPT-4V for v1's de-identified data ↔ self-hosted Qwen2.5-VL for future PHI sites).
2. **Interaction = Background precompute per case.** On slide open, Trident + classifier + SlideChat
   feature passes run in the background (minutes); the panel goes "ready" when cached.
3. **Fidelity = Pattern, modern subset.** Keep the *architectures* (WSI-Agents verification +
   PathFinder navigation) with current, open models — not the papers' exact aging zoos.
4. **First milestone = Backbone service first**, then wire the panel.
5. **Backbone encoder = CONCH-family (primary).** Serves SlideChat and the TITAN consensus path.
   SlideChat needs `conch_v1` (512-d); TITAN needs `conch_v1.5` (768-d) — both CONCH-family, both
   produced by Trident (expect up to two CONCH passes; consolidation is a spec sub-question). **UNI
   is optional**, kept only for nearest-neighbour retrieval / attention heatmaps if wanted.
6. **Slide-level reasoner = SlideChat** (Apache-2.0, open weights, native-resolution slide VQA).
7. **Agent design = full merge.** Experts follow PathFinder's **Triage → Navigate → Describe →
   Diagnose** loop, wrapped in WSI-Agents' **dual verification** before the summary.
8. **Viewport = agent co-navigates.** The Navigation agent pans/zooms the live OSD viewer to the
   regions it examines and narrates; a **pause / take-control** affordance keeps the pathologist in
   charge.
9. **v1 task scope = Diagnosis only** (M3); Morphology / Treatment / Report fan out in M3b.
10. **Overlays = OSD-native and zoomable** for *all* agent visuals (§8).

---

## 3. Target architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  PathAssist (React + OpenSeadragon)                          [EXISTING + new]  │
│   Viewer (live `viewer` handle) · ROI select · getRegionImageBlob · annots     │
│   ┌────────────────────────── Right panel: NEW TAB "PathAgent" ────────────┐   │
│   │ readiness banner · task chips · chat · streaming agent-trace           │   │
│   │ NAVIGATION TRAIL (agent drives viewport) · heatmap toggle · confidence │   │
│   │ citations · save-as-annotation · [pause / take control]                │   │
│   └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────┬────────────────────────────────────────────┘
                                     │  nginx /api/agent  ·  SSE/WebSocket stream
┌───────────────────────────────────▼────────────────────────────────────────────┐
│  Agent Gateway (FastAPI): auth passthrough · case registry · job queue (Redis)  │
│  POST /cases/{id}/preprocess · GET /cases/{id}/status                            │
│  POST /agent/query (stream: route|triage|navigate|describe|diagnose|verify|final)│
│  GET /cases/{id}/heatmap/{taskId}                                                │
└──┬───────────────┬───────────────────────────┬──────────────────────────────────┘
   │               │                           │
   ▼               ▼                           ▼
┌────────┐  ┌───────────────────────┐  ┌──────────────────────────────────────────┐
│Trident │  │ Perception (local GPU)│  │ Orchestrator — merged loop + verification │
│worker  │  │ • CONCH  (patch feats,│  │                                          │
│seg→    │  │   zero-shot cls,      │  │  Router ─▶ Triage ─▶ Navigate ─▶ Describe │
│coords→ │  │   concept heatmaps)   │  │                         │          │      │
│CONCH   │  │ • SlideChat (slide VQA│  │           (drives OSD)  ▼          ▼      │
│feats→  │  │   / caption)          │  │                    Diagnose (candidates)  │
│slide   │  │ • TITAN (slide zero-  │  │                         │                 │
│agg     │  │   shot consensus)     │  │        ┌─── Verify (WSI-Agents dual) ────┐│
│        │  │ • PRISM (optional)    │  │        │ ICV φ_l · KB φ_k · consensus φ_c ││
│        │  │ • CONCH concept-sim → │  │        └───────────────┬─────────────────┘│
│        │  │   query-time nav map  │  │              Summary: φ_total, best answer,││
└───┬────┘  └──────────┬────────────┘  │              heatmap + navigation trail    ││
    │                  │               │              Reasoning = GPT-4V            ││
    ▼                  ▼               └──────────┬─────────────────────────────────┘│
┌────────────────────────────────┐               │        ┌───────────────────────┐ │
│ Feature / artifact cache        │◄──────────────┘        │ Knowledge base        │ │
│ (key = itemId+params-hash):     │                        │ Chroma/pgvector over  │ │
│ CONCH h5 · coords · thumbs ·    │                        │ WHO + PathologyOutlines│ │
│ GeoJSON · slide feats · cls out │                        └───────────────────────┘ │
└──────────────┬─────────────────┘
               ▲  WSI pixels by itemId
┌──────────────┴─────────────────┐
│ Girder 5 / DSA  [EXISTING]     │
└────────────────────────────────┘
```

---

## 4. The merged agent loop (PathFinder × WSI-Agents)

A single query streams through this loop. Reasoning steps run on **GPT-4V**; perception steps use
the local models over cached **CONCH** features.

1. **Router / Task agent** *(WSI-Agents)* — is this a WSI question? which task? (v1: Diagnosis) →
   selects the tools/agents to run. Emits `route`.
2. **Triage agent** *(PathFinder)* — fast benign-vs-suspicious / risk read from slide-level signals
   (TITAN zero-shot + a quick SlideChat pass) → sets how deep to examine. Emits `triage`.
3. **Navigation agent** *(PathFinder)* — the importance map is **query-conditioned CONCH
   concept-similarity**: the pathologist's question is embedded with CONCH's text tower and cosined
   against every cached patch embedding, so navigation follows *the actual question* (zero-shot, no
   training, ~free from the feature cache). Regions are picked by balancing **exploitation** (top-
   similarity hotspots) with **coverage** (sampling across tissue), mirroring real sign-out: a
   **low-mag systematic survey, then targeted high-mag dives**. The agent then **drives the OSD
   viewport** to each region (pan+zoom) and highlights it, fetching true-resolution pixels via
   `getRegionImageBlob`. Emits `navigate` events `{region, zoom, rationale}` the panel replays in the
   viewer. (Concept-similarity is an *advisory guidance* signal, not a diagnosis — it decides where to
   look, never what the answer is.)
4. **Description agent** — GPT-4V describes each visited region crop (optionally cross-checked by
   SlideChat) → structured evidence snippets. Emits `describe`.
5. **Diagnosis / expert agent(s)** — synthesize evidence + SlideChat's slide-level answer +
   classifier outputs into **candidate answers** {y_i} with reasoning. Emits `diagnose`. *v1 uses two
   candidate generators* (SlideChat slide-level + GPT-4V on the navigated ROIs); the external trust
   signal comes from the CONCH/TITAN/PRISM classifier consensus. CPath-Omni can join as a 3rd
   generator later if cross-MLLM consistency proves worth the extra 15B model.
6. **Verification** *(WSI-Agents dual)* over the candidates:
   - **ICV** — logic agent extracts claims/evidence, scores compatibility + evidence validity → φ_l.
   - **EKV — Fact** — RAG over WHO + PathologyOutlines → factual alignment φ_k.
   - **EKV — Consensus** — agreement of the extracted cancer type vs {CONCH, TITAN, PRISM} → φ_c.
   Emits `verify` with scores + citations.
7. **Summary agent** — φ_total = w₁φ_l + w₂φ_k + w₃φ_c → pick + synthesize the final answer with a
   confidence badge, KB citations, the **heatmap**, and the **navigation trail** (visited regions,
   savable as annotations). Emits `final`.

**Answer-first, verify-streaming (progressive disclosure).** Verification is many GPT-4V calls
(~20–40 s if run fully up front), so the preliminary `diagnose` answer + navigation trail render
**immediately**; the `verify` scores (φ_l/φ_k/φ_c) and citations stream in afterward and update the
confidence badge live. Responsive without weakening the trust story.

---

## 5. Model roles (who does what)

| Capability | Model | Where |
|---|---|---|
| Patch features (backbone) | **CONCH** (`conch_v1` for SlideChat, `conch_v1.5` for TITAN) | Local, Trident |
| Slide-level VQA / caption | **SlideChat** (Qwen2.5-7B, sparse-attn slide encoder) | Local, 24 GB GPU |
| Zero-shot cancer-type classifiers (consensus) | **CONCH**, **TITAN**, PRISM (opt) | Local |
| Importance map (navigation) | **Query-conditioned CONCH concept-similarity** + coverage sampler (no training) | Local |
| Router, Triage reasoning, Description, Diagnosis reasoning, Verification judges, Report | **GPT-4V** | Hosted (keys in Gateway) |
| KB retrieval | embeddings + Chroma/pgvector over WHO + PathologyOutlines | Local/hosted |
| Retrieval / alt heatmaps (optional) | **UNI** | Local |

---

## 6. API contract (Agent Gateway ↔ PathAgent panel)

Served under `/api/agent` (nginx convention, mirrors `/api/llm`, `/api/brca`). Auth: forward the
existing Girder token; Gateway validates via Girder `getMe`.

```
POST /api/agent/cases/{itemId}/preprocess
  body: { backbone:  {patchEncoder:"conch_v1",   mag:20, patchSize:256},   # SlideChat input
          consensus: {patchEncoder:"conch_v1.5", mag:20, patchSize:512},   # TITAN path
          slidechat: true }   # slide-level rep = SlideChat encoder + TITAN
  → 202 { jobId, cacheKey, status:"queued" }
  # One seg/coords pass; CONCH feature pass(es); SlideChat + TITAN/CONCH classifier passes.

GET  /api/agent/cases/{itemId}/status?cacheKey=...
  → { status:"queued|running|ready|error", stage, progress,
      ready:{ features, slidechat, classifiers } }

POST /api/agent/query                                     (SSE / WebSocket stream)
  body: { itemId, cacheKey, task?:"auto|Diagnosis", question, roi?:{x,y,width,height} }
  → stream:
      {type:"route",    task, tools}
      {type:"triage",   risk, depth}
      {type:"navigate", region:{x,y,width,height}, zoom, rationale}   # panel moves the viewer
      {type:"describe", region, findings}
      {type:"diagnose", candidates:[{source, answer}]}
      {type:"verify",   scores:{phi_l,phi_k,phi_c,phi_total}, citations:[...]}
      {type:"final",    answer, confidence, heatmapTaskId, trail:[...], annotations:[...] }

GET  /api/agent/cases/{itemId}/heatmap/{taskId}
  → OSD-compatible tile source (single image tile for coarse maps, DZI for high-res)
```

---

## 7. Data flow

**Precompute (on case open):** panel calls `preprocess` → Gateway enqueues a Trident job → worker
pulls the WSI from Girder, runs seg → coords → CONCH features, then the SlideChat + CONCH/TITAN
classifier passes run over the cached features. Status flips to `ready`. (The query-conditioned
importance map is computed later, per question — not at precompute.)

**Query (interactive):** pathologist asks / taps a task chip → `POST /agent/query` streams the loop
in §4. The panel **replays `navigate` events in the viewer** (pan/zoom + highlight) and renders the
agent trace. The preliminary `diagnose` answer appears **first**; `verify` scores + citations stream
in after and update the confidence badge. Every run **auto-persists** a provenance annotation (trail
+ answer + φ-scores + model/KB versions + timestamp) to Girder; the pathologist can also save
individual findings.

---

## 8. PathAssist integration points (exact, from codebase map)

Following the AskPA template, but the backend moves **server-side** (more secure — no in-browser
keys), and the panel gains **viewer control**.

1. **Store** — `src/store/index.js`: add an `agent*` slice mirroring `chat*` (`:218-233`):
   `agentMessages, agentTrace, agentStatus, agentNavTrail, agentHeatmap, agentFollow(bool)` +
   setters. Consume existing `activeItem._id`, `tilesInfo`, `viewer`, `roiSelectResult`.
2. **API** — new `src/api/wsiAgentApi.js`: `preprocessCase`, `pollStatus`, `streamAgentQuery` (SSE via
   `fetch` ReadableStream or WebSocket), `fetchHeatmap`. Config via `VITE_AGENT_API_URL`.
3. **Panel** — new `src/components/panels/PathAgentPanel.jsx` (fork `PathChatPanel.jsx`): readiness
   banner, task chips, streaming trace accordion, **navigation-trail list**, confidence badge,
   heatmap toggle, **pause/take-control** button. Reuse the `roi-select` → `roiSelectResult` handoff
   and `getRegionImageBlob` for grounding.
4. **Tab registration (two non-DRY spots):** content switch + tab bar in `RightPanel.jsx:42-65,
   109-115`, and the icon rail in `ViewerApp.jsx` `RightRail` (`:111-153`). Gate with
   `hasRole('ai-users')`.

**Viewport co-navigation:** on each `navigate` event (when `agentFollow` is on), convert the region
to viewport coords and call `viewer.viewport.fitBounds(...)` (image→viewport via OSD's
`imageToViewportRectangle`), then draw the highlight through the annotation layer. Pause stops the
panel from consuming further `navigate` moves without stopping the stream.

**Overlays are OSD-native and zoomable (all agent visuals):**
- *Heatmaps / importance maps:* served by `/heatmap` as a tile source, added via OSD `addTiledImage`
  (opacity slider) — pans/zooms with the slide for free.
- *Navigation highlights & vector findings:* written through the existing HistomicsUI annotation
  layer (`createAnnotation` + the OSD-synced canvas), which already transforms with the viewport.
- Reuse coordinate helpers `viewerToImg` / `imgToViewer` (`annotationUtils.js:34-51`).

**Coordinate contract (consistent end-to-end):** `CONCH patch coords (mag/size)` ↔ `OSD image pixels
(tilesInfo.sizeX/Y)` ↔ `viewport`. One transform module converts patch index ↔ image-pixel rect ↔
viewport, shared by ROI→patch mapping, navigation moves, and heatmap overlay.

---

## 9. Milestones (backbone-service-first) with acceptance criteria

**M0 — Contracts & scaffolding.** OpenAPI for the endpoints; FastAPI skeleton; Redis + job queue;
auth passthrough; cache layout. *Done when:* stubbed endpoints return well-formed (incl. mock
`navigate`) events and the frontend can integrate against mocks.

**M1 — Trident preprocessing backbone.** Dockerized worker pulls a WSI from Girder by `itemId`, runs
seg → coords → CONCH features (`conch_v1`; the `conch_v1.5` pass is added with TITAN in M2b);
idempotent/resumable; params-hash keys. Feature service: `itemId + ROI/patch idx → embeddings + patch crop`. *Done when:*
`preprocess`/`status` work end-to-end on a real DSA slide.

**M2 — Perception services (phased).** *M2a:* SlideChat inference (slide VQA/caption from cached
`conch_v1` features) + the **query-conditioned CONCH concept-similarity** importance map + KB
(Chroma/pgvector over WHO + PathologyOutlines). *M2b:* add the TITAN consensus classifier (needs the
`conch_v1.5` pass) + CONCH/PRISM zero-shot. *Done when:* a slide yields a SlideChat answer, a
query-driven importance map, cited KB chunks (M2a), then consensus predictions (M2b).

**M3 — Orchestrator, Diagnosis only.** The merged loop: Router → Triage → Navigate → Describe →
Diagnose → dual verification → summary, streaming all event types incl. `navigate`. Heatmap producer
→ OSD tile source. *Done when:* a Diagnosis query streams a verified, cited answer, a zoomable
heatmap, and a navigation trail.

**M3b — Task fan-out.** Extend router + experts to Morphology, Treatment, Report, reusing M3's
verification/summary. *Done when:* all four task chips work end-to-end.

**M4 — Frontend PathAgent panel.** Store slice + api client + panel + tab registration; readiness
banner, task chips, streaming trace, **live viewport co-navigation + client-side pause**, heatmap
overlay, **auto-persisted provenance annotation per run** + manual save-as-annotation. *Done when:* a
pathologist opens a slide and watches the agent navigate, reason, verify, and answer in the right
panel, with the run saved to Girder.

**M5 — Eval & hardening.** Wire **Patho-Bench + SlideBench** to measure the merged agent vs a
single-MLLM (SlideChat-only, GPT-4V-only) baseline; latency budgets; caching; observability;
guardrails ("research use only", not diagnostic). *Done when:* the multi-agent layer measurably
beats the baselines and latencies meet budget.

---

## 10. Optional later add — live ROI fast path & discovery mode

- **Live ROI:** pathologist draws an ROI → extract only that region's patches → CONCH + GPT-4V live
  (seconds) → region-level answer + local heatmap, bypassing full-slide preprocessing. Add after M4.
- **Discovery mode (NOVA-style):** a code-writing agent that scripts cohort/biomarker analyses over
  the feature cache. Research extension, post-v1.

---

## 11. Risks & things to revisit

- **Licensing (deferred but now clearer):** SlideChat is **Apache-2.0** (permissive) — the friendly
  path. Trident (CC-BY-NC-ND), CONCH/UNI (gated research), TITAN (research-use) are non-commercial.
  A commercial path would lean on the permissive components + retrained/owned encoders. Resolve
  before any product use.
- **Navigation UX:** an agent moving the pathologist's view can be jarring — hence default co-nav
  *with* a prominent pause/take-control and a visible trail. Validate with a real pathologist early.
- **Latency:** slide-level Trident + SlideChat are minutes on GPU; mitigated by background precompute
  + caching + the ROI fast path. SlideChat needs ~24 GB VRAM for <20k patches — size the GPU.
- **Two CONCH passes:** `conch_v1` (SlideChat) + `conch_v1.5` (TITAN) is real cost; consolidation is
  a spec sub-question (accept one variant vs run both).
- **Hallucination/grounding:** the verification layer + navigation trail + citations are the value
  over AskPA — keep them prominent, with the disclaimer.
- **PHI egress (resolved — v1 research-only, de-identified):** hosted GPT-4V is acceptable for v1
  because the data is de-identified. The **reasoning LLM stays pluggable** (hosted GPT-4V ↔ self-hosted
  Qwen2.5-VL) so a future PHI deployment is a config swap, not a rewrite; strip slide-label/metadata
  before any crop leaves and never put identifiers in prompts, regardless.
- **Failure modes & abstention:** preprocess-fail → panel error, agent disabled with a reason;
  no-tissue or non-H&E (IHC/cytology/frozen) → triage **abstains** ("outside supported scope") rather
  than hallucinating; MLLM-vs-classifier disagreement is **surfaced as signal** and lowers φ_c /
  confidence; low confidence → explicit "uncertain, recommend review". Abstention is a feature.
- **Orchestration framework:** **LangGraph** (decided) — its cyclic-graph + streaming + checkpointing
  fit the navigate↔verify loop far better than AutoGen (paper's choice) or a hand-rolled loop.

### Reference deployment config (provisional — match hardware to this)

| Component | VRAM | Notes |
|---|---|---|
| SlideChat (Qwen2.5-7B + slide encoder) | ~24 GB | inference for <20k patches; the serving anchor |
| CONCH patch encoder | ~1–2 GB | **throughput-bound** (thousands of patches/slide) — the extraction bottleneck |
| TITAN slide encoder | ~4–8 GB | consumes `conch_v1.5` features |
| Concept-similarity / KB / router | negligible | GPT-4V is hosted → no local VRAM |

- **Recommended:** 2 × 48 GB (L40S / A6000 / A100-40). GPU-A serves SlideChat + TITAN; GPU-B runs
  Trident CONCH extraction. Enables **eager** precompute on case-open, precompute + inference in
  parallel.
- **Minimum:** 1 × 48 GB, sequenced → prefer **lazy** (run SlideChat/consensus on first query per
  slide, not at case-open) to keep case-open cheap.
- **Precompute latency budget (2-GPU):** seg+coords ~0.5–2 min · CONCH extraction ~1–4 min ·
  SlideChat pass ~seconds–1 min · consensus seconds → **~3–8 min/slide** background.
- **Storage:** CONCH feature cache ~0.2–0.5 GB/slide (both variants); e.g. 1,000 slides ≈ 0.2–0.5 TB.
  Use an object store (S3/MinIO) with a TTL/LRU **retention policy** — keep small artifacts (coords,
  slide feats, classifier outputs) longer than the large patch-feature h5s.

---

## 12. Resolved decisions & sub-questions

**Resolved (locked with you):** GPT-4V reasoning · **CONCH-family primary backbone** · **SlideChat**
slide reasoner · **full merge** (PathFinder navigation + WSI-Agents verification) · **agent
co-navigates** the viewer · Diagnosis-only v1 · OSD-native zoomable overlays · Patho-Bench/SlideBench
eval.

**Locked defaults (recommended and accepted):**
1. **Navigation signal:** query-conditioned CONCH concept-similarity + coverage sampler (survey→dive).
   *No trained ABMIL in v1.*
2. **Verification UX:** answer-first, verify-streaming (progressive disclosure).
3. **Candidate generators (v1):** two (SlideChat + GPT-4V) + classifier consensus; CPath-Omni later.
4. **SlideChat base:** Qwen2.5-7B.
5. **Orchestration:** LangGraph.
6. **CONCH passes:** start `conch_v1` + SlideChat only (M2a); add `conch_v1.5` + TITAN (M2b); measure
   before deciding whether two passes stay.
7. **Heatmap threshold:** single image tile ≤ ~4k patches, DZI beyond.
8. **Hardware/eager-vs-lazy:** design to the §11 reference config — eager on 2-GPU, lazy on single-GPU.

**Confirmed this session:** GPU = design for **both** eager (2-GPU) and lazy (1-GPU) paths ·
take-control = **pause-only v1**, redirect fast-follow · audit = **auto-persist** every run · PHI =
v1 **research-only on de-identified data** → hosted GPT-4V OK, reasoning LLM kept pluggable.

**Still genuinely open:**
- Whether M3b (all four tasks) is in v1 scope or a separate follow-on.
- Whether the Axis-4 reader study (§14) is in v1 or a later clinical-impact phase (needs IRB).

---

## 13. Implementation design notes (pressure-test)

Captured now because these two areas are where the build usually gets messy.

### 13.1 Wire geometry — one canonical space
**All geometry crossing `/api/agent` is level-0 (base) image pixels** — `roi`, `navigate.region`,
heatmap extents. Girder `/tiles/region`, OSD image coords, and the existing `roiSelectResult` already
speak level-0 px, so neither side needs patch geometry or magnification. Backend owns patch↔px0 (it
has Trident coords); frontend owns px0↔viewport (it has OSD).

### 13.2 LangGraph state & graph
`AgentState` (TypedDict; reducers on list fields): `question, task, itemId, cacheKey, roi?,
importanceRef, visited[], candidates[], scores{φ_l,φ_k,φ_c,φ_total}, citations[], prelim, final,
control{mode, redirectRoi?}, budget{maxRegions, spent}`.

Graph: `router → triage → (navigate ⇄ describe)* → diagnose → {icv ∥ fact ∥ consensus} → summary → END`.
- **Cycle:** `describe` → conditional edge: budget left & not converged → `navigate` again; else → `diagnose`.
- **Streaming:** a custom stream writer emits one typed event per node; `navigate` fires *before* the
  crop fetch so the viewer moves live.
- **Answer-first:** `diagnose` streams `prelim` immediately; the three verify branches are downstream
  and stream their `φ` scores; `summary` finalizes the confidence badge.
- **Budget/termination:** `triage` sets `maxRegions` by risk (benign ~3 / suspicious ~8 / hard cap 12);
  early-stop on high confidence + coverage. Guards against runaway navigate cycles + GPT-4V cost.
- **Checkpointer:** thread_id = queryId. **v1 = in-memory** (pause-only). The redirect/resume
  fast-follow swaps in a durable store (Redis/Postgres) for the server-side `interrupt` → inject
  `redirectRoi` → resume.

### 13.3 Coordinate module (shared contract)
Backend (Python, reads Trident `coords.h5` **attrs** — never hardcode):
- `patchIdx → rect_px0` via `patch_size × downsample_to_level0`.
- `rect_px0 → patchIndices` for ROI-scoped queries.
- Importance raster on the **conch_v1 (256@20×)** lattice (finer heatmap), transparent where a tissue
  patch is absent, emitted with its level-0 extent.

Frontend (JS, OSD): `rect_px0 → viewport` via `imageToViewportRectangle` + `fitBounds` (navigate);
heatmap via `addTiledImage({tileSource, x, y, width})` at the level-0 extent (zooms natively).

**Gotchas encoded here:** (1) derive `downsample`/mag from Trident attrs + `tilesInfo.mm_x` — slides
vary (40× vs 20×); (2) two CONCH grids (256 vs 512) → grid is a parameter, navigation uses v1;
(3) build the raster over the *full* grid at Trident's exact origin or the heatmap shifts a patch
(smear); (4) request ROI crops at sufficient output mag so GPT-4V sees nuclear/mitotic detail.

### 13.4 Resolved (this round)
- **Take-control:** *pause-only in v1* (client-side, in-memory checkpointer). **Redirect/resume** is a
  fast-follow (server-side `interrupt` + durable Redis/Postgres checkpointer).
- **Audit trail:** **auto-persist every run** — each run writes a provenance annotation to Girder
  (regions visited, answer, φ-scores, model + KB versions, timestamp) via `createAnnotation`;
  re-openable and the basis for reproducibility. A deployment toggle disables it for demo/storage-
  sensitive sites.

## 14. Evaluation & scientific claims

The merge is testable, and the tests are the contribution. M5 measures four axes; the ablation grid
is the core.

**Ablation grid (isolates our contributions):** SlideChat-only · GPT-4V-thumbnail-only · +navigation
(no verify) · +verification (no navigation) · **full merged**. Shows navigation and verification each
add value, and how they interact — the central scientific claim.

- **Axis 1 — Task accuracy:** Patho-Bench (42 tasks) + SlideBench-VQA (TCGA/BCNB) + WSI-Bench;
  per-task accuracy vs baselines.
- **Axis 2 — Trust / faithfulness:** claim-level factuality (φ_k, human-audited sample); **confidence
  calibration** (does φ_total predict correctness? reliability diagram / ECE); citation validity
  (judge audit); **abstention precision/recall** on OOD / non-H&E inputs.
- **Axis 3 — Navigation quality (unique to the viewer design):** **region hit-rate** — does the trail
  visit the diagnostic region? Use **CAMELYON16** pixel-level tumor masks (IoU/recall of navigated vs
  ground-truth metastasis); **efficiency** — regions visited to reach the correct answer.
- **Axis 4 — Human factors (the 'help pathologists' test):** small **reader study**, pathologist ±
  copilot — accuracy, time-to-diagnosis, usability, and **automation bias** (does a wrong agent answer
  mislead the reader?). Needs IRB + pathologist time → likely a phase after the benchmark paper.

**Infra synergy:** the auto-persisted provenance annotations (regions, answer, φ-scores, model/KB
versions) double as versioned eval records — version model + KB + prompt in every run.

**Publishable claims:** (a) navigation + verification > either alone; (b) verification improves
calibration + faithfulness; (c) query-conditioned navigation finds diagnostic regions efficiently;
(d) in-viewer co-navigation helps real pathologists.

## 15. References

- WSI-Agents — arXiv 2507.14680 · github.com/XinhengLyu/WSI-Agents
- Trident / TITAN / Patho-Bench — github.com/mahmoodlab/{TRIDENT,TITAN}
- SlideChat (CVPR'25, Apache-2.0) — github.com/uni-medical/SlideChat · HF: General-Medical-AI/SlideChat_Weight
- PathFinder (ICCV'25) — pathfinder-dx.github.io
- CPath-Omni (CVPR'25) — github.com/PathFoundation/CPath-Omni
- NOVA (2025) — github.com/microsoft/nova-agent
```
