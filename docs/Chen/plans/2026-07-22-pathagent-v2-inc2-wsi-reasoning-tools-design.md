# Increment 2 — WSI Reasoning Tools (Navigator + Perceptor), harvested from PathAgent

> **Status:** 🟢 design reviewed + amended (F1 resolved; F2–F6 folded in). Ready to plan Inc 2a.
> **Date:** 2026-07-22
> **Depends on:** the shipped R7–R11 copilot spine (SDK loop, two-class tools, artifacts-as-handles,
> typed SSE, CellViT-SAM-H) and Increment 1 (typed nuclei counts).
> **Aligns with:** the Approach A roadmap — one agent (Claude) over a *shared tool library*, every
> number tool-derived.

## 0. TL;DR

We integrate the **PathAgent** (ECCV 2026, arXiv 2511.17052) capability *not* as a nested black-box
agent, but by **harvesting its two off-the-shelf pathology models as new shared tools** and letting
**Claude be the Executor**:

| PathAgent role | Backing model | We do with it |
|---|---|---|
| **Navigator** — locate task-relevant micro-regions | PLIP (pathology CLIP) | new server tool `find_regions(query)` over a **whole-slide PLIP index** |
| **Perceptor** — extract morphology cues from real pixels | **MedGemma** (Gemma-3 medical VLM) — swapped in for PathAgent's Patho-R1 (see Model choice) | new server tool `describe_region(bbox, mag)` — magnification-aware large_image read (§3.0) |
| **Executor** — weave findings into an evolving NL trajectory | Qwen3-4B | **dropped — Claude does this natively** |

**Dropped from PathAgent:** Qwen3-4B orchestration (Claude replaces), Quilt-LLaVA per-patch generic
descriptions (on-demand Perceptor replaces), CLAM patch-PNG dumps (we read the Girder/large_image
pyramid directly — which also gives us **real pyramid magnification** instead of PathAgent's
crop-pseudo-zoom).

**Kept & adapted:** a per-slide **PLIP embedding index** (needed for `find_regions`), built in the
background from large_image reads (R12-style async), keyed by `item_id`.

**Scope & claims (F6):** dropping Qwen3-4B + Quilt-LLaVA makes this a PathAgent-**inspired**
interpretable-reasoning capability, **not a reproduction** — the paper's benchmark numbers do not
transfer and are not promised. Framing: "interpretable WSI Q&A over regions"; any accuracy claim ties
to our own evaluation, not the paper's.

**Model choice — MedGemma, not PathAgent's Patho-R1 (amended):** the Perceptor *role* is PathAgent's,
but we back it with **MedGemma** (Google's Gemma-3 medical VLM) instead of Patho-R1-7B. Why: MedGemma's
license is commercial-capable (Patho-R1 is CC-BY-NC-ND, non-commercial), it is lighter (4B) and
Google-supported, and route A makes the Perceptor a *describer* (Claude reasons), so Patho-R1's RL-CoT
edge is moot. The service loads it generically (`AutoModelForImageTextToText`), so the exact checkpoint
(e.g. `google/medgemma-4b-it`) is just a config value.

## 1. Why route A (dissolve), not B (black-box)

PathAgent is itself a Qwen-driven multi-step agent. Nesting it under Claude would mean *two brains*:
Qwen actually reasons, Claude only relays. Route A instead treats PathAgent's **scientific
contribution (the orchestration) as something Claude performs**, and its **reusable asset (PLIP for
retrieval) as a tool** — with a pathology-capable VLM (**MedGemma**) for the Perceptor rather than
PathAgent's Patho-R1 (see Model choice). Benefits, all concrete to this repo:

- **One agent.** Claude's reasoning/self-reflection/streaming/interruptibility beat Qwen3-4B, and the
  chain-of-thought maps directly onto the existing typed events (`ReasoningDelta`, `TextDelta`,
  `ToolCallStart`, `ToolCallResult`) — no new streaming path for a sub-agent's trace.
- **Cheapest offline step is gone.** The Quilt-LLaVA whole-slide description pass (the most expensive
  preprocessing in PathAgent) is not needed; Perceptor runs on demand.
- **Better than the paper.** "Adaptive Magnification" becomes a genuine pyramid read at a target
  objective power (via a magnification-aware large_image read, §3.0), not a crop of an
  already-extracted 4096px patch.
- **Roadmap fit.** This is exactly the Approach A shape: a shared tool library, numbers from tools.

## 2. The PathAgent loop, and how Claude reproduces it

PathAgent's online loop (`pathagent.py::main`), for reference:

```
q_emb = PLIP.encode_text(question)
seed  = top-10% patches by cos(patch_emb, q_emb)                 # Navigator
loop (≤5):
  Perceptor(top-5 real patches) → question-specific descriptions  # Perceptor
  Executor 3-step: answer? / sufficient? / missing_info + zoom?    # Executor (Qwen)
  branch: sufficient → summarize → answer
          zoom       → split top-2 into sub-patches, PLIP-pick best, Perceptor, answer
          else       → retrieve top-5% by missing_info, accumulate, repeat
```

Under route A, **Claude is the Executor**, and each PathAgent primitive is a tool call:

```
Claude (Executor):
  find_regions(question)                → candidate bboxes (Navigator/PLIP)
  describe_region(bbox, mag=low)  ×N    → morphology evidence (Perceptor/MedGemma)
  <native reasoning>: is this enough? what's missing?
  if need detail:  pan_zoom_to_region(bbox); describe_region(bbox, mag=high)   # real pyramid zoom
  if need breadth: find_regions(missing_info)   → more candidates
  <native answer + explanation, grounded in the region descriptions>
```

The `_MAX_TURNS=16` guard already bounds this loop. `sufficient?`/`missing_info` become Claude's own
reflection rather than three brittle Qwen JSON calls.

## 3. New tools (contract)

Both are **server** tools (run in the gateway with the user's Girder token, D3), registered in
`services/agent/src/agent/loop/tools.py::_TOOLS`, executed via `run_server_tool`, mirroring
`run_segmentation`.

### 3.0 Magnification is first-class (native labels + real pyramid) — resolves F1

Slides in Girder carry their **native objective magnification** in tile metadata
(`/item/{id}/tiles` → `magnification`, e.g. 40×), already read across the frontend
(`ViewerPanel.jsx:112`, `pathChatApi.js:50`). And large_image already serves a **level-0 bbox at any
target magnification**, downsampling from the right pyramid level server-side — the frontend's
`getRegionImageBlob` (`src/api/index.js:241`) does exactly this (`units:'base_pixels'`,
`left/top/regionWidth/regionHeight`, `magnification`, output cap `width`/`height`). There is even an
established **VLM patch convention**: `wsiAnalysis.js` reads **512 px @ 10× ≈ 0.5 mm FOV**
(`PATCH_OUTPUT=512`, `PATCH_MAG=10`, region-px `= 512 · nativeMag/targetMag`).

So the copilot's tools speak **objective power** (5×/10×/20×/40×) — the pathologist's vocabulary and
the paper figure's labels ("described region at 20×") — not raw mpp/scale. Rules:
- The service reads native `magnification` (+ `mm_x`) from `/tiles`, and **clamps every request to
  native** — a 20×-scanned slide has no real 40×; over-asking reads native and reports the true mag.
- **Adaptive Magnification is real:** to drill in, the copilot re-calls `describe_region` on an inner
  bbox at a **higher `magnification`** — a genuine pyramid read, not PathAgent's 4096-crop pseudo-zoom.
- This is a **port of a proven in-repo pattern** into the pathvlm service, not novel risk (see F1).
  CellViT's `fetch_region` stays native (`scale=1.0`) — correct for its own mpp resampling; the
  Perceptor reader is a **separate magnification-aware reader**.

### 3.1 `describe_region` (Perceptor) — *ships first, needs no index*

```
describe_region(bbox: {x,y,width,height}, magnification?: int, focus?: str) -> ToolOutcome
  summary:  a compact morphology description of the region, tagged with the magnification used
  artifact: optional — the described region as a rectangle handle (for the evidence overlay)
```
`focus` is a Claude-supplied hint ("focus on nuclear atypia") that directs the Perceptor prompt —
PathAgent always passes the question to its Perceptor; undirected "describe this" is much weaker.
- Reads the region from large_image at a **target `magnification`** (adopting the `getRegionImageBlob`
  recipe on the Python side: `units='base_pixels'` + `magnification` + output cap), pinned to a
  Perceptor input contract (target mag + output px, mirroring `wsiAnalysis.js`'s 512 px), then runs
  **MedGemma**. Returns the **actual** magnification used (post-clamp) for grounding + the trace.
- Region = explicit model bbox, else the drawn ROI (`scope.roi`), else current viewport (D8).
- Reuses the `_MAX_SEG_AREA` guard idea (bound the read).
- **Grounding contract (F3).** A Perceptor description is MedGemma's *hedged observation* (its own
  prompt: "never a definitive diagnosis"), not ground truth. The summary carries provenance —
  "MedGemma at {mag}× on region ({x},{y}): …" — and `_SYSTEM` (`sdk.py`) is extended to forbid Claude
  upgrading a description to a verdict or laundering it into a confident slide-level claim (parallels
  the Inc1 "PanNuke fraction ≠ TILs score" clause). Claude may *weigh* descriptions across regions; it
  must attribute, not assert.
- **Cost budget (F5).** Each call is a 7B VLM inference (seconds). A soft per-turn cap on
  `describe_region` + prompt guidance ("look before you drill") keeps a reasoning turn bounded;
  `_MAX_TURNS=16` bounds count but not cost, and GPU placement (§8) must avoid CellViT contention.

### 3.2 `find_regions` (Navigator) — *the async/index piece*

```
find_regions(query: str, k?: int) -> ToolOutcome
  summary:  "found K regions relevant to '<query>'" (+ top scores)
  artifact: the K bboxes (rectangles) as a handle → candidate overlay
```
- Requires a **whole-slide PLIP index** for `scope.item_id` (see §4). PLIP-encodes `query`, returns
  the top-K tiles by cosine similarity as level-0 bboxes + scores.
- If the slide is not yet indexed: kick off the background index build and return a *pending*
  outcome (`ok=True`, summary = "Indexing this slide (…%). Ask again in a moment."). This is the
  R12 async surface.

## 4. Whole-slide PLIP index (the heavy async piece)

- **What:** tile the slide on a grid **at a fixed magnification** matched to PLIP's training FOV (read
  via the same magnification-aware reader, §3.0; the exact level is an open param, §8), PLIP-encode
  each tile, store `{coords(level-0, base_pixels) → embedding}` + tiling metadata. Tile bboxes stay
  level-0 so `find_regions` results line up with the overlay and `pan_zoom_to_region` (F7).
- **Where:** persisted per slide, keyed by `item_id` **and index version** (PLIP model id + **tiling
  magnification** + tile params). Candidate stores: a Girder file/item-metadata blob, or the pathvlm
  service's own cache volume. (Decision deferred to review; Girder keeps it co-located with the slide
  and multi-worker safe.)
- **When:** built lazily on the first `find_regions` for an un-indexed slide; a background job with a
  status endpoint. Retrieval is then fast (seconds). **Hard dependency (F2):** the loop is single-turn
  with no server-side session (`sdk.py`), so it cannot resume a turn when the job finishes — an
  R12-style async task + status + re-invocation surface is a **prerequisite of Inc 2b**, not an add-on.
  Until it exists, `find_regions` on an un-indexed slide returns a *pending* outcome and the user
  re-asks. (`tools.py` already defers whole-slide/async to R12.)
- **Staleness:** re-index if the version key changes; never serve a stale-version index silently.

## 5. Service architecture

New `services/pathvlm/` GPU service (Flask, mirroring `services/cellvit/`), holding **PLIP** and
**MedGemma**. Endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /index` (slide_ref, token) | build/refresh the whole-slide PLIP index (long/async) |
| `GET  /index/status` (slide_ref) | progress % / ready |
| `POST /find_regions` (slide_ref, query, k, token) | top-K bboxes + scores (requires index) |
| `POST /describe_region` (slide_ref, bbox, magnification, token) | MedGemma morphology description |

- **Region-read reuse:** `/describe_region` needs the exact "read a level-0 bbox at a target mpp from
  Girder large_image" logic CellViT already has. Factor it into a small shared helper or duplicate it
  (the cellvit package is GPU-only Docker; cross-service imports are awkward — expect a vendored
  duplicate, consistent with the vendored-taxonomy precedent in Inc1).
- **GPU footprint:** PLIP (small) + MedGemma-4B (moderate). Decide co-location vs a second GPU vs sharing
  the CellViT GPU (§8). This is the main infra risk.
- **Gateway client:** `services/agent/src/agent/loop/pathvlm_client.py`, mirroring `segmenter.py`
  (async httpx, generous timeout, token server-side). `ToolContext` gains a `pathvlm_url` field
  next to `cellvit_url`.

## 6. Artifacts, events, coordinates

- **New artifact kind `regions`** (rectangles), alongside `nuclei` (points). Written to the
  ArtifactStore; only a handle rides SSE (D4). Persist as DSA **rectangle** elements so evidence
  regions survive reload and show in the Annotations panel. **Net-new, not a mirror (F4):**
  `GirderAnnotationStore.put/get` builds/parses *point* elements only — `regions` needs a new
  rectangle element builder (width/height + per-element `lineColor`, green candidate / red
  zoom-selected, Inc1 precedent) and matching `get()` parsing. The point path is a *template*, not a
  base to extend.
- **Events:** unchanged. `find_regions` / `describe_region` are ordinary `ToolCallStart` /
  `ToolCallResult`; the reasoning is Claude's native `ReasoningDelta` / `TextDelta`.
- **Coordinates:** level-0 pixels throughout (D8) — aligns with PathAgent's `x_y` patch naming and
  with CellViT.

## 7. Frontend

The interpretable trajectory is the whole selling point; the UI must make the CoT visible.

1. **Region overlay** — a **net-new** `RegionOverlay.jsx` (templated on `NucleiOverlay.jsx`, but
   rectangles not dots): draw green-candidate / red-zoom-selected boxes via the same canvas +
   `imgToViewer` re-projection. Recreates the paper's CaseStudy figure.
2. **Reasoning-trace panel** (RightPanel): a timeline of the Executor's steps (find → describe →
   reflect → zoom → answer); each step click-jumps (pan/zoom) to its evidence region. Fed by the
   existing typed events.
3. **Adaptive-magnification animation:** when Claude drills in, it calls the existing client tool
   `pan_zoom_to_region`, so the viewer visibly flies in before the higher-mag `describe_region`.
4. **Evidence gallery:** thumbnails of described regions with their Perceptor text; hover → locate.
5. **Answer card:** answer + explanation + the standing "research use, not a diagnosis" line.

## 8. Open questions / risks (for review)

1. **GPU placement** for MedGemma + PLIP (co-locate w/ CellViT? second GPU?). *Main infra risk.*
2. **Index storage** (Girder blob vs service cache) and **size** (embeddings × thousands of tiles).
3. **Tiling magnification** (which objective power to index at, §3.0) to match PLIP's training FOV —
   mis-match hurts recall. Now expressible in the native-mag vocabulary; still needs picking + testing.
4. **MedGemma on real pyramid reads:** its SigLIP encoder saw histopathology among other medical
   images; validate it describes genuine high-res large_image crops well at each magnification.
5. **Async task surface (F2, hard dep of Inc 2b):** the R12-style background job + status + turn
   re-invocation for the index build — a prerequisite, plus a clean "indexing…" affordance.
6. **Executor guardrails (F5):** how Claude decides `k`, when to stop, and a soft per-turn
   `describe_region` cap so a turn doesn't fan out into many costly VLM calls. Prompt + `_MAX_TURNS`.

## 9. Suggested slicing (buildable order)

- **Inc 2a — Perceptor first.** `describe_region` alone (no index, no async; new magnification-aware
  region reader §3.0 + pinned MedGemma contract). Immediately useful ("what's in this region at 20×?"),
  lowest risk, proves MedGemma in the stack.
- **Inc 2b — Navigator.** Whole-slide PLIP index + `find_regions` — **gated on the R12 async task
  surface (F2)** for the background build/status/re-invocation.
- **Inc 2c — Frontend.** net-new `RegionOverlay`, trace panel, adaptive-mag animation, evidence gallery.

Each slice follows the repo's design → adversarial review → task-by-task TDD rhythm.

---

**Next step:** review complete (`…-inc2-wsi-reasoning-tools-design-review.md`; F1 resolved, F2–F6
folded above). Proceed to the **Inc 2a `describe_region`** task-by-task TDD plan — the one slice with
no index and no async dependency.
