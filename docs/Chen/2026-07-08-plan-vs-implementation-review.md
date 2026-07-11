# PathAgent — Plan (design v3) vs. Implementation: Comprehensive Review

**Date:** 2026-07-08 · **Branch:** `chen` · **Reviewer:** Claude (Opus 4.8) with Chen
**Baseline plan:** `docs/Chen/2026-07-06-wsi-agents-integration-plan.md` (v3, locked)
**Code reviewed:** `services/pathagent/` (gateway · worker · orchestrator) + `src/` (React frontend), verified file-by-file.

> **Method.** Four independent read-only audits (gateway/API, Trident worker, LangGraph orchestrator,
> React frontend) each compared the real source against a specific plan section (§4 loop, §5 model
> roles, §6 API, §8 frontend, §13 geometry/state) and returned file:line-grounded findings. Cross-checked
> against the five milestone reports (M0–M4). Every claim below is anchored in code, not in the reports.

---

## 0. Verdict

**The plan's *system design* was built faithfully; the plan's *model roster* was not.**

The architecture skeleton is real and matches the design: the FastAPI/Redis/RQ gateway, the LangGraph
merged loop (`router→triage→(navigate⇄describe)*→diagnose→{icv∥fact∥consensus}→summary`), the parallel
verification fan-out, the query-conditioned CONCH concept-similarity navigation, the level-0-pixel
geometry contract, and the React co-navigation panel all exist and are wired as specified. What has
diverged heavily is the **model / knowledge substrate**: nearly every heavyweight perception or
reasoning component named in §4–§5 — **GPT-4V, SlideChat, TITAN, PRISM, `conch_v1.5`, WHO +
PathologyOutlines RAG, and pixel-crop description** — is **substituted or absent**, replaced by a local
Gemma/MedGemma LLM + a single supervised **BRCA ABMIL** classifier (IDC vs ILC) + a 12-entry seed KB.
The system runs end-to-end on a real slide, but it is a **thin, breast-specialized instantiation** of the
designed pipeline rather than the full-fidelity platform.

---

## 1. Milestone status (plan §9)

| Milestone | Plan intent | Actual state | Verdict |
|---|---|---|---|
| **M0** Contracts & scaffolding | FastAPI + Redis queue + auth passthrough + cache layout; **stubs** | Fully real (not stubs): RQ-on-Redis, Girder `getMe` auth, cache-key `itemId-<hash>`, camelCase wire | ✅ **Done, exceeds** |
| **M1** Trident backbone | seg→coords→CONCH `conch_v1`; idempotent; **+ feature service (itemId + ROI/patch-idx → embeddings + patch crop)** | `conch_v1` pass real & verified; cache short-circuit; local-first slide resolution (fix #1). **Feature service absent.** | 🟡 **Mostly — 1 acceptance item missing** |
| **M2a** SlideChat + query-nav + KB (Chroma / WHO+PathOutlines) | SlideChat VQA · importance map · real KB | Importance map ✅. **SlideChat never built. KB = 12-entry `seed_kb.json`, no vector store.** | 🟠 **Partial — two big pieces missing** |
| **M2b** TITAN consensus (`conch_v1.5`) + CONCH/PRISM zero-shot | TITAN + `conch_v1.5` pass + zero-shot ensemble | **Substituted:** `uni_v1` features + **BRCA ABMIL** classifier (IDC vs ILC). No TITAN, `conch_v1.5`, PRISM, or CONCH zero-shot. | 🟠 **Substituted, not built as designed** |
| **M3** Orchestrator, Diagnosis-only | Full merged loop, streamed, verified, heatmap | Graph + fan-out + heatmap + SSE all real | ✅ **Done (substituted models)** |
| **M3b** Task fan-out (Morphology/Treatment/Report) | 4 task chips | Diagnosis only | ⬜ **Deferred (as planned for v1)** |
| **M4** React panel + co-navigation | Panel · live co-nav · heatmap overlay · **auto-persist provenance per run** | Panel + co-nav + heatmap ✅. **Auto-persist absent → manual "Save ROIs" only.** | 🟡 **Mostly — auto-persist gap** |
| **M5** Eval & hardening | Patho-Bench/SlideBench + ablation grid | Not started | ⬜ **Not begun** |

---

## 2. What is faithful to the plan (the load-bearing skeleton)

These are real, verified, and match the design — they *are* the novel contribution per §14:

- **API surface** under `/api/agent`: `preprocess` (202 `{jobId,cacheKey,status}`), `status`
  (`ready:{features,slidechat,classifiers}`), `query` (SSE), `heatmap` — correct camelCase; `roi` in
  level-0 px. (`gateway/routes.py:34-191`, `common/schemas.py`)
- **Auth**: forwards `Girder-Token`, validates via Girder `/user/me`, per request (§6). (`gateway/auth.py:7-21`)
- **Cache key** = `sha256(PIPELINE_VERSION, item, backbone, consensus, slidechat)[:12]` → `itemId-<hash>`
  (§7). (`common/cache_keys.py:19-31`)
- **LangGraph topology** exactly per §13.2: `router→triage→(navigate⇄describe)*→diagnose→{icv∥fact∥consensus}→summary→END`,
  verify a **true parallel fan-out** writing distinct keys `phi_l`/`phi_k`/`phi_c` (no concurrent-write
  conflict). (`orchestrator/graph.py:44-66`, `orchestrator/verify.py:8-12,103,115,161`)
- **Navigation signal** = query-conditioned CONCH concept-similarity + coverage sampler
  (`0.5·question_sim + 0.5·concept_best`, top-k hotspots + empty-bucket coverage) — precisely §4.3/§5.
  (`orchestrator/perception_subprocess.py:112-138,224-234`, `orchestrator/concepts.py:8-15`)
- **Geometry** = level-0 pixels end-to-end; heatmap raster on the `conch_v1` lattice from h5 attrs,
  emitted with `X-Level0-*` extent; frontend `imageToViewportRectangle`→`fitBounds` co-nav +
  `addTiledImage` overlay (§13.1/§13.3). (`orchestrator/perception_subprocess.py:141-173`,
  `src/components/panels/agentViewerSync.js:7-41`)
- **φ_total** = weighted sum `(0.34,0.33,0.33)` over φ_l/φ_k/φ_c; answer-first ordering (candidates
  stream before scores). (`orchestrator/verify.py:171-182`, `common/config.py:41`)

---

## 3. Material deviations

### 3.1 Model & knowledge substrate — the headline gap

| Plan (§4–§5, §11) | Implemented | Class |
|---|---|---|
| **Reasoning = GPT-4V** (hosted) for router/triage/describe/diagnose/verify | **Local Gemma/MedGemma** via `:11500/chat`; no OpenAI/GPT-4V client anywhere | **Substituted** (sanctioned — §2.1 pluggable reasoner) |
| **SlideChat** slide-level VQA (locked decision #6; a v1 candidate generator) | **Absent.** `ready.slidechat` hard-coded `False`; frontend sends `slidechat:false` | **Missing** (core pillar) |
| **TITAN** zero-shot consensus over `conch_v1.5` | **Absent.** `uni_v1` features → **BRCA ABMIL** `/predict` (IDC vs ILC) | **Substituted + narrowed** |
| **`conch_v1.5`** 2nd CONCH pass | **Never produced** — only `conch_v1` + `uni_v1` | **Missing** |
| **PRISM** (opt) + **CONCH zero-shot** | **Absent** (grep = 0) | **Missing** |
| **KB = WHO + PathologyOutlines over Chroma/pgvector** | **12-entry `seed_kb.json`**, CONCH text-similarity ranked; no vector DB | **Substituted** (interim) |
| **Description = GPT-4V on region pixel crop** (`getRegionImageBlob`) | Local LLM reasons from **patch coordinates + concept affinity — no pixels fetched** | **Substituted (fidelity loss)** |

Evidence: `common/config.py:34-35` (`agent_llm_url=…:11500`, `agent_llm_model="gemma4"`);
`worker/trident_preprocess.py:75` (`slidechat=False`); `worker/classifier_client.py:17,24` +
`common/config.py:27,30` (BRCA ABMIL `:11501`, `uni_v1`); `orchestrator/nodes.py:108-110`
(“v1 does NOT fetch the region's pixels”); `orchestrator/seed_kb.json:1-62` (12 entries).

**The single most consequential fact:** the "consensus" trust signal **φ_c** and the diagnosis `prelim`
are both driven by **one supervised BRCA ABMIL classifier that only distinguishes IDC vs ILC**
(`orchestrator/verify.py:121-168`, `orchestrator/nodes.py:142-165`). On a breast slide the answer is
essentially the classifier's call wrapped in LLM narrative; on any **non-breast** slide there is no
classifier, φ_c falls to a neutral 0.5, and diagnosis rests on a local LLM reasoning purely from
coordinates. **Today the system is a breast IDC/ILC specialist, not the general diagnosis engine the
plan describes.**

**Scope tension:** the plan's line 12 lists **"MIL-based models"** as *out of scope by explicit
instruction* — yet the shipped consensus is an **attention-based MIL (ABMIL)**, now load-bearing for
both φ_c and the primary candidate. Defensible (consumed as a black-box classifier service, not the
core perceiver), but it touches an excluded category and the design doc and code disagree silently.

### 3.2 Agent-loop fidelity gaps (§4)

- **Router** deterministic — hardcoded `task="Diagnosis"`, no GPT-4V routing (`orchestrator/nodes.py:41-49`).
  Acceptable for Diagnosis-only v1; M3b will need the real router.
- **Triage** is a deterministic rule on *classifier presence* only (present→"suspicious/deep/8",
  absent→"uncertain/moderate/4"). The plan's **TITAN zero-shot + quick SlideChat triage pass is absent**
  — triage does no perception (`orchestrator/nodes.py:52-67`).
- **Candidate generators = 2** (classifier + one local-LLM-over-descriptions), not the plan's
  SlideChat + GPT-4V-on-ROIs + classifier consensus. With SlideChat gone there is really **one
  generative candidate** (`orchestrator/nodes.py:131-170`).
- **No pixel grounding** server-side — the "Description agent" never sees tissue; it describes
  coordinates. Undercuts the plan's central "grounded, not hallucinated" value proposition
  (`orchestrator/nodes.py:103-128`).
- **Budget tiers differ**: plan benign~3 / suspicious~8 / hard-cap 12 → actual suspicious=8 /
  uncertain=4, **hard cap 8**, and **no confidence+coverage early-stop** (terminates on region count
  only) (`orchestrator/nodes.py:59-67`, `orchestrator/graph.py:70-83`, `common/config.py:38`).

### 3.3 API contract deltas (§6)

- **Heatmap is a flat PNG + `X-Level0-*` headers, not an "OSD tile source"** — no DZI/IIIF; the plan's
  "DZI beyond ~4k patches" (§12.7) is unimplemented (`gateway/routes.py:154-191`).
- **SSE only, no WebSocket** (plan said "SSE/WebSocket" — SSE-only is acceptable) (`gateway/routes.py:101-151`).
- `query.task` is an unvalidated `str`; the `"auto"|"Diagnosis"` restriction is comment-only
  (`common/schemas.py:94`).
- `status` on an unknown `cacheKey` returns **HTTP 200 with `status:"error"`**, not 404
  (`gateway/routes.py:70-71`).
- **Added beyond plan:** `GET …/classifier` endpoint; `StatusResponse.error` field; heatmap requires
  an extra `cacheKey` query param; preprocess short-circuits to `jobId:"cached", status:"ready"`
  (`gateway/routes.py:54-55,75-98,158`, `common/schemas.py:59`).

### 3.4 Frontend deltas (§8, §13.4)

- **Auto-persist every run (§13.4, a *locked* decision) is absent** — only a manual "Save ROIs"
  button, and even that omits **φ-scores, model/KB versions, and an explicit timestamp** — the exact
  provenance fields §14 wants as versioned eval records
  (`src/components/panels/PathAgentPanel.jsx:445-470`).
- **No heatmap opacity slider** (hardcoded `0.5`; binary on/off) — §8 called for a slider
  (`src/components/panels/agentViewerSync.js:36`).
- **No live annotation-layer highlight** during co-navigation — only `fitBounds` pan/zoom; rectangles
  drawn only on manual save (`src/components/panels/agentViewerSync.js:7-14`).
- **`roiSelectResult` handoff + `getRegionImageBlob` grounding not wired** — the API accepts `roi`
  but the panel always sends `null`; `tilesInfo` unused (`src/api/wsiAgentApi.js:35`, panel grep = 0).
- Minor: store field `agentMessages`→**`agentTrace`** (rename); `agentFollow` not reset on slide
  change; task is a static "Diagnosis" badge, not selectable chips (`src/store/index.js:239,95-96`,
  `src/components/panels/PathAgentPanel.jsx:513-516`).

### 3.5 State / orchestration deltas (§13.2)

- **`control{mode, redirectRoi?}` state entirely absent** — no redirect/steer scaffold (consistent with
  pause-only v1, but the state field the fast-follow needs isn't stubbed).
- **`importanceRef` absent** (surrogated by `task_id` + `nav.raster_extent`).
- **No checkpointer compiled** — the plan's "v1 = in-memory checkpointer" is not wired
  (`grep MemorySaver` = 0; `orchestrator/graph.py:67`). Pause is purely client-side.
- Field renames to snake_case (`item_id`, `cache_key`, `budget.max_regions`) — cosmetic.

---

## 4. How to read these deltas — sanctioned vs. genuine gaps

**✅ Design-sanctioned (the plan explicitly permits):**
- Local Gemma/MedGemma for GPT-4V — §2.1 "reasoning LLM is pluggable," §11 PHI clause. A config swap,
  exactly as intended.
- Diagnosis-only + M3b deferred — §2.9, §9.
- Pause-only take-control — §13.4 "pause-only in v1."
- Seed KB as an interim — the design imagined a real KB; M2a's KB "was never built on this box."

**🟠 Genuine gaps against locked decisions / acceptance criteria:**
1. **SlideChat absent** — contradicts locked decision #6 and removes a v1 candidate generator. *Biggest content gap.*
2. **TITAN / `conch_v1.5` / PRISM / CONCH-zero-shot absent**, replaced by a single narrow BRCA classifier
   — the "consensus" is neither an ensemble nor general.
3. **No pixel-grounded description** — the agent never looks at tissue; weakens the grounding claim.
4. **Auto-persist provenance absent** (§13.4 was locked "auto-persist every run"); manual save lacks
   φ/version metadata.
5. **M1 feature service (ROI/patch-idx → embeddings+crop) absent** — an M1 acceptance sub-item and the
   foundation for the §10 live-ROI fast path.

---

## 5. Impact on the scientific claims (§14) and M5 readiness

§14 is why the plan calls this "a research platform." The M5 ablation grid is:

> SlideChat-only · GPT-4V-thumbnail-only · +navigation(no verify) · +verification(no navigation) · **full merged**

- **Two of the five baselines cannot be run today** — neither **SlideChat** nor a **VLM/GPT-4V-on-thumbnail**
  is deployed. The headline claim ("navigation + verification > either alone, vs a single-MLLM baseline")
  is currently **untestable** without standing up SlideChat + a vision-language reasoner.
- **Axis-2 calibration** (does φ_total predict correctness?) is already weak — φ_k came back 0.0 on the
  real BRACS_1648 run because the 12-entry seed KB is too thin for the reasoner to find support (M3 report §4).
- **Axis-3 navigation hit-rate** *is* runnable now (the navigation signal is real) — the most defensible
  near-term result.

**Bottom line:** the eval *harness* has real signals to measure for navigation, but the comparative
*baselines* the paper's headline depends on don't exist yet.

---

## 6. Recommendations (ranked by leverage for the research story)

1. **Deploy SlideChat** (Apache-2.0, downloadable, ~24 GB — the A6000 fits). Restores locked decision #6,
   adds a second real candidate generator, unlocks the SlideChat-only baseline. *Highest value.*
2. **Add pixel-grounded description** — fetch Girder `/tiles/region` crops so `describe` (and a VLM
   candidate) actually see tissue. Also the §10 live-ROI foundation; restores the grounding claim.
3. **Wire auto-persist provenance** (§13.4) writing φ-scores + model/KB versions + timestamp — cheap,
   and doubles as the versioned eval record §14 needs.
4. **Decide the consensus story deliberately:** either add TITAN/`conch_v1.5` (the designed zero-shot
   ensemble) or **explicitly re-scope φ_c** to "a supervised breast classifier" in the design doc — and
   reconcile with the "MIL out of scope" line. Code and plan currently disagree silently.
5. **Broaden the KB** beyond 12 seed entries (the φ_k=0 calibration problem is a direct consequence).
6. Smaller: heatmap opacity slider; DZI heatmap path for large slides; `task` enum validation;
   item-level authorization (carried since M1).

---

## Appendix — evidence index (representative file:line anchors)

| Claim | Anchor |
|---|---|
| Reasoning LLM = local Gemma/MedGemma, no GPT-4V | `common/config.py:34-35`; `orchestrator/llm_client.py:71-101` |
| SlideChat absent; `ready.slidechat=False` | `worker/trident_preprocess.py:75`; `worker/fake_preprocess.py:34` |
| Consensus = UNI + BRCA ABMIL, not TITAN | `worker/classifier_client.py:17,24`; `common/config.py:27,30`; `common/schemas.py:62-76` |
| `conch_v1.5`/TITAN/PRISM absent (grep = 0) | src-wide |
| Describe reasons from coords, no pixels | `orchestrator/nodes.py:103-128` (note `:108-110`) |
| KB = 12-entry seed, no vector store | `orchestrator/seed_kb.json:1-62`; `orchestrator/kb.py:67-94` |
| Graph topology + parallel verify fan-out | `orchestrator/graph.py:44-66`; `orchestrator/verify.py:8-12` |
| Navigation = query+concept CONCH similarity | `orchestrator/perception_subprocess.py:224-234`; `orchestrator/concepts.py:8-15` |
| Level-0 geometry + heatmap raster | `orchestrator/perception_subprocess.py:141-173`; `src/components/panels/agentViewerSync.js:7-41` |
| No checkpointer compiled | `orchestrator/graph.py:67` |
| Auto-persist absent → manual save only | `src/components/panels/PathAgentPanel.jsx:445-470` |
| Feature service (ROI/patch-idx → embeddings+crop) absent | no gateway route / worker fn |
| Heatmap = flat PNG, not tile source | `gateway/routes.py:154-191` |

*Report generated 2026-07-08. All anchors verified against the working tree on branch `chen`.*
