# PathAgent v2 — Orchestrator Agent (Claude Agent SDK) Architecture RFC

- **Date:** 2026-07-20
- **Status:** Draft for review (design-before-code)
- **Supersedes (execution model only):** the plan→approve→run state machine of the
  build ladder rungs 4–8. Substrate (persistence, artifact contract, Claim/blackboard,
  SSE transport, auth oracle, tool registry, viewer render, Girder client) is retained.
- **Decision owner:** Chen. This RFC proposes; it does not commit code.

---

## 0. Why this RFC

The current copilot is a **single-shot planner**: one model call proposes a linear
tool DAG, a human approves it, and a deterministic executor runs it. That is a solid
*framework on a stub*, but it is not the target. The target — stated by Chen — is:

> Each tool is exposed via native tool-invocation or MCP; **one agent does unified
> reasoning to orchestrate the tools**; reading a region **or** the whole WSI is the
> agent calling the right tool; the whole run (process + intermediate + final) is
> visible in the frontend and outcomes are visualized. The run form should feel like
> **Claude Code / Codex** — an autonomous loop, **no approval gate**. Seed with **one**
> real tool (CellViT) and expand.

This RFC defines the architecture to get there, grounded in three research passes:
(1) Claude Agent SDK capability verification, (2) how existing agentic frameworks
(Continue, OpenHands, Cline, Cursor, CopilotKit/AG-UI, the MCP ecosystem, aider,
Claude Code) drive an external stateful UI + backend, and (3) a map of our current
wiring. It states the target contracts first, then the migration.

---

## 1. Headline decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Adopt the Claude Agent SDK (Python) as the in-turn agent loop**, hosted inside the FastAPI gateway. Retire the hand-rolled `StubPlanner`/`ClaudePlanner` single-shot + the step-driver + the separate chat responder — all three collapse into one streaming agent turn. | The SDK *is* the Claude-Code harness: observe→think→act loop, tool orchestration, MCP client, streaming, hooks, subagents — headless, pure-Python, containerizable. Building this by hand duplicates it. |
| D2 | **No approval gate.** `permission_mode = bypassPermissions`. Retain **optional selective gating** of expensive/destructive tools via a `PreToolUse` hook. | Chen's explicit ask: Claude-Code form. The gate dissolves; grounding is preserved by other means (D6). |
| D3 | **Two-class tool registry.** *Client-side (viewer) tools* — side effect is an OpenSeadragon command, no auth. *Server-side (data) tools* — call Girder / run models with the user's token, which the model never sees. | This split is the convergent pattern across Continue, OpenHands, CopilotKit, and the MCP auth spec. It is the cleanest way to get "agent drives the viewer" + "agent reads slide data" without leaking credentials into model context. |
| D4 | **Artifacts are handles, not payloads.** Large outputs (masks, dense point sets) are written to Girder (DSA annotation or Girder file); the tool returns `{handle, bbox, summary, size}`. The React overlay fetches bytes **out-of-band** directly from Girder. Retire inline-JSONB artifact storage. | MCP `ResourceLink` + the "split channel" pattern. Also fixes the known scale liability: dense segmentation output cannot live in a `run` row's JSONB. DSA annotations are OSD-native, so this *reuses* existing infra. |
| D5 | **Typed event stream** (AG-UI-style) over the existing SSE transport. Reasoning, text, tool-call, tool-progress, and viewer-state are distinct event families correlated by ids. | The frontend renders a live trace (thinking strip · tool cards · final answer · on-slide overlays) instead of parsing an opaque token blob. Click-through between a slide overlay and the trace card that produced it via a shared `tool_call_id`. |
| D6 | **Grounding without a gate.** A `PreToolUse` hook injects live viewer state and enforces "the model never emits computed numbers"; a `PostToolUse` hook turns each grounded tool result into a **Claim** (existing provenance). Blackboard read-model unchanged. | Keeps the deterministic/auditable property Chen valued, now decoupled from the approval step. |
| D7 | **State boundary:** the SDK owns only the *in-turn* loop. **Postgres remains the owner of domain state** (conversations, turns, claims, blackboard, viewer-scoped state). We drive turn-by-turn and persist ourselves. | Avoids coupling domain persistence to SDK session internals; multi-thread-per-slide and reload stay under our control. |
| D8 | **One coordinate frame: image / level-0 pixels** for every viewport, ROI, and artifact bbox that crosses the agent↔viewer boundary. | The single most important choice for making "pan to that gland / draw on this region" round-trip cleanly. We already store ROI and the nuclei artifact in level-0 coords — make it a hard contract. |

---

## 2. Target architecture

```
┌────────────────────────── React WSI viewer ──────────────────────────┐
│  OpenSeadragon  ·  NucleiOverlay/AnnotationCanvas  ·  CopilotPanel     │
│    ▲ renders trace (tool cards, thinking, final)   ▲ overlays          │
│    │ executes CLIENT-SIDE tools (pan/zoom/draw)    │ fetch bytes       │
│    │ POSTs tool acks + viewer-state snapshot       │ (out-of-band)     │
└────┼───────────────────────────────┼───────────────┼──────────────────┘
     │ SSE (typed events)            │ ack/turn POST  │ Girder REST (token in browser)
┌────┼───────────────────────────────┼───────────────┼──────────────────┐
│  FastAPI gateway                    ▼               │                  │
│  ┌──────────────────────────────────────────────┐  │                  │
│  │  Claude Agent SDK loop (per turn)             │  │                  │
│  │   · system persona                            │  │                  │
│  │   · PreToolUse hook  (inject viewer state,    │  │                  │
│  │                       enforce grounding,      │  │                  │
│  │                       optional gating)        │  │                  │
│  │   · PostToolUse hook (build Claim, audit)     │  │                  │
│  └───────────────┬───────────────┬──────────────┘  │                  │
│   client-side    │  server-side  │   external MCP   │                  │
│   tool relay ────┘  data tools ──┼── (CellViT GPU)  │                  │
│   (emit SSE,        (Girder calls │   stdio/http     │                  │
│    await ack)        w/ user tok) │                  │                  │
│  ┌────────────────────────────────▼───────────────┐ ▼                  │
│  │ Substrate: Postgres (conv/turns/claims/bb) ·    │ Girder / DSA       │
│  │ artifact handles · Claim builder · auth oracle  │ (pixels, annots)   │
│  └─────────────────────────────────────────────────┘                   │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.1 The agent core (D1)

- The SDK runs the loop for **one user turn**: it reads the turn + injected context,
  calls tools in whatever order its reasoning dictates, observes results, and converges
  on a final narrative — exactly the Claude Code loop, server-side and headless.
- We host it in the gateway. Per turn we supply the conversation history (owned by
  Postgres, D7) and the current scope/viewer-state (D8) as context.
- **What collapses:** `plan.propose()` (single-shot), the `routes.run_plan` step-driver,
  and `chat.responder` become one thing. There is no longer a distinct "plan" object,
  "approve" transition, or "run" endpoint in the user-facing flow — there is a **turn**
  that streams thinking, tool calls, and an answer.

### 2.2 Two-class tool registry (D3)

The registry (`plan/tools.json` today) stays as the **catalog of record**, but each
entry now points at one of two executor kinds:

**Client-side (viewer) tools** — no auth, effect is a UI command:
- `pan_zoom_to_region(bbox)` · `draw_overlay(handle)` · `set_layer_opacity(layer, α)`
  · `highlight_roi(bbox)` · `read_viewer_state()`.
- Mechanism: the server-side tool handler **emits a typed SSE event** to the browser;
  the browser executes it against OSD and (when a result is needed) **POSTs a small ack**
  that resolves the awaiting tool. Pure fire-and-forget effects (pan, draw) can resolve
  immediately after emit. (Pattern: CopilotKit `useFrontendTool`, Continue's client-tool
  routing.)

**Server-side (data) tools** — run in the executor, use the user's Girder token:
- `run_segmentation(scope)` (→ CellViT via external MCP server) · `count_within_roi(...)`
  · `fetch_region(scope)` · `read_annotations(...)` · `save_annotation(...)`.
- The user's Girder token is captured at session start and held in **server-side session
  state keyed to the run**; the executor attaches it as the `Girder-Token` header. The
  **model never sees the token, and it is never a tool argument** (MCP token-passthrough
  anti-pattern). This is the first time the gateway reads pixels — today it uses Girder
  only as an auth oracle.

Seeding: stand the framework up with a trivial tool first, then **one real tool =
CellViT segmentation** as an external MCP server. Multi-tool orchestration reasoning is
only genuinely exercised at tool #2 — until then, tool #1 proves the plumbing (this
mirrors our stub-first philosophy).

### 2.3 Scope: region vs whole-WSI (D8)

Scope is just the argument the agent fills: `{ slide_ref, roi? }`. **No `roi` ⇒
whole-slide**; `roi` present ⇒ that region. The agent chooses based on the user's intent
plus the injected viewer state. Everything crossing the boundary is in level-0 pixels.

### 2.4 Artifacts as handles (D4)

- A tool that produces bulk output **writes it to Girder** (DSA annotation for overlays;
  Girder file for rasters) and returns a **handle**:
  `{ kind, annotation_id | file_id, bbox, count, summary, mime, size, thumbnail_url? }`.
- The model's context receives only `summary` + handle (e.g. `"nuclei: 4213 points,
  tumor ≈ 18% of ROI"`), never the geometry.
- The React overlay layer fetches the actual bytes **directly from Girder** (already
  OSD-native tile/annotation endpoints, browser session token).
- **Backward-compat:** small artifacts may remain inline during migration, but the
  *contract* is handle-based from R9 onward. The existing `{run_id, key}` ArtifactRef
  and lazy-fetch shape are preserved; only the **backing store** moves off inline JSONB.

### 2.5 Typed event stream (D5)

Over the existing SSE transport (`copilotApi.readSse` — kept), emit a typed family
(AG-UI names as the reference vocabulary; final names TBD):

- Lifecycle: `run_started` · `step_started/step_finished` · `run_finished/run_error`
- Reasoning (separate, collapsible): `reasoning_start/reasoning_delta/reasoning_end`
- Final narrative: `text_start/text_delta/text_end`
- Tool: `tool_call_start` · `tool_call_args(delta)` · `tool_call_result` · `tool_progress`
- State: `state_snapshot` / `state_delta` (viewer state, blackboard)

All correlated by `run_id` / `tool_call_id` / `step_id` so the UI updates in place.
Rendering: reasoning → muted "thinking" strip; tool → live **tool card** (args → status
→ outcome); text → final answer; overlays carry their originating `tool_call_id` so a
slide highlight ↔ trace card is click-linked both ways. (Also: retire the currently
**unused** `start` / `run_start` frames the frontend ignores.)

### 2.6 Loop control (D2 + interruption)

- **Per-run abort controller** wired to two UI affordances:
  - **Cancel** = hard abort → in-flight tool_use blocks get a **synthetic error
    tool_result** so the conversation stays well-formed (Claude Code's pattern).
  - **Send-during-run** = submit-interrupt → the new message is **enqueued as the next
    turn's steering context**, not a cold kill ("no, focus on the top-left gland").
- **Long-running GPU tool** = async "call-now, fetch-later": `run_segmentation` returns a
  `task_id` immediately, emits `tool_progress` events; the UI shows a **non-blocking
  progress card** and swaps the overlay in only when the result *handle* arrives. The loop
  never blocks synchronously on the GPU.
- **Optional HITL** only for the few expensive/destructive tools (launch GPU job, persist
  annotation), gated in the `PreToolUse` hook — not a global plan gate.

### 2.7 Grounding & provenance without a gate (D6)

- `PreToolUse` hook: (a) inject the viewer-state snapshot + scope into context; (b)
  enforce the invariant that computed numbers come only from tool results (deny model
  self-computation paths); (c) apply optional per-tool gating.
- `PostToolUse` hook: build a **Claim** from each grounded tool result (existing
  `claim/builder.py`, `evidence = [{run_id, key}]`), persist it, refresh the
  **blackboard** read-model. The auditable, deterministic-numbers property survives the
  removal of the approval step.

### 2.8 State boundary (D7)

- **SDK owns:** the in-turn agentic loop and its transient tool-call transcript.
- **Postgres owns:** conversations, turns, claims, blackboard, viewer-scoped state
  (sticky ROI, etc.). We persist at turn boundaries and via the `PostToolUse` hook.
- Multi-thread-per-slide, reload hydration, and the per-slide blackboard remain exactly
  as today, independent of SDK session internals.

---

## 3. Reuse vs replace (from the wiring map)

**Replace (the "brain"):**
- `plan/planner.py` (`StubPlanner`, `ClaudePlanner`, `_PLANNER_SYSTEM`)
- `run/executor.py` (`_nuclei_segment_stub`, `_count_within_roi`, `invoke`, `_IMPLS`)
- `chat/{claude,echo}.py` responder; `routes` plan-compile/run state machine
  (`_compile_steps`, `_envelope`, `plan_stream`, `run_plan` step-driver)

**Reuse (the "substrate"):**
- Persistence: `store/pg.py`, `store/base.py` (conversations/turns/claims/blackboard)
- Artifact **contract** (`{run_id,key}` refs, cache) — *backing store* moves to Girder
- Claim builder `claim/builder.py`; blackboard projection `get_blackboard`
- SSE transport `gateway/sse.py` + `copilotApi.readSse`
- Auth oracle `gateway/auth.py` (`require_user`)
- Tool registry `plan/registry.py` + `tools.json` + `validate_plan`/`plan_digest`
  (structure reusable; entries repoint at the two-class executors)
- Viewer render + ROI capture: `NucleiOverlay.jsx`, `agentViewerSync.focusRegion`,
  `AnnotationCanvas` roi-select, store ROI/nuclei slices
- Girder client + token auth: `src/api/client.js`, `src/api/index.js`, `config/girder.js`,
  `ViewerPanel` tile source

---

## 4. Proposed re-slotted build ladder

Same stub-first cadence (framework on a stub → swap real behind a stable seam), one
manually-testable increment per rung. Claim/blackboard carry through as `PostToolUse`.

- **R7 — SDK loop on a stub tool.** Host the SDK in the gateway behind the existing SSE
  seam. One trivial echo/stub tool. Prove: autonomous loop + typed events + frontend
  tool-card rendering + cancel. *(Framework swap on stub.)*
- **R8 — Two-class tool split.** First **client-side** viewer tool (`pan_zoom_to_region`
  / `highlight_roi`) + first **server-side** data tool (still stubbed). Prove the
  agent↔viewer round-trip and viewer-state injection (D8 coordinate contract).
- **R9 — Artifacts → Girder handles.** Overlays as DSA annotations; overlay fetches bytes
  out-of-band; retire inline-JSONB. Prove the handle contract end-to-end.
- **R10 — Real CellViT.** Swap the stub for CellViT++ as an external MCP server + async
  task/progress. First real perception.
- **R11 — Girder-reading data tools.** `fetch_region` / whole-WSI with per-session token;
  grounding hook enforced. First time the gateway reads pixels.

(R7–R9 need no GPU and no model weights — they harden the framework. R10–R11 add the
real ML behind unchanged seams.)

---

## 5. Open decisions (need Chen's call) — with my recommendation

- **O1 — Client-side tool round-trip.** A server-side SDK tool that needs the browser to
  act introduces a `tool → SSE → browser → ack` loop. **Recommend:** real tools with an
  ack for the few that need a result (`read_viewer_state`), fire-and-forget for pure
  effects (`pan`, `draw`). *(Alternative: agent emits "viewer intent" events that are not
  real tools — simpler, but the agent cannot `await` the viewer or read its state.)*
- **O2 — Agent writing to Girder.** D4 has the agent **write** DSA annotations (today the
  gateway only reads `/user/me`). **Recommend:** yes — reuse DSA's native annotation store
  for overlays; scope writes to a dedicated "PathAgent" annotation namespace, gated in
  `PreToolUse`.
- **O3 — Grounding posture.** With no gate, auditability rests on the Pre/PostToolUse
  hooks + Claims. **Recommend:** ship that for the research posture; revisit if a clinical
  posture later needs a hard gate on specific tools (already supported via O1/HITL).
- **O4 — Re-slotted ladder.** Approve R7–R11 as above, or reshuffle.

---

## 6. Risks

1. **SDK subprocess/concurrency.** Each turn spawns a `claude` subprocess over stdio;
   a multi-user gateway needs per-session lifecycle + isolation (`setting_sources=[]`,
   config-dir isolation, disable auto-memory). Verify concurrency + latency early.
2. **GPU latency vs MCP timeout.** 40s+ CellViT calls can exceed default MCP timeouts →
   must use the async task/progress path (2.6), not a synchronous call.
3. **Long-session context growth.** Turn history + slide context is O(N); bound with
   `max_turns` / compaction, and lean on handle-summaries (D4) to keep tool results tiny.
4. **SDK API specifics to verify hands-on before coding:** the exact session-resume
   mechanism (do we `resume=session_id` or replay our own history each turn), the precise
   streaming event types, and whether a first-party session-store adapter exists (the
   research draft mentioned one I could not confirm — treat as unverified). Confirm the
   Opus model id in use is `claude-opus-4-8`.
5. **Vendor coupling.** Adopting the SDK couples the loop to Anthropic's harness. The
   two-class tool boundary + our own persistence keep the *domain* portable; the loop
   itself would be the rewrite cost if ever swapped.

---

## 7. Appendix — SDK feature map (verified vs verify)

| Need | SDK mechanism | Confidence |
|------|---------------|------------|
| Headless loop in container | pure-Python `query()` / `ClaudeSDKClient`, no TTY | verified in docs |
| No gate + selective gating | `permission_mode="bypassPermissions"` + `PreToolUse` hook | verified |
| In-process tools | `@tool` + `create_sdk_mcp_server` | verified |
| External GPU tool | `mcp_servers` stdio/http (CellViT) | verified |
| Stream trace | `include_partial_messages=True` → `StreamEvent` (tool_use / deltas / result) | verified |
| Inject context / enforce invariant | `PreToolUse` hook (`updatedInput`, `additionalContext`, `permissionDecision`) | verified |
| Provenance from results | `PostToolUse` hook | verified |
| Subagents / persona | `agents={AgentDefinition(...)}`, custom system prompt | verified |
| Session/domain coexistence | drive per-turn, own persistence in Postgres | pattern verified; **resume mechanism to confirm** |
| First-party session store adapter | *(claimed in research; unconfirmed)* | **verify** |
| Model | `claude-opus-4-8` | authoritative (env) |

Reference vocabulary for the event stream and tool-class split comes from AG-UI/
CopilotKit, OpenHands (action/observation event log), Continue (client-vs-core tool
routing), MCP (`ResourceLink`, OAuth/token-passthrough, async tasks SEP-1686), and Claude
Code's loop-control (abort tree, submit-interrupt, synthetic tool_results).
