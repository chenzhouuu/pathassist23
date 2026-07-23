# Adversarial Review — Increment 2 WSI Reasoning Tools design

> **Reviews:** `2026-07-22-pathagent-v2-inc2-wsi-reasoning-tools-design.md`
> **Method:** code-grounded, adversarial. Every claim checked against the actual repo seams
> (`services/cellvit/`, `services/agent/src/agent/loop/`) and the PathAgent source.
> **Verdict:** the *direction* (route A + whole-slide index) holds up and fits Approach A. But the
> design **understates the work in Inc 2a** and **under-weights a hard infra dependency in Inc 2b**.
> **0 blocking + 5 should-fix + 1 open** (F1 resolved by a user-flagged in-repo pattern — see below).
> Fold F2–F6 in before writing the Inc 2a plan.

---

## What holds up

- **Route A (dissolve, not nest).** Correct. The SDK loop already emits the exact event family a
  Claude-as-Executor CoT needs (`ReasoningDelta`/`TextDelta`/`ToolCallStart`/`ToolCallResult`,
  `sdk.py`), and `tools.py` already carries a per-turn `ToolContext` with a service URL + server-side
  token (`cellvit_url`, D3). Adding `pathvlm_url` + two server tools is a genuine mirror of the
  CellViT wiring.
- **Level-0 coordinate frame.** PathAgent's `x_y` patch naming, CellViT's region reads, and the
  overlay all agree on level-0 px (D8). No conversion layer needed.
- **Build order 2a → 2b → 2c.** Right instinct — and the findings below make it *mandatory*, not just
  preferred (2b is blocked on infra 2a doesn't need).

---

## Findings

### F1 — RESOLVED · magnification-aware region read is a proven in-repo pattern (user-flagged)
*Original concern:* `fetch_region` (`services/cellvit/src/cellvit_service/region.py:43`) reads only
native (`scale=1.0`, no magnification/downsample param), so `describe_region`'s core mechanism — hand
Patho-R1 the *right* image at the *right* magnification — looked undesigned, and "real pyramid
magnification via reuse" looked overstated.

*Resolution (grounded, prompted by the user's note that Girder carries 5×/10× labels):* the mechanism
is a **port of a pattern this repo already ships**, not novel risk —
1. Girder carries **native objective magnification** in tile metadata (`/item/{id}/tiles` →
   `magnification`), already read across the frontend (`ViewerPanel.jsx:112`, `pathChatApi.js:50`;
   `getTilesInfo` documents the shape at `src/api/index.js:233`).
2. large_image already serves a **level-0 bbox at any target magnification** (server-side pyramid
   downsample): `getRegionImageBlob` (`src/api/index.js:241`) sends `units:'base_pixels'` +
   `left/top/regionWidth/regionHeight` + `magnification` + output cap `width`/`height`.
3. A **VLM patch convention** already exists to adopt: `wsiAnalysis.js` reads **512 px @ 10× ≈ 0.5 mm**
   (`PATCH_OUTPUT=512`, `PATCH_MAG=10`, region-px `= 512 · nativeMag/targetMag`).

The design now treats magnification as first-class (design **§3.0**): tools speak objective power,
every request **clamps to native** (a 20×-scanned slide has no real 40×), and Adaptive Magnification is
a genuine higher-mag re-read. **Residual work (not blocking):** implement the magnification-aware reader
in the pathvlm service (the frontend recipe, in Python — a *separate* reader; CellViT's `fetch_region`
stays native for its own mpp resampling), pin the Patho-R1 `(magnification, output-px)` contract, and
report the actual post-clamp magnification for grounding + the trace.

### F2 — should-fix · Inc 2b (`find_regions`) hard-depends on async infra that does not exist
The whole-slide PLIP index build is minutes-long. But the loop is **single-turn with no server-side
session** — `sdk.py` states it "opens a fresh SDK `query` each turn and holds no server-side session,"
so a turn **cannot resume** when a background job finishes. And `tools.py:126` explicitly defers
"Whole-slide / async segmentation … to R12." The design lists async as an *open question*; it is
actually a **hard prerequisite**: Inc 2b cannot ship until an async job + status + re-invocation
surface exists. **Resolution:** name the R12 async task surface an explicit precursor to Inc 2b; keep
Inc 2a (no index) free of it (reinforces 2a-first). Until then `find_regions` on an un-indexed slide
can only return a *pending* outcome and the user must re-ask — state that UX plainly.

### F3 — should-fix · `describe_region` grounding is weaker than CellViT's and needs a contract
CellViT returns numbers the model cannot fake; `describe_region` returns **Patho-R1 free-text
morphology**, which is itself hedged (its own system prompt: "never give a definitive diagnosis") and
can be speculative. Risk: Claude **launders a hedged model observation into a confident slide-level
claim** — exactly the D6 failure the copilot guards against for numbers, reopened for prose.
**Resolution:** define the grounding contract — surface each description as "one model's observation of
region (x,y)," carry provenance into the summary, and extend `_SYSTEM` (`sdk.py`) to forbid upgrading a
Perceptor description to a verdict (parallels the Inc1 "PanNuke fraction ≠ TILs score" clause).

### F4 — should-fix · the `regions` artifact + overlay is net-new, not a "mirror"
`GirderAnnotationStore.put/get` (`girder_annotations.py`) builds and parses **point elements only**;
`NucleiOverlay.jsx` draws **dots only**. A `regions` kind needs: a rectangle DSA element builder
(width/height, per-element `lineColor` for green-candidate / red-selected — Inc1 precedent), matching
`get()` parsing, and a new `RegionOverlay.jsx` renderer. The design calls this "mirroring the point
path" as if cheap. **Resolution:** scope `regions` as real Inc 2c work (store put/get + overlay), not a
reuse; the point path is a *template*, not a base to extend.

### F5 — should-fix · Claude-as-Executor can fan out into many expensive VLM calls per turn
Each `describe_region` is a 7B VLM inference (seconds). A single reasoning turn (find → describe ×N →
zoom → describe) can be 10+ VLM calls = tens of seconds to minutes, **synchronous within one chat
turn**, on a GPU possibly shared with CellViT-SAM-H. `_MAX_TURNS=16` bounds call *count* but not
*cost/latency*. **Resolution:** add a soft per-turn `describe_region` budget + prompt guidance ("look
before you drill"), consider request batching, and decide GPU placement (F7) so Patho-R1 and CellViT
do not contend.

### F6 — should-fix · dropping Qwen3-4B + Quilt-LLaVA means no benchmark-parity claim
The paper's numbers come from the *full* PathAgent (Qwen Executor + Quilt per-patch descriptions + PLIP
+ Patho-R1). Route A replaces the Executor with Claude and drops the generic-description pass, so this
is a PathAgent-**inspired** capability, **not a reproduction** — the paper's accuracy does not
transfer and must not be promised. **Resolution:** message the feature as "interpretable WSI
reasoning," scope it to interactive Q&A over regions, and keep any accuracy claim tied to our own
evaluation, not the paper's.

### F7 — open · index size / tiling granularity + the level-0 bbox contract
Index size swings ~1000× with tile granularity (native-4096 tiles → sub-MB per slide; PLIP-native
~224-px tiles → hundreds of MB). And `find_regions` must return **level-0** bboxes that line up with
the overlay and `pan_zoom_to_region` — the same alignment trap Inc1 hit with per-element style.
**Resolution:** pin tiling to PLIP's training FOV, store embeddings compactly (fp16), and unit-test the
level-0 bbox contract end to end.

---

## Recommendation

**F1 is done** — folded into design §3.0 (magnification first-class, adopting the frontend's proven
region-read pattern). Fold the rest, **F2–F6**, into the design (F2 makes the R12 async surface an
explicit precursor to Inc 2b; F3/F6 tighten the grounding + messaging; F4/F5 right-size the frontend
and cost). Then write the **Inc 2a** (`describe_region`) TDD plan — the one slice with no index and no
async dependency — starting from the pinned Patho-R1 `(magnification, output-px)` contract and the
magnification-aware region reader (§3.0).
