# PathAgent v2 — Conversational Pathology Copilot · Architecture

> **Status:** Canonical architecture (design-locked on the four forks below). Supersedes
> `2026-07-15-pathagent-v2-tissuelab-pattern-plan.md` (which remains valid for removal blast-radius
> and repo mechanics) and all M0–M4 PathAgent reports.
> **Date:** 2026-07-16 · **Author:** Chen (with Claude)
> **Background:** `2026-07-14-cpath-toolbox-agent-literature-review.md`

---

## 1. Vision & scope

Build an agent that **eventually helps pathologists**: a **conversational, multi-turn** copilot that
**reads the slide**, understands intent, does **deep quantification with tools**, **remembers**, and
carries the conversation into follow-ups and further execution — including **long-horizon** tasks.

This is the **assistant / quantification** agent, explicitly **not** the discovery agent
(NOVA / TissueLab `autoresearch`). Those help a *researcher* mine a cohort; this helps a *pathologist*
at the microscope.

**Design invariant (protect at all costs): no per-task code branches.** A clinical task (TILs,
cellularity, grade…) is an emergent *composition* of tools + knowledge + a report template, chosen by
the planner. If a task needs a hardcoded pipeline, the architecture has failed.

---

## 2. Forks locked (2026-07-15/16)

| Fork | Decision |
|---|---|
| Take TissueLab | **Port the pattern, own the code** (clean-room; no Penn source in-tree) |
| First tools | **CellViT++** (nuclei seg + classification) → **Histolytics** (spatial stats) |
| Code-gen | **Keep, but sandboxed** |
| Commercial | **Undecided** → default license-safe |
| Perception | **Hybrid.** Brain = **Claude**. Pathology VLM (**SlideChat**, Apache-2.0) = a *tool* for comprehensive slide reading. CPath models = all quantification. |
| Memory scope (v1) | **Within-case** |
| Autonomy (long tasks) | **Checkpoint-and-confirm** per sub-goal |
| Target task | **TILs first, then expand** (see §7 expansion model) |

---

## 3. Control architecture — four nested loops

Each loop runs at the granularity its actions can afford (actions here cost **GPU-minutes**, so plan-first
beats greedy ReAct):

```
Conversation loop        turns; days        ← holds MEMORY, carries follow-ups
  └─ Task loop           request→answer     ← plan → HUMAN APPROVES → execute → observe → re-plan
       └─ DAG            one pipeline        ← validated segment→classify→spatial-stats
            └─ Sandbox   code→run→fix        ← the ONLY tight autonomous loop (sub-second, side-effect-free)
```

- **Conversation** — the outer layer your vision adds; multi-turn, memory-backed.
- **Task** — human-gated: a pathologist approves a **plan artifact** before GPU-minutes are spent.
- **DAG** — statically validated (`produces ⊇ consumes`) before running; broken plans die in ms, not min.
- **Sandbox** — code-gen self-repair; the one place a tight loop is economically safe.
- **Surprise check** — after each step, one cheap Claude call over the *result summary*: "does this
  invalidate the rest of the plan?" (e.g. no tumour cells → halt, surface, re-plan). Converts the DAG's
  worst failure mode — confidently computing stats over nothing — into an **abstention**.

---

## 4. Perception — how it reads the slide

Two distinct visual jobs, never conflated:

| Job | Who | Notes |
|---|---|---|
| **Reasoning / orchestration / intent / coreference / answer synthesis** | **Claude (brain)** | Also does targeted ROI-crop visual reasoning for the surprise-check + grounding |
| **Comprehensive qualitative slide/region reading** | **Pathology VLM tool** (SlideChat) | A *registry tool* the brain calls — `describe_region` / `read_slide`. Specialist morphology read a general VLM misses |
| **Quantification (the numbers)** | **CPath model tools** | CellViT++, Histolytics. **The VLM never counts** — VLMs hallucinate counts |

The brain orchestrates: VLM to *understand*, tools to *measure*, verifier to *bind claims to measurements*.
That binding is the trust differentiator over a pure pathology-VLM chatbot.

---

## 5. Memory — within-case, grounded on Zarr

**Substrate insight:** Zarr is grounded memory. Tool outputs live in the case Zarr store; memory holds
**references + NL summaries** pointing into it (and into Girder annotations). Five layers:

1. **Working** — live transcript; bounded, summarized when long.
2. **Case blackboard** — the structured heart:
   `{slides, ROIs_examined, tool_runs:[{tool,args,output_ref→Zarr,summary,confidence,ts}],
     findings:[{claim, evidence_refs}], open_questions}`. Persisted per case (Girder provenance doc + Zarr).
3. **Result cache (content-addressed)** — `key = tool + args + slide + model_version`. Makes follow-ups
   and long-horizon **affordable** (TissueLab's `preProcessed` idea, generalized to the whole conversation).
4. **Knowledge** — RAG over pathology guidelines (WHO / CAP / grading rubrics), cited.
5. **User / procedural** — preferences + habitual workflows; feeds planner + answer style.

**Follow-up = coreference over the blackboard + cache hit (no recompute):**
> "Count the tumour cells." → CellViT++ → 1,240 → written to `Zarr:/CellViT`, logged in blackboard.
> "What fraction are near lymphocytes?" → resolve *"them"* → existing segmentation → run **only** the
> spatial step. Seconds, not minutes.

**Long-horizon = task tree + checkpoint-and-confirm:**
> "Grade this case" → {survey → find tumour → mitoses in hotspots → tubules → pleomorphism → combine};
> each sub-goal is a plan→DAG; progress persisted (survives turns, resumable); the agent **checkpoints and
> reports at each sub-goal** (safety gate + resume point).

*Roadmap (post-v1): per-patient / cross-case + episodic ("last week on this patient…").*

---

## 6. The full harness (12 subsystems)

**Control:** (1) Conversation manager — turn loop, intent router (chat/quantify/follow-up/clarify), streaming.
(2) Planner + task manager — intent→DAG, long-horizon decomposition, checkpointing, re-plan.

**Cognition:** (3) Memory (§5). (4) Perception (§4). (5) Knowledge base — guideline RAG, cited.

**Execution:** (6) Tool registry + node runtime — CellViT++, Histolytics, pathology-VLM read tool, read/query
tools, sandboxed code-gen.

**Trust:** (7) Verification — bind every quantitative claim to a tool output; calibrate; **abstain** out of
scope. (8) Provenance/audit — every run + claim → evidence (Zarr ref, annotation, citation, region),
persisted to Girder; reproducible; doubles as eval record. (9) Safety/compliance — PHI de-id before egress;
**"research use only, not a diagnostic device"**; guardrails; audit logging.

**Human:** (10) HITL — plan approval, active-learning relabel→retrain, corrections→memory, pause/redirect.
(11) Viewer integration — co-navigation, WebGL overlays, result rendering.

**Measurement:** (12) Eval harness — task accuracy vs ground truth, calibration, reader study. Per-task cost
that never goes away; also the publishable claim.

---

## 7. The expansion model (TILs → N tasks stays cheap)

Tasks emerge from composition; expansion grows three axes:

- **Tools** — add a registry node; planner auto-discovers it (registry → prompt catalog). Integration cheap;
  *building* a new model isn't, but it's isolated.
- **Knowledge** — add the rubric/guideline to the KB. Makes the agent *correct* on the new task. Just docs.
- **Cell classes** — retrain CellViT++'s lightweight head (what it's built for; fed by active learning).

**Honest economics:** integration cheap, composition free, but **new capabilities (models) and trust
(per-task validation) cost real work.** Expansion ladder, by new-capability cost:

| Rung | Needs | Cost |
|---|---|---|
| **TILs %** + TLS | CellViT++ + Histolytics + ITWG rubric | v1 — nothing new |
| Tumour cellularity % | same seg, ratio | ~free |
| Nuclear pleomorphism / morphometry | + HistomicsTK features (in Girder stack) | cheap tool add |
| Spatial TME profiling | + Histolytics stats | cheap |
| Mitotic count /10 HPF | **new** mitosis model | real tool build |
| IHC quant (Ki-67, ER/PR/HER2) | **new** IHC branch (CellViT++ is H&E) | real new capability |
| Nottingham grade | *composes* tubule + pleomorphism + mitosis | ~free — long-horizon reuse |

The payoff: the first four rungs reuse v1 tools; only mitosis + IHC are real builds; grading then falls out
of composition for free.

---

## 8. Build order — one vertical thread, then widen

Build the **spine end-to-end on one task**, not a bit of every subsystem.

- **v1 — conversational spine + TILs.** Conversation manager + case blackboard + result cache + tool chain
  (CellViT++ → Histolytics) + plan approval + grounded-answer verification + provenance. **Proof = the
  follow-up:** "count lymphocytes" → "are they clustered?" → "show me where" — three turns, shared memory,
  no recompute. Validate the TILs number against the ITWG rubric.
- **v2 — perception + knowledge.** Add the SlideChat read-tool (comprehensive slide reading, surprise-check,
  navigation) + guideline KB with citations.
- **v3 — long-horizon + active learning.** Task-tree decomposition + checkpointing; relabel→retrain feeding
  memory + CellViT++ head. First composed task: Nottingham-style grade.
- **v4 — trust/compliance/eval hardening** for real pathologist use.

Milestone mechanics (removal blast radius, repo layout, node `/init`→`/read`→`/execute` contract, registry
schema, SSE vocabulary, Vite `/api/agent` proxy ordering) carry over from the 07-15 plan §5–§7.

---

## 9. Removal (confirmed) & first cut

Remove the **entire current AI surface** — the new Agent panel becomes the sole one:
`services/pathagent/`, Trident preprocessing, the BRCA classifier (`/api/brca`), and PathChat/AskPA
(`PathChatPanel.jsx`, `claudeApi`/`geminiApi`), plus the frontend agent slice/tab/rail. (github/ clones of
TRIDENT, TissueLab, WSI-Agents stay on disk as reference.)

New home: `services/agent/` (ours) — gateway (Girder auth) · registry · planner · scheduler(RQ+Redis) ·
memory(Zarr) · sandbox · nodes/{cellvit, histolytics, slidechat}. Frontend: `src/components/panels/agent/`
+ `src/store/agentSlice.js` + WebGL `NucleiOverlay`.

---

## 10. Risks / open items

- **CellViT++ = Apache-2.0 + Commons Clause (resale-restricted).** Fine internally; blocks commercial resale.
  Registry keeps `license` per tool; StarDist/InstanSeg are cleaner fallbacks. Commercial intent undecided →
  stay swappable.
- **GPU**: CellViT++ + SlideChat both need GPU; confirm hardware (same host, direct assetstore — locked).
- **Sandbox is security-critical** — hard gate before any multi-user exposure.
- **Zarr multi-user** — `ProcessSynchronizer`.
- **Pathologist collaborator** is the binding constraint for task choice + "what's a good answer." TILs is the
  self-validating default (ITWG rubric) until a collaborator's real pain point overrides it.
- **Clean-room hygiene** — pattern learned from TissueLab; cite the paper; write our own code.
