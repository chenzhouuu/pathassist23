# PathAgent v2 — Incremental Build Ladder

> **Status:** Executable step-by-step plan for the first vertical slice. Operationalizes
> `2026-07-16-pathagent-v2-incremental-framework-rfc.md` into **manually-testable increments**.
> **Principle:** every increment ships a thin backend **and** a thin frontend and ends at a
> checkpoint Chen verifies by manipulating the viewer in the browser.
> **Date:** 2026-07-17 · **Author:** Chen (with Claude)
> **Interactive companion:** artifact `a700ce2e-6c73-4447-840c-cec4f50a9d40` (clickable demo of the mature panel).

---

## Decisions locked (2026-07-17)

| Decision | Choice |
|---|---|
| Slicing | **Vertical** — each increment cuts through backend + frontend, testable by hand. Not the RFC's horizontal tracks. |
| Stub-first | Increments **0–6** build & prove the whole framework against a **canned-nuclei stub** (no GPU). **7–8** swap in real ML behind the identical seam. |
| Overlay ordering | **Nuclei overlay first** (#5, with the run) — ahead of the Claim card (#6). Layer toggle lives on the **viewer toolbar** (TissueLab-style), not inside the chat card. |
| Control store | **Postgres** in the compose stack (the one new infra piece beyond Redis). |
| New surface | Flagged **Copilot** tab — a *sibling* to the existing `PathAgentPanel` (`agent` tab). Nothing deleted. |

The existing frontend already has a `PathAgentPanel.jsx` on tab id `'agent'` (old pathagent) + its own
store slice + `wsiAgentApi.js`. The copilot ships as a **new tab id `copilot`** so both coexist behind
`hasRole('ai-users')`.

---

## The ladder

Each increment: **BE** = backend lands, **FE** = frontend lands, **✋** = the manual test, **⊢** = seam proven.
Stub increments need no GPU. `stub` = purple, `gpu` = blue in the artifact.

### 0 · The tab talks to the backend `stub`
- **BE** Greenfield `services/agent/` (FastAPI): `GET /api/agent/health`, `POST /api/agent/echo` (SSE). Girder-token auth gateway. Dev Vite proxy + prod nginx `/api/agent/` location (SSE unbuffered).
- **FE** Flagged **Copilot** tab in the right rail → empty panel + composer; streams the echo over SSE.
- **✋** Open viewer → click **Copilot** tab → type "hello" → see it echoed token-by-token.
- **⊢** Tab mount · auth token flow · SSE pipe · routing. The walking skeleton.

### 1 · Turns persist `stub`
- **BE** Postgres in compose. Tables `conversation`, `turn`. Write + replay endpoints. Alembic migration.
- **FE** Thread loads history on mount; "New conversation" control.
- **✋** Send a few messages → **refresh the page** → history is still there.
- **⊢** Control-plane store seam (Postgres, not Zarr).

### 2 · Claude answers, streaming `stub`
- **BE** Turn → Claude → SSE token stream. Scope resolver injects the active Girder slide id/context.
- **FE** Streaming assistant bubble, "thinking" state, cancel.
- **✋** Ask "what can you do?" → streamed answer that **names the open slide**.
- **⊢** LLM wire · streaming UX · scope-context injection.

### 3 · Point at the slide `stub`
- **BE** Accept an ROI (bbox/polygon) with a turn; bind case/slide/ROI in the scope resolver.
- **FE** Reuse the `roi-select` draw handshake (`setDrawingMode('roi-select')` → `roiSelectResult`); ROI overlay attached to the next message.
- **✋** Draw a box on the slide → ask "what's here?" → Claude echoes the ROI size + coords.
- **⊢** Viewer ↔ agent spatial binding — the seam everything downstream rides.

### 4 · Plan proposal + approval gate `stub`
- **BE** Tool registry (1 stub tool) + deterministic capability filter; Claude proposes an **enum-constrained** plan; compile + thin validate (schema + produces⊇consumes + units); state → `AWAITING_APPROVAL`; persist `plan` + `plan_digest`.
- **FE** **Plan card** — numbered steps, tool chips, scope, cost/time envelope, expiry; Approve / Reject; older plans → Expired.
- **✋** Ask "count inflammatory cells here" → a **Plan card** appears (nothing has run) → click Approve.
- **⊢** Plan artifact + human gate — GPU-minutes never spent without a click.

### 5 · Run the stub → nuclei on the slide `stub` ← overlay first
- **BE** Stateless `/invocations` contract; stub writes canned nuclei → run-scoped Zarr namespace + **committed manifest**; opaque `ArtifactRef` geometry endpoint (ACL-checked); run state machine.
- **FE** **Run trace** (pending→running→done, collapses to `Tools(n)`) + **NucleiOverlay** (canvas synced to OSD events, mirrors `AnnotationCanvas` projection) auto-rendered when segmentation commits; **viewer-toolbar layer toggle** (nuclei).
- **✋** Approve → watch the run trace tick → **segmented nuclei render on the slide** the moment segmentation finishes; pan/zoom stays aligned; toggle the nuclei layer from the toolbar.
- **⊢** Run spine + `/invocations` + `ArtifactRef` + the **overlay-render seam** (hardest FE piece) — visual payoff, on the stub.

### 6 · The grounded Claim + memory `stub`
- **BE** Deterministic **Claim builder** (LLM never emits the number); content-addressed cache; `blackboard_fact` rows referencing the manifest.
- **FE** **Claim card** (count/density, evidence chip, research-use label) tied to the layer on the slide; **case blackboard** strip accretes the fact.
- **✋** After the run, a Claim card shows the count/density bound to the overlay; ask a follow-up → **instant cache hit** (no recompute).
- **⊢** Trust seam (deterministic, evidence-bound) + within-case memory + cache.

**→ Framework complete and hand-tested end-to-end with the stub. Everything below swaps stubs for real ML behind the same seams.**

### 7 · CellViT++ replaces the stub `gpu`
- **BE** CellViT++ node behind the **same** `/invocations` contract (GPU): Girder-auth slide access (S3-via-Girder or `/mnt/dsa-cache`), nuclei seg + cell classification + embeddings → Zarr `/CellViT/*`.
- **FE** **No change** — overlay, Claim card, run trace already work.
- **✋** Same three clicks — the count and the dots are now **real**.
- **⊢** The tool-swap seam: swap implementation, UI untouched. The whole point of the framework.

### 8 · Histolytics + follow-up reuse `gpu`
- **BE** Histolytics node behind `/invocations`; consumes cached CellViT centroids → count/density / Ripley's K / Moran's I / DBSCAN → Zarr `/Spatial/*`.
- **FE** Cluster-overlay variant (toolbar layer); second turn reuses cached segmentation, runs only the spatial step.
- **✋** Full proving demo: count → "are they clustered?" (fast, cache reuse) → "show me where" (co-navigation).
- **⊢** Second tool composes on the first · within-case memory · no recomputation. **This is v0.1.**

---

## Increment 0 — concrete file plan (first cut)

Branch off `chen` first. Nothing deleted.

**Backend — new `services/agent/`** (port infra from `services/pathagent`, don't import it):
```
services/agent/
├── pyproject.toml                 # FastAPI, uvicorn, sse-starlette, httpx, (later) sqlalchemy/alembic, psycopg
├── src/agent/
│   ├── main.py                    # FastAPI app, /health, /echo (SSE), CORS, router mount
│   ├── gateway/auth.py            # Girder-Token verify (ported from pathagent/gateway/auth.py)
│   ├── gateway/sse.py             # SSE event helper (ported)
│   └── common/config.py           # env-driven settings (AGENT_* vars)
├── tests/test_health.py           # /health 200
└── tests/test_echo.py             # SSE echo frames + auth-required
```
- `POST /api/agent/echo` takes `{text}`, requires a valid `Girder-Token`, streams back `data: {...}` SSE frames echoing the text word-by-word (proves the streaming path end to end).
- **Dev routing:** set `VITE_AGENT_API_URL=/api/agent`; add a `/api/agent` proxy entry in `vite.config.js` pointing at the local agent service (higher-priority than the catch-all `/api`).
- **Prod routing:** nginx `location /api/agent/ { proxy_pass ...; proxy_buffering off; ... }` above the `/api/` location. (Deploy step, documented not executed in inc 0.)

**Frontend:**
```
src/api/copilotApi.js              # mirror wsiAgentApi.js: AGENT base + authHeaders + fetch/SSE reader
src/store/index.js                 # add a `copilot` slice near the PathAgent slice (~L237); reset in
                                   #   setActiveItem + openCaseItem
src/components/panels/CopilotPanel.jsx   # header + thread + composer; sends to /echo, renders SSE
src/components/panels/RightPanel.jsx     # add {id:'copilot',...} to allTabs + render switch
src/components/ViewerApp.jsx             # add {id:'copilot',...} to RightRail tabs (purple #7c3aed)
```
- Gate the tab behind `hasRole('ai-users')` + a feature flag so it's dark until ready.

**Manual test (increment 0 gate):** `npm run dev` + agent service up → open a slide → click the **Copilot**
rail icon → panel opens → type "hello" → the word-by-word echo streams back. Auth failure (no token) shows
a clean error. That's the whole increment.

---

## What stays deferred (behind which seam) — unchanged from the RFC

Governed sTIL% TaskContract (2.5) · validated mode + full state machine (§2.1/§3) · semantic typed-DAG (§3) ·
SlideChat perception (2.3) · code-gen sandbox — disabled in v1 (2.3) · active learning (2.4) · calibration /
reader study (trust plane) · cross-case memory (§2.1).
