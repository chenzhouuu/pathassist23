# PathAgent v2 — R11 CellViT Deployment Design

- **Date:** 2026-07-21
- **Status:** Design for review (design-before-code)
- **Builds on:** `2026-07-20-pathagent-v2-orchestrator-agent-sdk-rfc.md` (D1–D8). This
  is the concrete deployment design for that RFC's **R11 — Real CellViT**, now that the
  plan-era stack is retired (R10.9) and the autonomous `/turns` loop is the only flow.
- **Decision owner:** Chen.

---

## 0. Goal

Swap the canned `run_segmentation` stub for **real nuclei segmentation** on a region of a
whole-slide image (WSI), behind the existing `run_server_tool` seam — so the event
contract, the `ArtifactHandle`, and the React overlay all stay unchanged. Seed with one
real tool (CellViT); prove the plumbing end-to-end: *agent asks → real GPU segments the
region → real nuclei stream back as a handle → overlay paints them*.

---

## 1. Locked decisions

Two product/infra forks were resolved with Chen; the rest follow from the deployment
research (`docs/Chen/` research pass, 2026-07-21) and our existing architecture.

| # | Decision | Rationale |
|---|----------|-----------|
| L1 | **License posture: research / internal, non-commercial.** CellViT is cleared for use (cite the papers). | Chen's call. CellViT's code carries a **Commons Clause** and its PanNuke training data is **CC BY-NC-SA (non-commercial)** — both would block a commercial/clinical product, but not research use. If the posture ever changes, see K1 (swappable seam). |
| L2 | **Model: `CellViT-SAM-H`** via the packaged **`pip install cellvit`** (`CellViT-Inference` v1.0.9), not the training repos. | Chen has a **≥24 GB VRAM GPU** (SAM-H's requirement). The packaged inference path is the deployment-facing artifact; own image on CUDA 12.1 + torch 2.2.2 beats the stale `ikimhoerst/cellvit:beta`. Gives full PanNuke 5-class nucleus typing + GeoJSON output. |
| L3 | **CellViT runs as a separate GPU microservice**, called by the gateway's `run_segmentation` handler over a tiny region-scoped **HTTP** contract. Not in-process; not an SDK-external MCP server. | Keeps the gateway CPU-light and horizontally scalable (each turn already spawns a `claude` subprocess). The 24 GB GPU lives on one shared inference box. Token/scope stay server-side (D3): the handler closes over `ToolContext`; the model only ever calls `run_segmentation`. |
| L4 | **Region-scoped, synchronous call for v1 — no MCP async.** A bounded ROI (≤ a few 1024² tiles) is seconds; the loop `await`s the tool and the tool card spins. | Avoids the immature MCP async-task path (RFC Risk #2). Whole-slide + progress is genuinely async and is deferred to R12 (YAGNI here). |
| L5 | **We own region input + coordinate re-offset.** The CellViT service reads the ROI's pixels from Girder's `large_image` **region endpoint**, runs CellViT, and returns geometry re-offset to **level-0 slide pixels** (D8). | Research finding: CellViT has **no region API** — it is WSI-centric and tiles internally. Feeding it a region and mapping coords back is the main integration cost, and it must live on our side of the boundary. |
| L6 | **Artifact contract unchanged.** The service returns centroids (+ optional GeoJSON); the handler wraps them in the existing `ArtifactHandle`; the overlay fetches out-of-band. Durable **DSA-annotation** backing is deferred to R12. | R9/R10 already proved handle → overlay. Reuse it; don't rebuild it. |

---

## 2. Architecture

```
┌───────────────── React WSI viewer ─────────────────┐
│ OpenSeadragon · NucleiOverlay · CopilotPanel        │
│   ▲ paints nuclei (out-of-band fetch)               │
└───┼─────────────────────────────────────────────────┘
    │ SSE typed trace          │ GET artifact (geometry)
┌───┼──────────────────────────┼──────────────────────┐
│ FastAPI gateway (CPU-light)  │                       │
│  Claude Agent SDK loop (per turn)                    │
│   model calls  run_segmentation(bbox?)               │
│        │                                             │
│   run_segmentation handler  (closes over ToolContext:│
│        │                     owner + Girder token)   │
│        └────── HTTP POST /segment ──────┐            │
│                {slide_ref, bbox, token} │            │
└─────────────────────────────────────────┼────────────┘
                                           ▼
                       ┌──────────── CellViT service (GPU box) ────────────┐
                       │ FastAPI + `cellvit` (SAM-H), CUDA 12.1/torch 2.2.2│
                       │  1. read ROI pixels: Girder large_image `region`  │
                       │     endpoint (token, at slide MPP)                │
                       │  2. cellvit inference (internal 1024/64 tiling)   │
                       │  3. re-offset coords → level-0 slide pixels       │
                       │  4. return {count, centroids[, geojson]}          │
                       └───────────────────────────────────────────────────┘
                                           │ reads pixels
                                           ▼
                                   Girder / DSA (tiles, token auth)
```

**Boundaries (each unit testable in isolation):**

- **Gateway `run_segmentation` handler** — pure orchestration: build the request from
  `ToolContext` + args, call the service, wrap the response as `ToolOutcome` /
  `ArtifactHandle`. No GPU, no pixels. Tested against a *fake* CellViT service.
- **CellViT service** — a self-contained HTTP app: `region-read → infer → re-offset`.
  Each of the three is a function with a clear contract; the coordinate re-offset is a
  **pure function** with unit tests. Tested with a fake Girder region source + (in CI) a
  mocked model; the real model runs in a manual GPU smoke.
- **Coordinate contract (D8)** — every bbox in, every centroid out is **level-0 pixels**.

---

## 3. The CellViT inference service

A small FastAPI app, packaged in its own image, added to `docker-compose` as a
GPU-reserved service (`deploy.resources.reservations.devices` / `--gpus all`).

### 3.1 HTTP contract

```
GET  /health                          → {status, model, device, gpu}
POST /segment                         → {count, centroids, geojson?, mpp, bbox}
  body: {
    slide_ref:  str,                  # Girder item id
    bbox:       {x,y,width,height},   # level-0 pixels (the ROI to segment)
    girder_token: str,                # server-to-server; NEVER a model arg (D3)
    classes?:   [str],                # optional PanNuke class filter
  }
```

- `centroids`: `[[x, y, class], …]` in **level-0 slide pixels** — the light payload the
  overlay needs. `count = len(centroids)`.
- `geojson`: optional polygon output (QuPath/DSA-compatible) for R12 durable annotations;
  omitted in v1 to keep the payload small.

### 3.2 Internals

1. **Region read** — `GET {girder}/item/{slide_ref}/tiles/region?left,top,right,bottom&…`
   with the `Girder-Token` header, requesting the region at the slide's native
   magnification (MPP from `…/tiles` metadata). Returns the ROI as an ndarray.
2. **Inference** — feed the region to CellViT-SAM-H. **Two candidate paths (R11.0 spike
   decides):**
   - **(a) direct-array:** call cellvit's internal inference function on the ROI ndarray,
     passing the slide MPP (cellvit upscales to its 0.25 µm/px training standard). Lower
     latency, no temp file — but uses a non-public API (version-brittle).
   - **(b) mini-WSI:** write the ROI as an OpenSlide-readable pyramidal TIFF (`pyvips`),
     run the packaged `process_wsi`, read the JSON back. Robust (public CLI) but heavier
     (temp file + subprocess).
3. **Re-offset** — cellvit returns region-local coords; add `(bbox.x, bbox.y)` (and divide
   by the resample scale if we requested a non-native magnification) → level-0 slide
   pixels. Pure function, unit-tested.

### 3.3 Container

- Base: `nvidia/cuda:12.1.*-runtime` (or a torch 2.2.2 base) → `pip install cellvit`.
- Weights auto-download + cache (needs ≥3 GB cache volume); pin a cache path as a mounted
  volume so the ~1–2 GB SAM-H checkpoint survives restarts and isn't re-downloaded.
- `GET /health` reports `device` and whether CUDA is actually visible (fail loud if the
  GPU isn't mapped in — the analog of the R10 non-root container lesson).

---

## 4. Gateway integration

Change is confined to the server-tool executor + the tool schema; the loop, events, and
overlay are untouched.

- **`loop/tools.py` `run_server_tool`** — replace `_stub_nuclei_geometry` with an HTTP
  call to the CellViT service (base URL from settings). Map `{count, centroids}` →
  `ToolOutcome(summary="segmented N nuclei …", artifact=handle)`; on service error →
  `ToolOutcome(ok=False, …)` (already surfaces as `ToolCallResult(ok=False)`).
- **`loop/sdk_tools.py` `_SCHEMAS["run_segmentation"]`** — add an optional `bbox` argument
  (level-0 px) so the agent can measure a region it **navigated to**, not only the drawn
  ROI (closes gap ④). Resolution order for the segmented region: explicit `bbox` arg →
  `scope.roi` (drawn box) → viewport → whole-slide (a whole-slide ask routes to the R12
  async path, not v1).
- **Token into `ToolContext`** — the RFC has the user's Girder token "join at R11." Thread
  the validated `Girder-Token` from the turn request into `ToolContext`, so the handler
  can pass it to the CellViT service. The model never sees it (D3). This is the gateway's
  first read of pixels — until now Girder was only an auth oracle.
- **Settings** — add `CELLVIT_SERVICE_URL` (+ absent ⇒ keep the canned stub, so the
  keyless/dev path and tests still work without a GPU).

---

## 5. Build ladder (stub-first · TDD · one manually-testable increment per rung)

- **R11.0 — Spike (throwaway, no production code):** on the GPU box, resolve the two
  unknowns: (a) does the **direct-array** inference path work (region ndarray + MPP), or
  must we fall back to **mini-WSI**? (b) confirm SAM-H fits/latency on the actual GPU.
  Output: a one-paragraph verdict that fixes §3.2's path. Also confirms weight download +
  license acceptance.
- **R11.1 — Service skeleton on a stub.** FastAPI app + GPU image + `/health` + `/segment`
  returning **canned geometry** (no model yet). Compose service up; `curl` it. *(Framework
  on a stub — mirrors R7.)*
- **R11.2 — Real region read + real inference + re-offset.** Wire Girder region read →
  cellvit (the R11.0 path) → coordinate re-offset. Manual smoke on one real slide ROI;
  unit-test the re-offset function.
- **R11.3 — Gateway wiring.** `run_server_tool` → HTTP call; `bbox` arg (gap ④); token
  into `ToolContext`. Route/loop tests against a **fake** CellViT service; the seam swap is
  invisible to the event contract.
- **R11.4 — Overlay real nuclei.** End-to-end: ask the copilot to count in a region → real
  nuclei paint on the slide. (Handle → overlay path already works; verify with real
  centroid counts.)

---

## 6. Deferred to R12 (explicitly out of scope here)

- **Whole-slide segmentation + async task/progress** (`task_id`, `tool_progress`, the
  non-blocking progress card). v1 is region-scoped + synchronous.
- **Durable DSA-annotation backing** for artifacts (overlays surviving reload); v1 keeps
  the in-memory artifact store.
- **Per-session token lifecycle** hardening (v1 passes the turn's token straight through).
- **Classifier hot-swap** (breast/colorectal/mitosis heads); v1 ships the default PanNuke
  5-class.

---

## 7. Testing strategy (TDD)

- **Coordinate re-offset** — pure function; table of (bbox, region-local pt, scale) →
  level-0 pt. The riskiest math, so the most-tested.
- **Gateway handler** — `run_server_tool` against a fake CellViT HTTP service (httpx mock):
  success → handle with the right count; service 5xx → `ok=False`; bbox-arg vs scope-roi
  vs viewport resolution order.
- **Schema** — `run_segmentation` accepts optional `bbox`; the loop dispatches it as a
  server tool with the resolved region.
- **CellViT service** — region-read against a fake Girder region source; inference mocked
  in CI (no GPU); the real model is a **manual GPU smoke** (like the R10 Claude smoke).
- Existing loop/turn/artifact tests must stay green — the seam swap changes no contract.

---

## 8. Risks

1. **Region-API friction (§3.2).** CellViT has no region interface; the R11.0 spike must
   land one of the two paths. If both are worse than expected, fall back to feeding
   individual 1024² tiles and stitching ourselves (we control the tiler).
2. **GPU latency in-turn.** A large ROI could exceed a comfortable synchronous wait. Bound
   v1 to a max ROI area; anything larger routes to the R12 async path (fail-friendly
   message, not a hang).
3. **Coordinate/MPP drift.** Wrong magnification or offset → nuclei painted in the wrong
   place. Mitigated by the pure re-offset function + a real-slide visual smoke at R11.4.
4. **Weight download / image size.** ~10 GB image, ~1–2 GB weights auto-download. Cache
   volume + `/health` GPU check to fail loud.
5. **Version brittleness of the direct-array path.** If we pick §3.2(a), pin `cellvit`
   and cover the internal call with a smoke that breaks loudly on upgrade.

---

## 9. Open items (spike questions for R11.0)

- **K1 (swap insurance):** keep `run_segmentation` model-agnostic behind `run_server_tool`
  so Cellpose/StarDist (BSD-3) can drop in if the license posture ever shifts (L1). The
  service HTTP contract (§3.1) is the portable boundary — no CellViT specifics leak into
  the gateway or the event stream.
- Direct-array vs mini-WSI (§3.2) — the one blocking unknown.
- Native-magnification region read vs requesting 40× (does cellvit's region path accept an
  MPP arg, avoiding scale math?).
