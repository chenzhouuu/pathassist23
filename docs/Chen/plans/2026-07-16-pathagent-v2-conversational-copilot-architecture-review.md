# PathAgent v2 — Conversational Pathology Copilot Architecture Review

> **Review status:** Architecture review — changes required before design lock
>
> **Review date:** 2026-07-16
>
> **Reviewed document:** [`2026-07-16-pathagent-v2-conversational-copilot-architecture.md`](./2026-07-16-pathagent-v2-conversational-copilot-architecture.md)
>
> **Review perspective:** LLM Agent architecture, computational pathology, clinical trust, evaluation, security, and repository feasibility
>
> **Scope:** Read-only review; the source architecture document was not modified

---

## 1. Executive conclusion

**Recommendation: approve the direction, but do not implement the architecture as currently written.**

The document captures the correct spine for a pathology copilot:

- the LLM understands intent, plans, and carries the conversation;
- specialist computational-pathology models perform measurements;
- a DAG controls expensive computation;
- artifact references and caching make multi-turn follow-up affordable;
- provenance and verification constrain final answers;
- human approval controls higher-risk and long-running work.

However, the current design is closer to a **research-oriented pathology toolbox agent** than a clinically governed copilot. It should be changed from **Canonical / design-locked** to an **Architecture RFC** until the blocking issues in this review are resolved.

If implemented unchanged, the system could produce an impressive conversational demonstration while still failing in four fundamental areas:

1. the proposed CellViT++ → Histolytics pipeline does not implement the clinical definition of stromal TILs;
2. unrestricted task composition conflicts with the validation boundary of clinical tasks;
3. Zarr is being asked to provide transaction and workflow semantics it does not have;
4. the perception, deployment, and licensing assumptions contradict the selected toolchain and the current repository.

---

## 2. Design decisions worth preserving

### 2.1 Clear product boundary

Separating an assistant/quantification agent from a cohort-discovery agent is a strong product decision. It prevents the system from drifting between two workflows with different users, risks, and evaluation targets.

### 2.2 Cost-aware nested control loops

The conversation → task → DAG → sandbox hierarchy is a useful mental model. Plan-first execution is better suited to GPU-minute operations than a greedy, high-frequency ReAct loop.

### 2.3 Qualitative and quantitative perception are separated

The rule that VLMs may help interpret morphology while computational-pathology tools produce measurements is sound. In particular, the explicit statement that the VLM must not perform counting should be retained.

### 2.4 Artifact references and follow-up reuse

Keeping large outputs out of the LLM context and passing references to masks, contours, embeddings, and statistics is appropriate for WSI-scale data. The proposed follow-up demonstration—count → clustering → show locations—is a good end-to-end test of memory, grounding, and cache reuse.

### 2.5 Trust concepts are visible at the architecture level

HITL, abstention, provenance, evidence binding, and evaluation are present in the top-level design rather than being treated as UI details. They need stronger execution semantics, but their inclusion is correct.

---

## 3. P0 — blocking issues before implementation

## 3.1 “No per-task branch” must not mean “no task-specific protocol”

**Source:** architecture document L21–23 and L132–153.

The current invariant is too absolute. The architecture should prohibit duplicated, imperative, task-specific branches inside the core orchestrator. It should not prohibit versioned clinical protocols.

A clinical task is not merely:

```text
tools + retrieved knowledge + report template
```

It also includes an intended use, specimen and stain eligibility, inclusion and exclusion rules, sampling policy, denominator, units, scoring logic, quality gates, and a validated set of model versions. Letting the planner reconstruct those semantics from RAG at runtime creates an unbounded validation space.

### Recommendation: introduce two strongly separated modes

#### Research / exploratory mode

- permits dynamic tool composition;
- may permit sandboxed code generation;
- may use experimental tools;
- results are explicitly exploratory;
- results cannot silently enter a governed clinical report.

#### Validated mode

- executes only a signed, versioned `TaskContract`;
- uses approved tool/model/guideline versions;
- lets the planner bind parameters and select only approved equivalent paths;
- does not let the planner invent a new clinical pipeline;
- requires revalidation when the contract or allowed implementation changes materially.

A minimal `TaskContract` should include:

```text
task_id / version
intended_use
supported cancer, specimen, stain, scanner, and preparation
inclusion / exclusion rules
ROI and sampling policy
numerator / denominator / units
required artifact types and ontologies
allowed tool + model + guideline versions
input QC / OOD / abstention rules
scoring logic
report schema
validation_report_id
```

### Recommended replacement invariant

> The core execution engine contains no task-specific imperative business branches. Governed tasks are defined by versioned, declarative TaskContracts; exploratory mode may dynamically compose eligible tools but cannot produce validated clinical claims.

This preserves platform generality without removing the protocol boundary needed for validation.

---

## 3.2 CellViT++ → Histolytics does not directly produce ITWG stromal TILs

**Source:** architecture document L32, L38, L144, L161–164, and L197–198.

This is the most important factual problem in the current design.

The International TILs Working Group defines stromal TILs as the percentage of intratumoral stromal area occupied by mononuclear inflammatory cells within the borders of invasive tumor. The denominator is stromal area, not inflammatory-nucleus count divided by total-nucleus count. The method also excludes inflammation around DCIS and normal lobules, tumor-external inflammation, necrosis, crush artifact, regressive hyalinization, and previous biopsy sites. See the [International TILs Working Group recommendations](https://pmc.ncbi.nlm.nih.gov/articles/PMC6267863/).

The proposed pipeline is missing at least:

- invasive tumor boundary detection or pathologist confirmation;
- intratumoral stroma segmentation;
- necrosis, artifact, DCIS, normal structure, and other exclusion masks;
- a cell ontology matching the mononuclear-cell inclusion/exclusion rules;
- whole-assessment-region sampling and heterogeneity handling;
- an area-based denominator;
- calibration and validation for this intended use.

Histolytics cannot fill these semantic gaps using spatial statistics alone. Its official TIL example consumes existing tissue-segmentation data and demonstrates cell counts, density, interfaces, grids, and spatial graphs rather than a validated ITWG stromal-TIL score. See the [Histolytics TIL workflow](https://hautaniemilab.github.io/histolytics/user_guide/workflows/TIL_workflow/).

TLS should also be separated from stromal TILs. The Histolytics TLS workflow describes a simple size/density heuristic for **potential TLSs**, and notes that germinal-center identification may require additional analysis. See the [Histolytics TLS workflow](https://hautaniemilab.github.io/histolytics/user_guide/workflows/tls_lymphoid_aggregate/).

### Recommended v1 scope

Choose one of two honest definitions:

#### Option A — technical Agent-spine proof, recommended first

```text
Pathologist-selected ROI
→ inflammatory-cell detection/classification
→ count and density
→ clustering/spatial statistics
→ overlay
→ conversational follow-up without recomputation
```

Do not label the result as ITWG-compatible `sTIL %`.

#### Option B — governed TIL assay

Add or require pathologist confirmation of:

- invasive tumor assessment region;
- stromal compartment;
- exclusion regions;
- relevant inflammatory-cell classes;
- coverage and slide-quality acceptability.

Then implement a versioned TIL TaskContract and validate the full end-to-end assay.

The statement that TILs is “self-validating” should be removed. A guideline defines a method; it is not ground truth.

---

## 3.3 Zarr is an artifact plane, not a workflow or memory database

**Source:** architecture document L79–103, L118–119, and L196.

“Zarr is grounded memory” is a useful intuition but an unsafe storage boundary. Zarr is appropriate for:

- masks;
- embeddings;
- dense arrays;
- contours and image-derived tensors;
- large immutable derived artifacts.

It is not a sufficient source of truth for:

- conversations and turns;
- task and plan state;
- approvals;
- long-horizon checkpoints;
- claim lifecycle;
- concurrent blackboard updates;
- cache indexes;
- atomic commits spanning several artifacts;
- cross-day recovery and migrations.

`ProcessSynchronizer` provides file locking for processes that share a filesystem. It does not provide database transactions, multi-artifact atomic publication, or general object-store consistency. See the [Zarr synchronization documentation](https://zarr.readthedocs.io/en/v2.16.1/api/sync.html).

### Recommended storage split

#### Transactional control store

Stores:

- conversation events;
- task/goal state;
- plan revisions and approvals;
- step attempts and leases;
- case blackboard facts;
- artifact manifests and lineage;
- claims and evidence links;
- cache index and invalidation state.

#### Girder

Remains source of truth for:

- original slides;
- case permissions;
- user-authored annotations;
- viewer-visible clinical objects.

#### Immutable artifact store

Uses Zarr, Parquet, GeoParquet, or object blobs according to artifact shape. A run writes to a temporary run-specific namespace, validates checksum/schema/QC, and atomically publishes a `COMMITTED` manifest. Published artifacts should never be overwritten.

#### Redis

Used for:

- execution queue;
- short-lived leases;
- progress and ephemeral coordination;
- distributed locks where appropriate.

Redis should not be the long-term workflow truth source.

### Blackboard lifecycle

The blackboard should be a materialized projection of an immutable event log. Facts and findings need lifecycle states such as:

```text
proposed
observed
verified
corrected
retracted
superseded
```

Natural-language summaries must never become the authoritative scientific record.

### Cache identity

The proposed cache key is incomplete. A reliable key should include:

```text
tool image digest
+ code and dependency digest
+ model weight digest
+ canonical parameters including defaults
+ ordered upstream artifact digests
+ slide content digest
+ normalized ROI + coordinate space + MPP
+ preprocessing/schema/ontology/calibration versions
+ TaskContract version
+ random seed where relevant
```

Cache hits must also pass ACL, artifact-integrity, and stale-input checks.

---

## 3.4 The DAG must be semantically typed, not only structurally connected

**Source:** architecture document L54–60 and L109–115; inherited 2026-07-15 plan L139–190.

`produces ⊇ consumes` catches only the simplest structural errors. Real compatibility includes:

- artifact schema URI and version;
- modality, stain, specimen, and organ;
- cell/tissue ontology;
- slide and ROI identity;
- coordinate frame and orientation;
- px, µm, mm², and other units;
- MPP and magnification;
- sampling and coverage semantics;
- cardinality and completeness;
- QC status;
- validated application domain.

The correct control flow should be:

```text
User intent
  → LLM produces TaskSpec
  → TaskContract resolution
  → eligibility-filtered capability retrieval
  → deterministic typed-DAG compiler
  → schema + semantic + policy + resource validation
  → plan-digest approval
  → durable workflow state machine
  → stateless tool invocations
```

The LLM should not directly produce the final executable graph.

### Tool invocation contract

The inherited `/init → /read → /execute {}` lifecycle relies on hidden node state. Hidden state makes concurrency, retries, audit, and multi-tenant isolation more difficult.

Prefer a stateless asynchronous invocation contract:

```text
POST /invocations
  {invocation_id,
   tool_ref@immutable_digest,
   input_artifact_refs,
   normalized_params,
   output_namespace,
   idempotency_key}

GET  /invocations/{id}
POST /invocations/{id}/cancel
GET  /invocations/{id}/events?after=sequence
```

`ArtifactRef` should be an opaque, authorization-checked identifier. The planner and sandbox should not receive arbitrary filesystem or Zarr paths.

### Long-running execution semantics

RQ may remain the executor, but it should not be the source of truth for a multi-day workflow. The controller must persist workflow state independently of worker and SSE lifetimes.

A minimum task state machine is:

```text
RECEIVED
  → RESOLVING_CONTEXT
      → NEEDS_CLARIFICATION
      → SPECIFIED
  → PLANNING
  → VALIDATING
      → PLAN_INVALID / POLICY_DENIED
      → AWAITING_APPROVAL
  → APPROVED
  → QUEUED
  → RUNNING
      → RETRY_SCHEDULED
      → PAUSED_CHECKPOINT
      → PLAN_PATCH_PROPOSED
      → AWAITING_REAPPROVAL
      → CANCELLING / CANCELLED
  → OUTPUT_VALIDATING
  → CLAIM_BUILDING
  → CLAIM_VALIDATING
      → PARTIAL / ABSTAINED
      → COMPLETED
```

Each approval should bind:

```text
plan_digest
input_snapshot_digest
allowed retries
allowed equivalent tool substitutions
maximum cost and elapsed time
data-egress scope
code-generation allow/deny
approval expiry
```

A replan outside that envelope must display a plan diff and require new approval.

SSE is a transport, not persistent state. Events need `event_id`, monotonic sequence, task/plan revision, replay support, and a separate snapshot endpoint.

---

## 3.5 Surprise checks and verification do not yet establish safety

**Source:** architecture document L58–60, L70–75, and L117–126.

Using the same Claude model to plan, inspect summaries, perform the surprise check, and synthesize the answer creates common-mode failure. A summary may also omit the spatial or quality signal that should have stopped the run.

### Recommended order of safety checks

1. deterministic preconditions;
2. slide/stain/MPP/specimen checks;
3. tissue coverage and image-quality checks;
4. empty-result, range, units, ontology, and completeness checks;
5. OOD and model-disagreement checks;
6. partial-run and artifact-integrity checks;
7. LLM interpretation only for residual, unclassified anomalies.

“No tumor cells detected” must not be converted into “there is no tumor.” The safe output is that the system could not reliably detect tumor and stopped the analysis.

### Separate three meanings of trust

- **Faithfulness:** did the answer accurately represent tool output?
- **Analytical validity:** did the tool measure the intended quantity correctly?
- **Clinical validity:** is that measurement valid and useful for the declared task and population?

Evidence binding directly addresses only the first one.

### Claim-first answer generation

Quantitative claims should be created from canonical result objects and rendered deterministically:

```text
Claim {
  subject,
  predicate,
  value,
  unit,
  specimen/slide/ROI scope,
  evidence_artifact_ids,
  method/tool/TaskContract versions,
  uncertainty,
  verification_status
}
```

The LLM may explain the claim, but should not copy or recalculate the authoritative numerical value from prose.

---

## 3.6 Code generation must be separated from governed clinical execution

**Source:** architecture document L33, L51, L57, L114–115, and L195.

Code generation has two independent risks:

1. **security risk:** file access, secrets, network egress, resource exhaustion, interpreter/runtime escape;
2. **scientific risk:** wrong formulas, wrong units, invalid statistics, misleading plots, or plausible but unsupported results.

Read-only input and no network do not solve the second risk.

### Recommendation

- disable code generation in validated v1;
- prohibit generated code from producing final governed claims;
- use an approved aggregation/query DSL for common analyses;
- allow code generation only in research mode with explicit approval;
- promote useful repeated generated analyses into reviewed registry tools.

The sandbox should use a strongly isolated non-root container or microVM with:

- no secrets;
- no network;
- read-only rootfs and input snapshot;
- dedicated scratch/output directory;
- dropped Linux capabilities;
- seccomp/AppArmor or equivalent policy;
- PID, CPU, RAM, GPU, wall-time, and output-size limits;
- fixed dependency lockfile and image digest;
- no runtime package installation;
- static policy scan before execution;
- output-schema and scientific-QC validation afterward.

The “sub-second, side-effect-free” characterization should be removed as an architectural assumption.

---

## 3.7 SlideChat has a missing preprocessing chain and overstated coverage semantics

**Source:** architecture document L35, L64–75, L165–166, and L178–185.

The architecture adds SlideChat while deleting Trident preprocessing. SlideChat's public workflow does not directly consume a raw WSI. Its input is a sequence of patch representations, with the documented implementation using 512-dimensional CONCH patch features. The public repository also does not natively provide the exact `describe_region` contract assumed by the architecture. See the [SlideChat repository](https://github.com/uni-medical/SlideChat).

The missing path is at least:

```text
slide snapshot
→ WSI QC and tissue mask
→ patch grid and multiscale sampling
→ CONCH-compatible embedding
→ SlideChat slide observation
```

Region reading additionally requires a defined mapping from ROI to patch embeddings and validation that the modified input remains within the model's application domain.

`read_slide` should not claim “comprehensive truth.” It should emit a sampled observation:

```text
Observation {
  text,
  sampled_regions,
  magnifications,
  coverage_map,
  coverage_ratio,
  skipped_regions,
  uncertainty_or_OOD,
  model_and_input_versions
}
```

Claude ROI observations, SlideChat observations, and quantitative results may disagree. Disagreement should create an open question, request pathologist review, or trigger abstention—not be silently adjudicated by the same LLM.

Claude should be represented by a `ReasonerProvider` interface with a pinned model identifier, prompt digest, egress policy, and upgrade evaluation, rather than being the architecture itself.

---

## 3.8 The selected stack is not “license-safe by default”

**Source:** architecture document L34–35 and L191–193.

The license field in a registry is necessary but insufficient.

- SlideChat code is Apache-2.0, but its documented inference pipeline uses CONCH features. The public CONCH model card restricts the model and associated code to non-commercial academic research under CC-BY-NC-ND 4.0. See the [CONCH model card](https://huggingface.co/MahmoodLab/CONCH).
- CellViT++ licensing is component-specific. SAM-derived components are Apache-2.0, while HIPT-derived components and original/inference code contain commercial restrictions. See the [CellViT++ license](https://github.com/TIO-IKIM/CellViT-plus-plus/blob/main/LICENSE).

Therefore, “commercial undecided → default license-safe” conflicts with both primary model choices. The document should not conclude that internal use is automatically safe or that the restriction is limited to simple resale; final interpretation requires legal review of the exact component, model weight, deployment, and entity.

The registry should record:

```text
code_license
weight_license
dependency/model licenses
training-data terms
redistribution restrictions
hosted-service restrictions
derivative-model restrictions
attribution requirements
approved use cases
legal_review_status
```

A software bill of materials and model bill of materials should be generated for each validated TaskContract.

---

## 3.9 Trust, compliance, and evaluation cannot wait until v4

**Source:** architecture document L117–126 and L157–170.

The first pathologist-visible version already handles patient-level slides, runs models, persists conversations, and presents measurements. Security, data governance, basic evaluation, and input-QC cannot be deferred until a later hardening milestone.

Minimum v1 foundations should include:

- explicit intended use and hazard analysis;
- per-field data-flow and PHI threat model;
- item/case/tenant authorization;
- input QC and hard abstention;
- immutable provenance manifests;
- locked model and prompt versions;
- component and end-to-end tests;
- cache-invalidation tests;
- crash, retry, resume, cancellation, and SSE-reconnect tests;
- audit and incident records.

“Research use only, not a diagnostic device” is a label, not a technical or regulatory control. Actual intended use and workflow determine the applicable obligations. The FDA's current guidance also distinguishes software that merely supports an independently reviewable recommendation from software that provides patient-specific diagnostic output. See the [FDA Clinical Decision Support Software guidance, January 2026](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/clinical-decision-support-software) and [FDA Good Machine Learning Practice principles](https://www.fda.gov/medical-devices/software-medical-device-samd/good-machine-learning-practice-medical-device-development-guiding-principles).

This review is not legal advice; regulatory and privacy counsel should evaluate the declared intended use and deployment.

---

## 4. P1 — high-priority improvements before a pathologist pilot

## 4.1 Calibration and abstention need implementable definitions

A single `confidence` value cannot represent all uncertainty. Separate at least:

- cell-classification calibration;
- segmentation and slide-QC quality;
- sampling coverage;
- final task-level measurement interval;
- claim evidence status.

Useful metrics include:

- Brier score, ECE, and reliability curves at cell level;
- empirical interval coverage at case/task level;
- selective risk–coverage curves;
- failure-to-abstain rate on unsupported or OOD cases.

Hard abstention rules should cover wrong stain/organ/specimen, missing MPP, insufficient tissue, unreliable tumor/stroma identification, severe artifacts, low cell count, OOD, model disagreement, partial tool failure, stale cache, and inapplicable guideline/task contract.

Every abstention should explain the reason and the next safe action.

## 4.2 HITL needs risk-based approvals, not repetitive confirmations

Approval at every sub-goal risks confirmation fatigue. A pathologist approving a list of tool names also does not necessarily understand the denominator, excluded tissue, coverage, or intended output.

The plan card should foreground:

- specimen/slide/ROI scope;
- numerator and denominator;
- inclusion and exclusion rules;
- tissue coverage;
- expected output and uncertainty;
- estimated time/GPU cost;
- data egress;
- material changes from the prior plan.

Only changes to specimen, ROI, clinical definition, output use, egress, cost envelope, or high-risk capability should require blocking confirmation. Cached reads and reversible low-risk operations may execute within the approved envelope.

Result states should be explicit:

```text
draft / unreviewed / reviewed / accepted / overridden / abstained
```

## 4.3 Coreference must bind explicit scientific scope

The follow-up term “them” should resolve to a tuple such as:

```text
case + specimen + block + slide + ROI + artifact version + cell class
```

When several candidates exist, the system must ask for clarification. The UI should show the resolved referent before expensive execution.

The real pathology hierarchy should be represented:

```text
patient → case → specimen → block → slide → region
```

Every claim should state whether it applies to a region, slide, block, specimen, or full case.

## 4.4 Within-case memory conflicts with user/procedural memory

The architecture says v1 memory is within-case, but also proposes persistent user/procedural memory. User preferences are cross-case data and require separate consent, retention, deletion, and access policies.

User memory may influence presentation style, default visualization, or approval preferences. It must not change clinical definitions, thresholds, scoring rules, or validated tool eligibility.

## 4.5 Tool discovery needs lifecycle and eligibility filtering

Adding a tool to the registry must not automatically expose it to a validated planner. Recommended lifecycle:

```text
experimental → evaluated → validated-for-domain → approved → deprecated/disabled
```

Before LLM selection, filter tools deterministically by modality, stain, specimen, input artifacts, ontology, license, deployment, resource availability, and TaskContract approval. Then give the LLM a small eligible catalog rather than the entire registry.

## 4.6 RAG is not “just docs”

Guideline retrieval can ground explanations and citations but cannot by itself make an analysis correct. Controlled knowledge should record:

- document and section version;
- cancer/specimen applicability;
- jurisdiction and effective date;
- copyright/use rights;
- retrieval provenance;
- supersession and expiration.

Critical scoring rules should be compiled into versioned TaskContracts rather than reconstructed from retrieved prose on every run.

## 4.7 Active learning requires model governance

A pathologist correction must not directly retrain and deploy a production model. Separate:

1. correction of the current case result;
2. creation of a candidate training annotation;
3. development and release of a new model version.

New model promotion requires dataset versioning, annotation QA/adjudication, independent holdout evaluation, regression tests, approval, rollback, and generation of a new weight digest. Dependent cache entries and claims must become stale when the model or ontology changes.

Reader-study and test cases must not silently flow back into training.

## 4.8 GPU scheduling needs resource semantics

A registry field such as `device: gpu` is insufficient. The scheduler needs:

- VRAM estimates and admission control;
- GPU and model residency policy;
- queue priorities and tenant quotas;
- cancellation and, where possible, preemption;
- OOM and transient-failure policies;
- concurrency limits per model/device;
- cost and utilization telemetry.

SlideChat and CellViT++ should not be assumed to coexist on a single GPU without benchmarking and capacity planning.

---

## 5. Repository and deployment feasibility findings

## 5.1 Do not delete `services/pathagent/` first

The current service already contains reusable infrastructure:

- [`gateway/auth.py`](../../services/pathagent/src/pathagent/gateway/auth.py) — Girder token validation;
- [`gateway/queue.py`](../../services/pathagent/src/pathagent/gateway/queue.py) — Redis/RQ integration;
- [`gateway/routes.py`](../../services/pathagent/src/pathagent/gateway/routes.py) — POST + SSE streaming;
- [`worker/slide_resolver.py`](../../services/pathagent/src/pathagent/worker/slide_resolver.py) — local/Girder slide materialization;
- [`common/cache_keys.py`](../../services/pathagent/src/pathagent/common/cache_keys.py) — deterministic cache groundwork;
- [`orchestrator/graph.py`](../../services/pathagent/src/pathagent/orchestrator/graph.py) — existing LangGraph execution;
- [`tests/`](../../services/pathagent/tests/) — approximately 150 test functions.

The cognition layer is fixed and non-conversational, but the gateway, auth, queue, streaming, cache, slide access, tests, and viewer integration should be refactored rather than discarded.

Recommended migration strategy:

- retain the existing service while introducing `/api/agent/v2` or a feature flag;
- extract or refactor shared infrastructure;
- replace the hardcoded reasoning graph incrementally;
- run parity and migration tests;
- remove the old paths only after the new vertical slice passes rollback gates.

Renaming `services/pathagent` to `services/agent` is not itself an architectural improvement.

The current graph is compiled per request without a durable checkpointer, so durable task state remains a real v2 requirement rather than a reason to delete all existing infrastructure.

## 5.2 The removal blast radius is inaccurate

AskPA actually depends on [`src/api/pathChatApi.js`](../../src/api/pathChatApi.js). `claudeApi.js` and `geminiApi.js` are also consumed by annotation, Ki-67, panel, and WSI-analysis code. Removing them as if they belonged exclusively to AskPA would break unrelated features while potentially leaving the real AskPA API behind.

The repository also contains [`PathAssistModel/`](../../PathAssistModel/), a production-oriented HoVer-Net/Girder/Celery service that is not included in the proposed removal or reuse analysis. It should be evaluated as an existing tool-service candidate rather than ignored.

Before deletion, create a capability/decommission matrix:

```text
capability
→ implementing files/services
→ current consumers
→ data/API contracts
→ tests
→ replacement
→ migration gate
→ rollback plan
→ license/security status
```

## 5.3 Production routing is not handled by Vite

Vite proxy ordering affects development only. Production serves the built UI statically, and the current [`deploy/nginx-multi.conf`](../../deploy/nginx-multi.conf) routes `/api/` to Girder.

Production deployment needs:

- an agent upstream/service in the deployment topology;
- a higher-priority `/api/agent/` location before the Girder catch-all;
- correct proxy path semantics;
- SSE buffering disabled;
- keepalive/timeout and disconnect behavior;
- health/readiness checks;
- authentication-header forwarding;
- equivalent routing for any CloudFront/S3 UI deployment.

## 5.4 Production slide storage is not a guaranteed direct filesystem path

The production [`deploy/RUNBOOK.md`](../../deploy/RUNBOOK.md) describes active slide storage in S3 through Girder. A new agent or tool container will not automatically have a stable direct assetstore path merely because it runs on the same host.

The architecture must choose and document one or more supported data-access modes:

- Girder-authorized full-file materialization;
- Girder tile/region API access;
- controlled S3/IAM access tied back to Girder authorization;
- local content-addressed SSD cache;
- explicitly mounted read-only FUSE/direct path where supported.

Identity should be verified by Girder file ID, size, and preferably content/version digest. Filename matching is not a safe identity contract.

## 5.5 Current authorization does not yet enforce artifact ownership

The current gateway validates a token by calling `/user/me`, but several cache/status reads accept an `item_id` and separate `cacheKey` without enforcing that the cache belongs to the item or that the caller is authorized for the derived artifact.

The v2 design should require:

- per-item authorization at task submission;
- actor, tenant, case, and slide binding in every task/artifact manifest;
- authorization on every derived-artifact read;
- scoped internal capabilities rather than long-lived user tokens in workers;
- prevention of cross-case cache reuse or disclosure;
- audit of reads, exports, approvals, and overrides.

---

## 6. Recommended target architecture

```text
Pathologist UI / Viewer
        │
        ▼
Scope + coreference resolver
        │
        ▼
LLM TaskSpec proposal
        │
        ▼
TaskContract + capability eligibility filter
        │
        ▼
Typed DAG compiler + policy/QC/cost/egress validator
        │
        ▼
Plan-digest approval
        │
        ▼
Durable workflow controller ─────── Transactional event/state store
        │
        ▼
RQ/GPU executors → stateless tools → immutable artifacts
        │                                  │
        │                           Zarr / GeoParquet
        ▼                                  │
Deterministic QC + claim builder ◄─────────┘
        │
        ▼
Grounded response + overlay + provenance
```

### 6.1 Control plane

- conversation and task APIs;
- context and reference resolution;
- TaskContract registry;
- capability retrieval;
- typed DAG compiler;
- policy, cost, egress, and validation gates;
- durable state machine;
- plan approvals and audit.

### 6.2 Execution plane

- stateless tool invocations;
- RQ or another bounded executor;
- GPU admission and scheduling;
- idempotency, retry, cancellation, and leases;
- separately isolated exploratory code sandbox.

### 6.3 Data plane

- Girder for source slides and user annotations;
- immutable Zarr/Parquet/GeoParquet artifacts;
- transactional manifests, lineage, claims, and cache index;
- versioned knowledge and TaskContracts.

### 6.4 Trust plane

- deterministic QC and OOD checks;
- coverage and sampling accounting;
- claim/evidence graph;
- calibration and abstention;
- audit replay;
- evaluation harness and monitoring.

### 6.5 Explicit domain entities

```text
Patient / Case / Specimen / Block / Slide / Region
Conversation / Turn
Task / Goal
PlanRevision / Approval
Run / StepAttempt
Artifact / Observation / Claim
```

Conversation state should reference durable tasks. Workflow state must not be buried inside transcript summaries.

---

## 7. Recommended milestone order

| Milestone | Main deliverables | Exit gate |
|---|---|---|
| **M0 — Contracts and risk** | TaskContract; Artifact/Tool Contract; state machine; data-flow and threat model; TIL evaluation protocol; capability/decommission matrix | Architecture review approved |
| **M1 — Control/data spine** | Transactional event store; immutable artifacts; idempotent invocation; lineage/cache; item-level authorization; replayable SSE; mock tools | Crash/retry/reconnect/security tests pass |
| **M2 — Honest technical vertical slice** | Pathologist-selected ROI; inflammatory-cell count/density/cluster; overlay; three-turn follow-up without recomputation | Agent, cache, provenance, and UI pass end-to-end |
| **M3 — Governed TIL assay** | Tumor/stroma/exclusion workflow; TIL TaskContract; QC/OOD; pathologist reference standard | Analytical and end-to-end validation pass |
| **M4 — Hybrid perception** | WSI QC; patch embedding; SlideChat adapter; coverage/discrepancy contract | License, capacity, coverage, and OOD tests pass |
| **M5 — Higher autonomy** | Long-horizon tasks; governed active learning; exploratory code generation | Model governance and sandbox safety gates pass |

Trust, security, provenance, and basic evaluation begin in M0/M1. A later hardening milestone may add multi-center validation, QMS, production monitoring, and regulatory deliverables, but should not introduce safety for the first time.

---

## 8. Evaluation strategy

## 8.1 Lock one testable v1 claim

A defensible future TIL claim could be:

> For untreated primary invasive breast-cancer H&E whole-slide images, after a pathologist confirms the invasive-tumor assessment region, the system provides a computer-assisted continuous stromal-TIL estimate, coverage map, exclusion regions, calibrated interval, and reviewable overlay.

TLS, grading, fully automated ROI selection, other cancers, metastases, and post-treatment specimens should remain outside that initial claim.

## 8.2 Pre-analytical validation

Evaluate:

- institutions and scanners;
- magnification and MPP metadata;
- stain batches and tissue thickness;
- compression and file formats;
- rescans and repeatability;
- blur, folds, pen marks, necrosis, crush, and other artifacts.

## 8.3 Component analytical validation

- tumor/stroma/exclusion segmentation: Dice/IoU plus clinically important boundary errors;
- nuclei detection: patient-level bootstrapped precision/recall/F1;
- immune subclasses: per-class sensitivity, specificity, and confusion;
- QC/OOD: problematic-slide detection and unsafe-pass rate;
- spatial tools: synthetic golden datasets with known expected statistics.

## 8.4 End-to-end task validation

For continuous stromal TILs, use:

- MAE;
- ICC/CCC;
- Bland–Altman analysis;
- predefined clinical tolerance bands;
- repeatability across rescans;
- reproducibility across sites and scanners;
- subgroup reporting by specimen type, tumor subtype, TIL range, artifact, site, and scanner.

Split datasets at patient level to prevent leakage across ROIs or slides from the same patient.

## 8.5 Reference standard

- multiple trained practicing pathologists score independently;
- estimate inter-reader variation;
- repeat a subset to measure intra-reader variation;
- use consensus/adjudication rather than pretending a single score is absolute truth;
- preserve tumor, stroma, and exclusion masks in addition to the final percentage;
- do not treat the guideline itself as ground truth.

## 8.6 Agent-level evaluation

Test:

- intent and task resolution;
- coreference and scope binding;
- TaskContract and tool selection;
- plan validity and unsafe-plan rate;
- claim-to-evidence precision/recall;
- numerical transcription error;
- citation accuracy;
- abstention and unsupported-task behavior;
- cache correctness and invalidation;
- pause, resume, cancellation, retry, and stale-input detection;
- partial tool failure;
- case/tenant isolation;
- prompt injection from user text, metadata, RAG, and tool outputs;
- model/provider/version changes.

## 8.7 Human-factors and reader study

Use two complementary studies:

### Representative efficacy study

- randomized, counterbalanced, crossover design;
- unaided versus AI-assisted reading;
- locked model, UI, and TaskContract;
- washout or disjoint matched case sets;
- predefined primary endpoint and power analysis;
- statistical model accounting for both reader and case clustering;
- continuous-task agreement/error and reading time rather than an inappropriate generic AUC.

### Error-enriched safety study

- include natural model errors, low-confidence cases, OOD cases, and corrupted inputs;
- measure harmful override;
- measure missed AI errors;
- evaluate abstention comprehension;
- evaluate alert/confirmation fatigue;
- record overlay review, override behavior, and user workload.

Before a patient-impacting deployment, run a silent/shadow prospective phase to observe drift and operational failures without writing AI results into the clinical report.

## 8.8 Operational metrics

- p50/p95 latency;
- GPU-minutes and cost per task;
- queue wait and throughput;
- cache hit and invalid-hit rates;
- retries, cancellations, and failures;
- artifact publication completeness;
- stale-result rate;
- unsupported-claim and failure-to-abstain rates;
- model/site/scanner drift indicators.

---

## 9. Risks currently underestimated

1. **Wrong-region precision:** producing a highly precise number over the wrong tissue compartment.
2. **Common-mode LLM failure:** the same model plans, observes, checks, and summarizes.
3. **Validation explosion:** every free tool combination becomes a new unvalidated system.
4. **Automation bias:** precise percentages and polished overlays can make errors harder to question.
5. **Domain shift:** site, scanner, stain, tissue processing, specimen, and tumor subtype changes.
6. **Silent model drift:** hosted LLM changes, active learning, or tool upgrades invalidate prior behavior.
7. **Cross-case leakage:** cache, memory, artifact, or coordinate references bind to the wrong case.
8. **Incomplete-case reasoning:** a grade or case-level conclusion is made from one slide or block.
9. **PHI egress:** labels, macro images, filenames, metadata, prompts, logs, caches, and exports.
10. **Prompt/tool injection:** malicious or accidental instructions in metadata, RAG documents, annotations, or tool output.
11. **Mutable provenance:** ordinary Zarr groups and database records do not automatically provide tamper-evident audit.
12. **Feedback poisoning:** user preference or correction data silently alters clinical tool selection or model behavior.
13. **GPU contention:** large perception and cell models compete without admission control.
14. **Migration regression:** deleting shared AI APIs breaks existing Ki-67, annotation, WSI, or viewer capabilities.

---

## 10. Required RFCs before design lock

The architecture should not return to “design-locked” status until at least these documents are complete:

1. **TaskContract and Validated-vs-Research Mode RFC**
2. **Artifact and Tool Semantic Contract RFC**
3. **Durable Task State Machine RFC**
4. **TIL Intended Use and Evaluation Protocol**
5. **PHI Egress and Sandbox Threat Model**
6. **SlideChat Featurization and Perception RFC**
7. **Model/Dependency License and Model-BOM Review**
8. **Repository Migration and Decommission Matrix**

Once these are resolved, the existing vision can become a robust platform: a conversational pathology copilot whose flexibility comes from a reusable execution engine, while its trust comes from explicit task contracts, immutable evidence, deterministic validation, and measurable human-AI performance.

---

## 11. Final recommendation

Preserve the overall vision, but revise the architecture around five principles:

1. **Dynamic composition is for exploration; validated tasks require versioned contracts.**
2. **The LLM proposes intent and plans; deterministic systems compile, validate, execute, and render authoritative numbers.**
3. **Zarr stores evidence artifacts; a transactional control plane stores workflow truth.**
4. **Trust, security, and evaluation begin with the first vertical slice.**
5. **Do not delete the current service until the replacement passes migration, parity, and rollback gates.**

With those corrections, PathAgent v2 can evolve from a compelling agent demonstration into an extensible, auditable, and clinically evaluable pathology-copilot platform.
