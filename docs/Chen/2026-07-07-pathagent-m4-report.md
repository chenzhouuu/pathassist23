# PathAgent M4 — React Panel + OSD Co-Navigation: Implementation & Verification Report

**Date:** 2026-07-07 · **Branch:** `chen` · **Frontend:** `src/` (main PathAssist repo)
**Milestone:** M4 (Plan 5 of the PathAgent series) — the in-viewer PathAgent panel that streams the
M3 agent loop, co-navigates the OpenSeadragon viewer, and saves runs to Girder.

---

## 1. Executive summary

M4 is **implemented and verified live end-to-end in a real browser.** A new **PathAgent** right-panel
opens a case against the M3 gateway, streams the merged agent loop, **drives the live OpenSeadragon
viewport** to each navigated region, overlays the attention heatmap, renders the verified/cited answer
with a confidence badge + φ-scores, supports **pause/take-control**, and **saves the visited regions as
a Girder annotation**.

**Live E2E (real Chromium → dev build → live gateway → real public DSA slide BRACS_1648):
all 12/12 checks passed.**

| Stage | Result |
|---|---|
| Auth (`?girderToken=`) + slide open (real OSD + tiles) | ✓ |
| PathAgent panel renders · Prepare → `ready` | ✓ (pre-cached case served `ready`) |
| Diagnosis query **streams** (`route→triage→8×(navigate+describe)→diagnose→verify→final`) | ✓ (21 events) |
| Final answer + confidence + **8-region trail** | ✓ (e.g. IDC/ILC, confidence 60) |
| **Co-navigation moved the viewport** | ✓ (viewport bounds changed on `navigate`) |
| **Heatmap overlay** added an OSD world item | ✓ (world items 1→2) |
| **Save-as-annotation** created a DSA annotation | ✓ (annotation count 2→3) |

Frontend `npm run build`: **green** throughout (the dev-only test handle is stripped from prod).

---

## 2. Scope & decisions locked with the user

**Delivered (design §8/§9):** the `agent*` store slice · `wsiAgentApi.js` (preprocess / status /
**SSE-over-POST** query / heatmap) · `PathAgentPanel.jsx` (readiness + Prepare · Diagnosis chip ·
streaming trace · confidence badge + φ-bars + citations · navigation trail · **pause/take-control** ·
heatmap toggle · **save-as-annotation**) · tab + rail registration (gated `hasRole('ai-users')`) ·
`agentViewerSync.js` (co-nav `fitBounds` + heatmap `addTiledImage`).

**Verification = full live end-to-end** (user's choice): a real browser drove the real panel against
a stood-up gateway (+ Redis + RQ worker) and a **real public DSA slide**, with a real Girder token.

**Deferred — documented, not built (user's + design's calls):**
- **Auto-persist every run** to Girder (design §13.4) → v1 is **manual save-as-annotation only** (no
  automatic DSA writes).
- Redirect/resume take-control → v1 is **pause-only** (client-side; the M3 checkpointer is in-memory).
- Morphology/Treatment/Report chips (M3b) → v1 chip is **Diagnosis**.

---

## 3. What was built

| File | Responsibility |
|---|---|
| `src/api/wsiAgentApi.js` | `preprocessCase` · `pollStatus` · `streamAgentQuery` (fetch + `ReadableStream` SSE parser) · `heatmapUrl`; `Girder-Token` on every call; base via `VITE_AGENT_API_URL` |
| `src/store/index.js` | `agent*` slice (trace/status/cacheKey/navTrail/heatmap/final/follow/error + setters); cleared on slide change (keeps `agentFollow`) |
| `src/components/panels/agentViewerSync.js` | `focusRegion` (level-0 px → `imageToViewportRectangle` → `fitBounds`), `addHeatmapOverlay`/`removeHeatmapOverlay` (`addTiledImage` at the level-0 extent from `X-Level0-*` headers) |
| `src/components/panels/PathAgentPanel.jsx` | the panel (banner/Prepare, Diagnosis, streaming trace, final card + φ-bars + citations, nav trail, controls) |
| `src/components/panels/RightPanel.jsx`, `src/components/ViewerApp.jsx` | tab + compass rail icon (gated `ai-users`) |
| `services/pathagent/scripts/m4_e2e.mjs` | Playwright live-E2E driver (12 assertions) |

**Coordinate contract:** all gateway geometry is **level-0 image px**; the panel converts via OSD
`imageToViewportRectangle` for both co-navigation and the heatmap extent (design §13.1/§13.3).

---

## 4. Verification

**Live browser E2E** (`services/pathagent/scripts/m4_e2e.mjs`): real Chromium loads the dev build,
authenticates via `?girderToken=`, opens BRACS_1648, and then drives the **real PathAgent panel DOM**
— clicking Prepare, typing the Diagnosis question, watching the stream, toggling the heatmap, and
saving. All 12 assertions passed (§1). Slide-opening (existing, non-M4 functionality) is done through a
dev-only `window.__pathStore` handle so the test is deterministic; **every M4-specific interaction is a
real DOM click/keypress**, and results are asserted from the live store + OSD viewport + the DSA.

**Live stack stood up for the run:** `docker run redis:7` · `uvicorn pathagent.gateway.app` on `:8000`
wired to the DSA (`PATHAGENT_GIRDER_BASE=…:9080`) · `rq worker` · BRACS_1648 pre-cached to `ready`
(real conch_v1 + uni_v1 + BRCA classifier) · dev server with `VITE_AGENT_API_URL=…:8000/api/agent`.

**Backend cross-check:** a direct `curl` to the live `/query` produced the full real stream (route →
… → final, ILC, φ_c 0.774, 8-region trail, heatmapTaskId, 4 KB citations) — confirming the gateway +
auth + slide path independently of the browser.

---

## 5. Bugs found & fixed during the live run

| Sev | Issue | Fix |
|---|---|---|
| **Important** | The SSE reader split frames on `\n\n`, but `sse-starlette` delimits events with `\r\n\r\n`, so **no frame ever parsed** and the panel showed an empty trace. A direct `curl` test missed it (it bypassed the JS parser) — the **live browser run caught it**. | Strip `\r` before framing (`6dfd4c8`). |
| Minor (harness) | The E2E's save step raced the final-card re-render + used a loose `/Save/i` selector → intermittent miss. | Exact `Save ROIs` selector + settle wait + poll the DSA count. (Product code was correct — a debug trace confirmed `POST /annotation → 200`.) |

**Pre-existing latent bug noted (not in scope, not replicated):** `AIPanel.focusRoi` and
`WsiResultCard.locateRoi` pass **raw image-px** to `viewport.fitBounds` without
`imageToViewportRectangle`; the viewer uses the standard normalized viewport, so those "locate ROI"
jumps are geometrically off. M4's `focusRegion` does the correct transform (verified: co-navigation
moved the viewport to the right regions in the live run).

---

## 6. How to run (live)

```bash
# 1) backend
docker run -d --name pathagent-redis -p 6379:6379 redis:7
cd services/pathagent
export HF_TOKEN=<hf_...> PATHAGENT_GIRDER_BASE=http://192.168.191.109:9080/api/v1 \
       PATHAGENT_REDIS_URL=redis://localhost:6379/0 PATHAGENT_CACHE_DIR=/tmp/pathagent-cache
mkdir -p $PATHAGENT_CACHE_DIR && chmod 755 $PATHAGENT_CACHE_DIR
uv run uvicorn pathagent.gateway.app:create_app --factory --host 0.0.0.0 --port 8000 &
uv run rq worker pathagent --url redis://localhost:6379/0 &
# 2) frontend (dev) — point the panel at the gateway
cd ../..; VITE_AGENT_API_URL=http://localhost:8000/api/agent npm run dev
# open a slide → PathAgent tab → Prepare → ask a Diagnosis question.
# 3) automated E2E (optional): npm i -D playwright && npx playwright install chromium
#    M4_TOKEN=<girderToken> M4_APP_URL=http://localhost:3000 node services/pathagent/scripts/m4_e2e.mjs
```
In production the gateway is reverse-proxied at `/api/agent` (nginx), so `VITE_AGENT_API_URL` is unset.

---

## 7. Follow-ups (none blocking)

- **Auto-persist every run** as a provenance annotation (design §13.4) — the deferred half of §8.
- **Redirect/resume** take-control (durable checkpointer) — beyond v1 pause-only.
- **Region-pixel description** (fetch Girder `/tiles/region` crops so `describe` is pixel-grounded).
- Fix the pre-existing `AIPanel`/`WsiResultCard` `fitBounds` geometry (out of M4 scope).
- **Bundle size**: the app is a single ~950 KB chunk (pre-existing) — code-split later.
- M3b task chips (Morphology/Treatment/Report) + M5 eval/calibration.

---

## 8. Commit log (this milestone)

```
2d575cb test(agent-ui): add live browser E2E harness + dev-only store handle
6dfd4c8 fix(agent-ui): parse CRLF-delimited SSE frames
b38a77c feat(agent-ui): register PathAgent tab + rail icon
eb44c57 feat(agent-ui): add PathAgent panel
9563f6d feat(agent-ui): add OSD co-navigation + heatmap overlay helpers
d243208 feat(agent-ui): add agent* store slice
411c5dc feat(agent-ui): add PathAgent gateway API client
52b9fc6 docs(plan): add PathAgent M4 frontend panel + co-navigation plan
```

## 9. Recommendation

M4 is complete and live-verified. The full PathAgent series **M0→M4** now delivers, on this box, an
in-viewer copilot: **preprocess → Trident CONCH backbone → UNI consensus + BRCA classifier → the
merged verified/cited/navigable Diagnosis loop → a React panel that streams it, co-navigates the
slide, overlays the heatmap, and saves the run to Girder.** Next is **M5** (Patho-Bench/SlideBench
eval + calibration) and the deferred auto-persist / M3b task fan-out.
