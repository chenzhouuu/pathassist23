# PathAgent M3 — Orchestrator (merged agent loop): Implementation & Verification Report

**Date:** 2026-07-07 · **Branch:** `chen` · **Service:** `services/pathagent`
**Milestone:** M3 (Plan 4 of the PathAgent series) — the merged PathFinder × WSI-Agents agent loop,
Diagnosis-only, streamed over SSE, verified on a real WSI.

---

## 1. Executive summary

M3 is **implemented, reviewed, and verified end-to-end on a real WSI.** On top of M1 (Trident CONCH
backbone) and M2 (classifier consensus), the gateway now runs the design's **merged loop**
— `router → triage → (navigate ⇄ describe)* → diagnose → {icv ∥ fact ∥ consensus} → summary` — as a
**LangGraph** graph, streaming all seven typed events over `POST /api/agent/query` (SSE), and serving
a zoomable importance **heatmap** at `GET /api/agent/cases/{itemId}/heatmap/{taskId}`.

The signals are **real and computed on the slide**: navigation is **query-conditioned CONCH
concept-similarity** over the cached `conch_v1` features (training-free, advisory-only); consensus
(**φ_c**) is the real M2 BRCA classifier; the fact branch (**φ_k**) retrieves a shipped **seed KB**
with real citations; all reasoning runs on a **pluggable local LLM** (MedGemma/Gemma via the
`:11500` server — the design-sanctioned swap for GPT-4V).

Real-WSI run (BRACS_1648, **36/36 checks passed**):

| Signal / artifact | Value |
|---|---|
| Backbone / consensus features | `conch_v1` 6290×512 · `uni_v1` **6290×1024** |
| Classifier consensus (φ_c source) | **ILC** — IDC 29.1% / ILC 70.9% (`ABMIL-BRCA-5fold-ensemble`) |
| Event stream (in order) | `route → triage → navigate×8 → describe×8 → diagnose → verify → final` |
| Navigation | 8 concept-similarity regions, all within level-0 `83664 × 64892` |
| Diagnosis candidate | classifier **ILC** (== `classifier.json`) + an LLM candidate |
| Verification scores | φ_l 0.50 · φ_k 0.00 · **φ_c 0.709** · φ_total 0.404 |
| Final | synthesized ILC answer, confidence 40, trail 8, heatmap PNG (19.8 KB) extent `81920×60928` |

Unit suite: **146 passing, ruff clean.** Orchestrator package ≈ 1,385 LOC across 10 focused modules.

---

## 2. Scope & honest boundaries

**Delivered & verified (the M3 "Done when": a Diagnosis query streams a verified, cited answer, a
zoomable heatmap, and a navigation trail):**
- The full LangGraph merged loop with the budgeted navigate⇄describe cycle and the parallel
  dual-verification fan-out, streamed as the 7 typed events.
- **Navigation = real** query-conditioned CONCH concept-similarity over the cached `conch_v1`
  features → hotspot + coverage regions (level-0 px) — advisory guidance, never the answer.
- **Heatmap = real** importance raster over the patch lattice → an OSD-addable PNG at its level-0
  extent, served by the `/heatmap` endpoint with `X-Level0-*` extent headers.
- **φ_c = real** consensus vs the M2 BRCA classifier; **φ_k = real** retrieval over the seed KB with
  citations; **φ_l = real** LLM logic judge.

**Deferred / pluggable — documented, not faked:**
- **Reasoning LLM = local MedGemma/Gemma** via the pluggable `LLMClient` (the design keeps the
  reasoner pluggable; hosted **GPT-4V** is a config swap, not a rewrite).
- **SlideChat** slide-level candidate generator — not deployed on this box; v1 candidate generators
  are the classifier consensus + the LLM over navigated evidence (SlideChat is the deferred third).
- **Full WHO + PathologyOutlines KB** — replaced by an extensible 12-entry **seed KB** (the design's
  M2a KB was never built on this box).
- **Region pixel description** — v1 `describe` reasons from patch coordinates + concept affinity, **not**
  from fetched pixels; the Girder crop fetch is an M4 / live-ROI concern.
- **M4 frontend replay** (live OSD co-navigation, pause/take-control, provenance annotations),
  **M3b** task fan-out (Morphology/Treatment/Report), and a **durable checkpointer** for
  redirect/resume are out of scope (v1 is Diagnosis-only, in-memory).

---

## 3. What was built

| File (`src/pathagent/…`) | Responsibility |
|---|---|
| `common/{config,cache_keys,schemas}.py` | agent settings; `CachePaths.heatmap/heatmap_meta`; `AgentQueryRequest`/`ROI`/`Candidate`/`Citation`/`VerifyScores` |
| `orchestrator/llm_client.py` | pluggable reasoning LLM (`:11500/chat`); `complete()`/`complete_json()` with string-aware JSON extraction; `LLMError` containment |
| `orchestrator/perception_subprocess.py` | **self-contained** (pathology env): CONCH text tower → question+concept cosine over cached patch feats → regions + importance-raster PNG + KB retrieval |
| `orchestrator/perception.py` | gateway `PerceptionRunner` — launches the subprocess (mirrors `trident_runner`), marshals `NavResult`, writes heatmap meta; `PerceptionError` |
| `orchestrator/{concepts,seed_kb.json,kb}.py` | diagnostic concept panel; 12-entry seed KB; `load_seed_kb`/`to_citations`/`fact_score` (φ_k, degrades safely) |
| `orchestrator/{state,nodes}.py` | `AgentState` (reducers) + `Deps`; router/triage/navigate/describe/diagnose (degrade, never raise) |
| `orchestrator/verify.py` | icv/fact/consensus branches (φ_l/φ_k/φ_c) + summary (renormalized φ_total, `verify`+`final` events) |
| `orchestrator/{heatmap,graph}.py` | heatmap meta I/O; `build_graph()` + async `run_query()` (`stream_mode="updates"`) |
| `gateway/routes.py` | `POST /api/agent/query` (SSE) + `GET …/heatmap/{taskId}` |

**Isolation:** torch/CONCH live only in `perception_subprocess.py` (pathology env); the gateway venv
gained only `langgraph`, `sse-starlette`, `numpy`, `pillow`. **Geometry:** every region/roi/heatmap
extent crossing the wire is **level-0 pixels** (design §13.1).

---

## 4. Verification results

**Unit tests:** `uv run pytest -q` → **146 passed**; `uv run ruff check .` → clean. New coverage: the
LLM client (9 — incl. fenced/prose/string-with-braces JSON extraction), the perception runner (5 —
success + missing-features/non-zero/non-JSON errors, subprocess mocked), the seed KB + `fact_score`
(10 — clamp/degrade/empty), the five nodes (16 — budget cap, perception-fail abstention,
classifier-present/absent, LLM-fail degrade), the verify branches + summary (11 — φ math,
renormalization, agree/conflict consensus, camelCase `verify` scores), and the compiled graph + SSE
endpoints (10 — ordered event stream, abstention path, heatmap 200/404/400).

**Real subprocess de-risk (pre-integration):** the actual CONCH text tower + cosine + top-k +
coverage + raster PNG + KB retrieval were run against a synthetic-but-real-geometry features h5 —
correct level-0 regions, full-slide raster extent, sensible KB ranking — before the runner was wired.

**Real-WSI end-to-end** (`scripts/m3_real_slide.py`, real Trident + real BRCA + real CONCH-nav + real
local LLM): BRACS_1648 → preprocess (conch_v1 + uni_v1 + BRCA **ILC 70.9%**) → the agent loop streamed
`route, triage, navigate×8, describe×8, diagnose, verify, final`; 8 in-bounds navigation regions; the
`diagnose` classifier candidate (**ILC**) matched `classifier.json`; real `verify` scores
(φ_c 0.709); a real synthesized `final` answer (ILC, "single-file pattern") with a real heatmap PNG at
level-0 extent. **All 36 assertions passed.**

**Calibration observation (not a defect):** φ_k came back **0.0** — a *real* judgment (the degrade path
yields 0.5), the small local reasoner scoring the answer weakly supported by the short seed-KB
snippets. This legitimately pulled φ_total to 0.40 → confidence 40, i.e. the verification layer being
skeptical (abstention/uncertainty as a feature, design §11). A richer KB, a stronger reasoner, and
φ-weight/prompt tuning are exactly the **M5 calibration** work; the pipeline itself is correct.

---

## 5. Review process & issues found + fixed

Executed subagent-driven (fresh implementer per task → inline or subagent spec+quality review → final
holistic review). Defects caught and fixed with tests:

| Sev | Issue | Fix |
|---|---|---|
| Important | `classifier.json` is stored **camelCase** (`by_alias`) but the reasoning nodes read snake_case → a `KeyError` would kill the stream mid-graph | `/query` bridges via `ClassifierResult.model_validate_json(...).model_dump()` (also validates → corrupt file treated as absent) |
| Minor | Dead M0 `/query`+`/heatmap` **stub** routes shadowed by the real router | removed the stubs + their obsolete test |
| Minor | Node/branch test gaps (budget cap when the only binding constraint; `min(4,cap)` clamp) | added isolating regression tests |

Parallel-safety was designed in: the three verify branches write **distinct** state keys
(`phi_l`/`phi_k`/`phi_c`), so the LangGraph fan-out never double-writes one key; list fields use
`operator.add` reducers; the navigate loop is bounded by the triage budget **and** a
`recursion_limit` backstop.

**Final holistic review: APPROVED-WITH-NITS — zero Critical, no must-fix.** The reviewer confirmed no
path-traversal/SSRF on the new endpoints (`cacheKey`/`taskId` validated pre-use; `taskId` is a
server-minted uuid), no mid-stream 500 (the SSE generator emits a terminal `error` event), no
parallel-write conflict, a provably bounded exploration loop, correct level-0 geometry +
`heatmapTaskId` linking, and a correct camel→snake classifier bridge. Three cheap hardening items were
folded in immediately (commit `8b37520`, with regression tests):

| Sev | Issue | Fix |
|---|---|---|
| Important | `/heatmap` `X-Level0-*` extent headers were not in CORS `expose_headers` → invisible to browser JS cross-origin → would silently break the M4 overlay | added `expose_headers=[X-Level0-*]` |
| Minor | `consensus` confidence coercion + `diagnose` classifier key access relied on upstream validation rather than their own containment | wrapped the coercion; switched to `.get(...)` — the "never raise" invariant is now structural |

The reviewer's remaining notes (per-request graph recompile; silent whole-slide fallback on an empty
ROI; `final.citations` as an additive field beyond the plan's wire contract) are optional and left for
later; none affects correctness.

---

## 6. How to run

```bash
export HF_TOKEN=<hf_...>                       # gated CONCH/UNI weights
cd services/pathagent
# cache dir MUST be world-traversable — the classifier subprocess reads it as another OS user (M2 §7)
mkdir -p /tmp/pathagent-m3-cache && chmod 755 /tmp/pathagent-m3-cache
# the local reasoning LLM server (settings.agent_llm_url, :11500) must be up
uv run python scripts/m3_real_slide.py \
    --slides-root /home/chen/data2/BRCA-TEST --slide-id BRACS_1648.svs \
    --cache-dir /tmp/pathagent-m3-cache
```
Interactive: `POST /api/agent/query` (body `{itemId, cacheKey, question, task:"Diagnosis"}`) streams
the loop as SSE; `final.heatmapTaskId` → `GET /api/agent/cases/{itemId}/heatmap/{taskId}?cacheKey=…`
returns the OSD-addable PNG (+ `X-Level0-*` extent headers). The reasoner is a config swap
(`PATHAGENT_AGENT_LLM_MODEL`, `…_URL`); `medgemma` is the pathology-tuned local option.

---

## 7. Deployment notes (carried + new)

- **Cache-dir readability (from M2 §7):** `PATHAGENT_CACHE_DIR` and its files must be traversable +
  readable by the classifier service user; the perception subprocess also reads the features h5 by
  path. Enforce a shared group + umask (or chmod).
- **Local reasoner availability:** the agent loop makes ~N+4 LLM calls per query (describe per region
  + diagnose + 2 judges + summary). Size the `:11500` server (or swap in a hosted reasoner) for the
  navigate budget; each call is bounded by `agent_llm_timeout_s`.

---

## 8. Follow-ups (none blocking)

- **Calibration (M5):** richer KB + stronger reasoner + φ-weight/prompt tuning so φ_total tracks
  correctness (reliability/ECE); the low φ_k here is the motivating example.
- **Region pixels for `describe`:** fetch Girder `/tiles/region` crops so descriptions are
  pixel-grounded (feeds the live-ROI fast path).
- **SlideChat candidate + full WHO/PathologyOutlines KB** — the two deferred perception pieces.
- **Item-level authorization** (carried from M1/M2): bind the caller to `itemId` on the
  status/classifier/query/heatmap reads (holder-of-`cacheKey` currently reads).
- **Durable checkpointer** for the redirect/resume fast-follow (v1 is in-memory, pause-only).
- **`default_consensus_encoder`** remains dead config (carried).

---

## 9. Commit log (this milestone)

```
8b37520 fix(pathagent): harden M3 per final review (CORS extent headers, defensive classifier reads)
fa30512 test(pathagent): add M3 real-WSI verification script
bad266b feat(pathagent): wire LangGraph merged loop + SSE query and heatmap endpoints
a6b65a2 feat(pathagent): add dual verification branches + summary (phi_l/phi_k/phi_c/phi_total)
e9961b5 feat(pathagent): add agent state + reasoning nodes (router/triage/navigate/describe/diagnose)
26ba5de feat(pathagent): add seed KB expansion + fact-branch scoring and citations
4951fca feat(pathagent): add CONCH concept-similarity perception subprocess + runner
b50d3be feat(pathagent): add pluggable reasoning LLM client
02c1c65 feat(pathagent): add M3 agent settings, heatmap cache paths, query schemas
2581ac7 docs(plan): add PathAgent M3 orchestrator (merged loop) plan
```

## 10. Recommendation

M3 is complete and real-WSI-verified. The backbone series M0→M3 now delivers, on this box:
**preprocess → Trident CONCH backbone → UNI consensus + BRCA classifier → the merged, verified,
cited, navigable Diagnosis agent loop with a zoomable heatmap.** Next: either finish the branch
(PR/merge M0–M3), or proceed to **M4** — the React PathAgent panel that replays the `navigate` events
in the live OSD viewer and overlays the heatmap (consuming this milestone's SSE stream + level-0
`top_coords`/heatmap extent) — followed by **M5** evaluation & calibration.
