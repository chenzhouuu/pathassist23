# PathAgent M4 — React PathAgent Panel + OSD Co-Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Frontend (no JS test runner); each task ends with `npm run build`
> green + a targeted check. Live end-to-end verification (browser + gateway + real slide) is Task 7.

**Goal:** Add the **PathAgent** right-panel to the PathAssist React viewer — it opens a case, streams
the M3 agent loop, **co-navigates the live OpenSeadragon viewer** to each region, overlays the
importance heatmap, shows the verified/cited answer + confidence, and lets the pathologist **pause**
and **save the run as a Girder annotation**.

**Architecture:** an `agent*` Zustand slice (mirrors the AskPA `chat*` slice) · a new
`src/api/wsiAgentApi.js` (preprocess / poll status / **SSE-over-POST** query / heatmap URL) · a new
`PathAgentPanel.jsx` (forked from `PathChatPanel.jsx`) · tab + rail registration (gated
`hasRole('ai-users')`) · an OSD sync layer that replays `navigate` events via
`viewport.fitBounds`, overlays the heatmap via `addTiledImage`, and draws highlights through the
existing annotation canvas. Config via `VITE_AGENT_API_URL`.

**Tech Stack:** React 18 · Zustand · OpenSeadragon · `fetch` ReadableStream (SSE) · the existing
`src/api` Girder client + `annotationUtils`. The gateway is M3's FastAPI service (SSE `/api/agent`).

---

## Scope (design §8/§9) & decisions locked with the user

**In v1 (this milestone):**
- Store slice, API client, panel, tab+rail registration, readiness banner, task chips, streaming
  trace, **navigation trail**, confidence badge + φ scores + citations, **heatmap overlay toggle**,
  **live viewport co-navigation + client-side pause/take-control**, **manual save-as-annotation**.
- **Verification = full live end-to-end** (user's choice): real gateway (wired to the DSA) + Redis +
  a real public BRACS slide + a real browser (Playwright/Chromium) driving the whole flow.

**Deferred (documented, not built in v1):**
- **Auto-persist every run** to Girder (design §13.4) — v1 is **manual save-as-annotation only**
  (user's choice); no automatic DSA writes.
- Redirect/resume take-control (v1 is **pause-only**, client-side — the M3 checkpointer is in-memory).
- Morphology/Treatment/Report task chips (M3b) — v1 chip is **Diagnosis**.

---

## Wire facts (from M3, already shipped)
- `POST {AGENT_BASE}/cases/{itemId}/preprocess` → `202 {jobId, cacheKey, status}`; body
  `{backbone:{patchEncoder:"conch_v1",mag:20,patchSize:256}, consensus:{patchEncoder:"uni_v1",mag:20,patchSize:512}, slidechat:false}`.
- `GET {AGENT_BASE}/cases/{itemId}/status?cacheKey=…` → `{status, stage, progress, ready:{features,slidechat,classifiers}}`.
- `POST {AGENT_BASE}/query` (SSE) body `{itemId, cacheKey, question, task, roi?}` → `data:` lines,
  each a JSON event: `route|triage|navigate|describe|diagnose|verify|final|error`. Event geometry
  (`navigate.region`, `final.trail`) is **level-0 image px**. `final` carries
  `{answer, confidence(0..100), heatmapTaskId, trail:[{x,y,width,height}], notes, citations}`;
  `verify` carries `{scores:{phiL,phiK,phiC,phiTotal}, citations:[{text,source}]}`.
- `GET {AGENT_BASE}/cases/{itemId}/heatmap/{taskId}?cacheKey=…` → PNG + `X-Level0-X/Y/Width/Height`.
- **Auth:** every request sends the `Girder-Token` header (from `localStorage.girderToken`); the
  gateway validates via Girder `getMe`. **CORS** on the gateway is `*` and exposes the `X-Level0-*`
  headers, so a direct cross-origin fetch from the dev server works.

---

## File structure
```
src/
├── api/wsiAgentApi.js                      # NEW — preprocess / pollStatus / streamAgentQuery / heatmapUrl
├── store/index.js                          # MODIFY — add the agent* slice (after the chat* slice)
├── components/
│   ├── panels/PathAgentPanel.jsx           # NEW — the panel (fork of PathChatPanel)
│   ├── panels/RightPanel.jsx               # MODIFY — register the 'agent' tab
│   ├── ViewerApp.jsx                        # MODIFY — register the 'agent' rail icon
│   └── panels/agentViewerSync.js           # NEW — OSD helpers: co-nav fitBounds, heatmap overlay, highlight
.env.local                                  # MODIFY — VITE_AGENT_API_URL (commented default)
```

---

## Conventions (match the codebase)
- Functional components + hooks; **inline styles** with CSS vars (`--fg`, `--muted`, `--border`,
  `--surface`); zustand via `useStore()`. Mirror `PathChatPanel.jsx` structure and the AskPA visual
  language (pill chips, purple `rgba(124,58,237,*)` accents, small fonts).
- Girder client sends `Girder-Token` from `localStorage` (see `src/api/client.js`); the agent client
  reads `localStorage.getItem('girderToken')` the same way.
- OSD coord transforms via `viewer.viewport.imageToViewportRectangle(new OpenSeadragon.Rect(...))`
  (see `AIPanel.jsx:5-15`, `WsiResultCard.jsx:120-125` for the `fitBounds` pattern); annotation
  drawing via the existing `createAnnotation` + `annotationUtils` (`makeRectangle`).
- No secrets in code. `npm run build` must stay green after every task.

---

## Task 1 — Agent API client (`src/api/wsiAgentApi.js`)

**Files:** Create `src/api/wsiAgentApi.js`; Modify `.env.local` (add commented `VITE_AGENT_API_URL`).

- [ ] **Step 1** — implement:
```js
// src/api/wsiAgentApi.js — PathAgent gateway client (preprocess, status, SSE query, heatmap).
const AGENT_BASE = (import.meta.env.VITE_AGENT_API_URL || '/api/agent').replace(/\/$/, '');

function authHeaders(extra = {}) {
  const token = localStorage.getItem('girderToken');
  return { ...(token ? { 'Girder-Token': token } : {}), ...extra };
}

export async function preprocessCase(itemId, { backbone, consensus, slidechat = false } = {}) {
  const body = {
    backbone: backbone || { patchEncoder: 'conch_v1', mag: 20, patchSize: 256 },
    consensus: consensus || { patchEncoder: 'uni_v1', mag: 20, patchSize: 512 },
    slidechat,
  };
  const r = await fetch(`${AGENT_BASE}/cases/${encodeURIComponent(itemId)}/preprocess`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`preprocess failed: ${r.status}`);
  return r.json();                             // { jobId, cacheKey, status }
}

export async function pollStatus(itemId, cacheKey) {
  const u = `${AGENT_BASE}/cases/${encodeURIComponent(itemId)}/status?cacheKey=${encodeURIComponent(cacheKey)}`;
  const r = await fetch(u, { headers: authHeaders() });
  if (!r.ok) throw new Error(`status failed: ${r.status}`);
  return r.json();                             // { status, stage, progress, ready }
}

export function heatmapUrl(itemId, taskId, cacheKey) {
  return `${AGENT_BASE}/cases/${encodeURIComponent(itemId)}/heatmap/${encodeURIComponent(taskId)}`
       + `?cacheKey=${encodeURIComponent(cacheKey)}`;
}

// SSE-over-POST: the gateway streams `data: <json>\n\n` frames. EventSource can't POST, so read the
// body stream and parse frames. onEvent(evt) is called per parsed event. Returns when the stream ends.
export async function streamAgentQuery({ itemId, cacheKey, question, task = 'Diagnosis', roi = null,
                                         onEvent, signal }) {
  const r = await fetch(`${AGENT_BASE}/query`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ itemId, cacheKey, question, task, roi }), signal,
  });
  if (!r.ok || !r.body) throw new Error(`query failed: ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {          // one SSE frame per blank-line delimiter
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        const t = line.trim();
        if (t.startsWith('data:')) {
          const payload = t.slice(5).trim();
          try { onEvent(JSON.parse(payload)); } catch { /* skip keepalive/non-JSON */ }
        }
      }
    }
  }
}
```
- [ ] **Step 2** — add to `.env.local` (commented; dev points at the running gateway):
  `# VITE_AGENT_API_URL=http://localhost:8000/api/agent   # M3 PathAgent gateway (dev; direct, CORS-enabled)`
- [ ] **Step 3** — `npm run build` green. Commit `feat(agent-ui): add PathAgent gateway API client`
  (`git add src/api/wsiAgentApi.js .env.local`). NOTE: `.env.local` may be git-tracked with a live
  token on other lines — stage it ONLY if the diff is exactly the one commented line you added;
  otherwise skip staging it and report it (do not commit secrets).

---

## Task 2 — Agent store slice (`src/store/index.js`)

**Files:** Modify `src/store/index.js` (add after the `chat*` slice, ~line 233).

- [ ] **Step 1** — add the slice (mirror the chat slice; NOT persisted):
```js
  // ── PathAgent (M4) ────────────────────────────────────────────────────────────
  agentTrace: [],              // ordered stream events [{type, ...}]
  agentStatus: null,           // { status, stage, progress, ready } from pollStatus
  agentCacheKey: null,
  agentRunning: false,
  agentNavTrail: [],           // [{x,y,width,height, rationale?}] visited regions (level-0 px)
  agentHeatmap: null,          // { taskId, visible } — extent comes from response headers
  agentFinal: null,            // the final event payload
  agentFollow: true,           // co-navigation on/off (pause = false)
  agentError: null,

  addAgentEvent: (evt) => set((s) => ({ agentTrace: [...s.agentTrace, evt] })),
  pushNavRegion: (region) => set((s) => ({ agentNavTrail: [...s.agentNavTrail, region] })),
  setAgentStatus: (st) => set({ agentStatus: st }),
  setAgentCacheKey: (k) => set({ agentCacheKey: k }),
  setAgentRunning: (v) => set({ agentRunning: v }),
  setAgentHeatmap: (h) => set({ agentHeatmap: h }),
  setAgentFinal: (f) => set({ agentFinal: f }),
  setAgentFollow: (v) => set({ agentFollow: v }),
  setAgentError: (e) => set({ agentError: e }),
  resetAgentRun: () => set({ agentTrace: [], agentNavTrail: [], agentFinal: null,
                             agentHeatmap: null, agentRunning: false, agentError: null }),
```
- [ ] **Step 2** — clear the agent run when the slide changes: in `setActiveItem` (~line 88, where
  `chatMessages: []` is reset), also reset `agentTrace: [], agentNavTrail: [], agentFinal: null,
  agentHeatmap: null, agentStatus: null, agentCacheKey: null, agentRunning: false, agentError: null`.
- [ ] **Step 3** — `npm run build` green. Commit `feat(agent-ui): add agent* store slice`
  (`git add src/store/index.js`).

---

## Task 3 — OSD sync helpers (`src/components/panels/agentViewerSync.js`)

**Files:** Create `src/components/panels/agentViewerSync.js`.

- [ ] **Step 1** — implement pure helpers (viewer passed in; no store coupling):
```js
// Co-navigation + overlays for the PathAgent panel. Geometry in is level-0 image px.
import { heatmapUrl } from '../../api/wsiAgentApi.js';

function OSD() { return window.OpenSeadragon; }

// Pan+zoom the viewer to a level-0 px rect (with a little padding).
export function focusRegion(viewer, { x, y, width, height }, pad = 0.15) {
  if (!viewer?.viewport || !OSD()) return;
  const px = Math.max(0, x - width * pad), py = Math.max(0, y - height * pad);
  const rect = viewer.viewport.imageToViewportRectangle(
    new (OSD().Rect)(px, py, width * (1 + 2 * pad), height * (1 + 2 * pad)));
  viewer.viewport.fitBounds(rect, false);         // animated (matches AIPanel/WsiResultCard)
}

// Add the heatmap as a tiled image at its level-0 extent (from the X-Level0-* headers).
export async function addHeatmapOverlay(viewer, itemId, taskId, cacheKey) {
  if (!viewer || !OSD()) return null;
  const url = heatmapUrl(itemId, taskId, cacheKey);
  const token = localStorage.getItem('girderToken');
  const resp = await fetch(url, { headers: token ? { 'Girder-Token': token } : {} });
  if (!resp.ok) throw new Error(`heatmap ${resp.status}`);
  const ext = {
    x: +resp.headers.get('X-Level0-X'), y: +resp.headers.get('X-Level0-Y'),
    width: +resp.headers.get('X-Level0-Width'), height: +resp.headers.get('X-Level0-Height'),
  };
  const blobUrl = URL.createObjectURL(await resp.blob());
  const vpRect = viewer.viewport.imageToViewportRectangle(
    new (OSD().Rect)(ext.x, ext.y, ext.width, ext.height));
  return new Promise((resolve) => {
    viewer.addTiledImage({
      tileSource: { type: 'image', url: blobUrl },
      x: vpRect.x, y: vpRect.y, width: vpRect.width, opacity: 0.5,
      success: (ev) => resolve({ item: ev.item, blobUrl }),
    });
  });
}

export function removeHeatmapOverlay(viewer, handle) {
  try { if (handle?.item) viewer.world.removeItem(handle.item); } catch { /* */ }
  try { if (handle?.blobUrl) URL.revokeObjectURL(handle.blobUrl); } catch { /* */ }
}
```
- [ ] **Step 2** — `npm run build` green. Commit `feat(agent-ui): add OSD co-navigation + heatmap overlay helpers`.

---

## Task 4 — PathAgent panel (`src/components/panels/PathAgentPanel.jsx`)

**Files:** Create `src/components/panels/PathAgentPanel.jsx`.

Fork `PathChatPanel.jsx`'s shell (header row, scroll area, input row) but render the **agent run**, not
a chat thread. Read `activeItem, tilesInfo, viewer` and the `agent*` slice + actions from `useStore()`.

- [ ] **Step 1 — Readiness banner + Prepare.** If no `agentCacheKey`/not ready, show a banner with a
  **Prepare** button → `preprocessCase(activeItem._id)` → store `cacheKey`; then poll `pollStatus`
  every ~3 s (setInterval in a useEffect, cleared on unmount / slide change), updating `agentStatus`
  and stopping when `status==='ready'|'error'`. Show `stage` + `progress` (a thin bar). This can take
  minutes (Trident) — keep the UI responsive and cancelable.

- [ ] **Step 2 — Task chips + question input.** One **Diagnosis** chip (active). A textarea + send
  button (reuse the AskPA input row). Send is disabled unless `agentStatus.ready.features` and not
  `agentRunning`.

- [ ] **Step 3 — Run the query.** On send: `resetAgentRun()`, `setAgentRunning(true)`, create an
  `AbortController` (store in a ref; Stop button aborts). Call `streamAgentQuery({itemId, cacheKey,
  question, task:'Diagnosis', signal, onEvent})`. In `onEvent(evt)`: `addAgentEvent(evt)`; and:
  - `navigate` → `pushNavRegion(evt.region + rationale)`; if `agentFollow` → `focusRegion(viewer, evt.region)`.
  - `final` → `setAgentFinal(evt)`; if `evt.heatmapTaskId` → `setAgentHeatmap({taskId: evt.heatmapTaskId, visible:false})`.
  - `error` → `setAgentError(evt.message)`.
  On stream end / abort → `setAgentRunning(false)`.

- [ ] **Step 4 — Streaming trace.** Render `agentTrace` as a compact vertical timeline, each event
  styled by type: `route`/`triage` (small meta chips), `navigate` (a clickable row → `focusRegion`
  on click, showing region + rationale), `describe` (findings text), `diagnose` (candidate list),
  `verify` (φ_l/φ_k/φ_c/φ_total mini-bars + citations), `final` (highlighted answer card). Auto-scroll
  to bottom on new events (mirror PathChatPanel's `scrollRef` effect).

- [ ] **Step 5 — Confidence badge + citations + nav trail.** When `agentFinal`: a confidence badge
  (`{confidence}%` colored by band), the answer text, the φ scores, the KB citations
  (`text — source`), and a **Navigation trail** list (each `agentNavTrail` row clickable →
  `focusRegion`).

- [ ] **Step 6 — Controls.** A **Follow/Pause** toggle (`agentFollow`) — when off, `navigate` events
  still stream + append to the trail but do NOT move the viewer (client-side pause). A **Heatmap**
  toggle — on: `addHeatmapOverlay(viewer, itemId, taskId, cacheKey)` (store the handle in a ref, set
  `agentHeatmap.visible`); off: `removeHeatmapOverlay`. A **Save annotation** button (enabled when
  `agentNavTrail` non-empty) → build a large_image annotation doc (name e.g. `PathAgent — {answer}`)
  with one `makeRectangle(x, y, x+width, y+height, {group:'ai-roi', label})` per trail region +
  a summary in the annotation `description`, then `createAnnotation(activeItem._id, doc)`; toast on
  success. A **Stop** button (abort) while running; a **Clear** button (`resetAgentRun`).

- [ ] **Step 7 — Empty/guard states.** If `!activeItem`: "Open a slide to start." Mirror AskPA styling.

- [ ] **Step 8** — `npm run build` green. Commit `feat(agent-ui): add PathAgent panel`.

---

## Task 5 — Tab + rail registration

**Files:** Modify `src/components/panels/RightPanel.jsx`, `src/components/ViewerApp.jsx`.

- [ ] **Step 1 — RightPanel.jsx:** import `PathAgentPanel`; add to `allTabs` (after the `chat` entry)
  `{ id:'agent', label:'PathAgent', show: hasRole('ai-users'), icon: <a distinct compass/route SVG> }`;
  add content switch `{rightPanelTab === 'agent' && <PathAgentPanel/>}`.
- [ ] **Step 2 — ViewerApp.jsx RightRail:** add `{ id:'agent', show: hasRole('ai-users'),
  title:'PathAgent', icon:<same compass SVG at 16px> }` to the `tabs` array.
- [ ] **Step 3** — `npm run build` green. Manually confirm (once dev server runs in Task 7) the tab +
  rail icon appear for an `ai-users` account. Commit `feat(agent-ui): register PathAgent tab + rail icon`.

---

## Task 6 — Full build + wiring sanity

**Files:** none (verification task).

- [ ] **Step 1** — `npm run build` green; grep no stray `console.log`/secrets in the new files.
- [ ] **Step 2** — start the dev server (`npm run dev`) and confirm it compiles with no runtime import
  errors on load (Task 7 exercises the live flow). Commit nothing (or a small fixup if needed).

---

## Task 7 — Live end-to-end verification (the M4 acceptance)

**Files:** Create `docs/Chen/2026-07-07-pathagent-m4-report.md`; optionally `scripts/m4_e2e.mjs`
(Playwright driver).

Stand up the live stack and drive the whole flow in a **real browser** against a **real public
BRACS slide** in the DSA. (Controller runs this; needs a Girder token — request from the user.)

- [ ] **Step 1 — Redis + gateway.** `docker run -d --name pathagent-redis -p 6379:6379 redis:7`.
  Run the gateway wired to the DSA + local slides:
  ```bash
  cd services/pathagent
  export HF_TOKEN=<hf_...>
  export PATHAGENT_GIRDER_BASE=http://192.168.191.109:9080/api/v1
  export PATHAGENT_SLIDES_ROOT=/home/chen/data2/BRCA-TEST
  export PATHAGENT_CACHE_DIR=/tmp/pathagent-m4-cache   # world-traversable (chmod 755; classifier reads it)
  uv run uvicorn pathagent.gateway.app:create_app --factory --host 0.0.0.0 --port 8000 &
  uv run rq worker pathagent --url redis://localhost:6379/0 &   # processes preprocess jobs
  ```
- [ ] **Step 2 — A real slide + token.** From the public `BRCA-DEMO/slides` folder
  (`GET /api/v1/item?folderId=…`) pick a BRACS itemId whose `name` maps to a file under
  `PATHAGENT_SLIDES_ROOT` (local-first resolver → no download). Obtain a Girder token (user-provided,
  or `POST /api/v1/user/authentication` with a login) for the browser session + the gateway auth.
- [ ] **Step 3 — Frontend.** `VITE_AGENT_API_URL=http://localhost:8000/api/agent npm run dev`.
- [ ] **Step 4 — Drive a real browser** (`npm i -D playwright && npx playwright install chromium`,
  then a small `scripts/m4_e2e.mjs`): seed `localStorage.girderToken`, open the viewer on the BRACS
  item, open the **PathAgent** tab, click **Prepare** and wait for `ready`, ask the Diagnosis
  question, and assert from the DOM/network: the trace shows `route→…→final`; the viewer viewport
  actually moved on `navigate` (check `viewer.viewport.getBounds()` changed); the **heatmap** toggle
  adds a world item; the **confidence badge** + **navigation trail** render; **Save annotation**
  POSTs and the DSA `GET /annotation?itemId=…` returns the new annotation. Screenshot each stage.
- [ ] **Step 5 — Report.** Write `docs/Chen/2026-07-07-pathagent-m4-report.md`: exec summary, scope +
  the two locked decisions (live E2E; manual save-only), what was built, the live-run evidence
  (screenshots/log, the real answer + trail + heatmap + saved annotation id), review outcome, how to
  run, follow-ups (auto-persist; redirect/resume; M3b chips), commit log, recommendation. Tear down
  the gateway/worker/redis; clean the temp cache. Commit script + report.

---

## Self-review (author)
- **Spec coverage (design §8/§9):** store slice → T2; api client → T1; panel (banner/chips/trace/
  trail/confidence/citations/heatmap/pause/save) → T4; tab+rail → T5; co-navigation + OSD overlays →
  T3+T4; live acceptance → T7. Covered.
- **Locked decisions honored:** live E2E (T7); manual save-as-annotation only (T4 step 6, no
  auto-persist).
- **Type/geometry consistency:** all gateway geometry is level-0 px → `imageToViewportRectangle`
  everywhere; `cacheKey`/`taskId` threaded consistently; `Girder-Token` on every call.
- **Secrets:** `.env.local` staging guarded in T1 (never commit the token).
```
