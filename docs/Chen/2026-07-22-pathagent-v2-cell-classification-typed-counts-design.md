# Cell Classification + Typed Counts — Design (Approach A, Increment 1)

> **Status:** design, pending review. Next step after approval: `writing-plans` → task-by-task implementation plan.
> **Date:** 2026-07-22 · **Author:** Chen + Claude · **Branch:** `feature/copilot-agent`

**Goal:** Surface the per-nucleus PanNuke class that CellViT-SAM-H already computes (and today
throws away), so a segmentation returns **typed counts** (per-class breakdown) instead of a bare
total — and paint the nuclei overlay by class in the viewer.

**One-line architecture:** thread `type`/`type_prob` through the existing
`cellvit → segmenter → run_segmentation → artifact store → frontend overlay` chain; every typed
number originates in a deterministic tool result (never the model), and the class is persisted on
the DSA annotation so it survives reload.

---

## 1. Where this sits (Approach A roadmap)

We chose **Approach A: dual-surface, tool-library-driven** — a deterministic tool layer that both a
UI palette and an agent sit on top of; the LLM plans and narrates, deterministic CPath tools
measure, and every number is tool-derived and verifiable. This matches the frontier pattern shared
by TissueLab / NOVA / SPARK, and is where our current stack (loop + ROI grounding + CellViT measuring
+ overlays + approval gate) already lives.

Increment sequence (this doc = **Increment 1**):

1. **Tool #2 = cell classification + typed counts** ← *this design*
2. Grounding-as-mechanism (the retired D6): PostToolUse claim-binding + verification + abstention.
3. Deterministic UI tool palette (the sign-out-grade primary surface).
4. Tool #3 = spatial statistics / morphometry (density, nearest-neighbour, Ripley's K, hotspots).
5. Agent reframe + plan-of-record + eval harness.

**Honest caveat, stated up front.** CellViT does segmentation and classification in a *single*
forward pass, so Increment 1 **enriches one tool**; it does **not** add multi-tool orchestration.
Genuine orchestration is first exercised at Tool #3. Increment 1's payoff is (a) a new, grounded
**capability** — typed counts / immune fraction — and (b) **verification by visualization** (colour
lets a human eyeball the classification), plus (c) it lays the typed-nucleus substrate Tool #3 needs.

---

## 2. Confirmed ground truth (verified against the running container)

CellViT writes `cells.json`; each cell dict has keys `bbox`, `centroid` `[x, y]`, `contour`,
`type` (**int**), `type_prob` (**float**). Today `infer.py` reads only `centroid` and drops the
rest.

PanNuke taxonomy (`cellvit.config.config.TYPE_NUCLEI_DICT_PANNUKE`), id → name — `0` = Background,
never present in `cells`:

| id | name | official colour (RGB) |
|----|------|-----------------------|
| 1 | Neoplastic | `255, 0, 0` (red) |
| 2 | Inflammatory | `34, 221, 77` (green) |
| 3 | Connective | `35, 92, 236` (blue) |
| 4 | Dead | `254, 255, 0` (yellow) |
| 5 | Epithelial | `255, 159, 68` (orange) |

We reuse these names and colours verbatim (source: `COLOR_DICT_CELLS`) so the overlay matches the
model's own convention and we introduce no lossy remapping.

**Vocabulary decision:** surface the **5 native PanNuke classes as-is**. No grouping into
Tumor/Immune/Stroma at the storage or tool layer — grouping, if ever wanted, is a presentation
concern layered on later. Storing the native class id + name is the most flexible substrate.

---

## 3. The change chain (6 boundaries)

Data shape at each boundary. `N` = nucleus count; arrays are **parallel and index-aligned**
(`centroids[i]` has class `classes[i]`).

### 3.1 `services/cellvit/src/cellvit_service/infer.py` — read the class

- `_cellvit_segment_array`: when reading `cells.json`, keep `type` and `type_prob` alongside
  `centroid`. Return a structured region-local result rather than bare `[x, y]`:
  `list[tuple[x, y, type_int, type_prob]]` **or** a small dataclass carrying parallel lists.
  Chosen shape: return `(points: list[[x, y]], classes: list[int], type_probs: list[float])` from a
  single helper so the xy pipeline (`offset_points`, `_clip_to_region`) stays 2-D and clean.
- `_clip_to_region`: must clip **in lockstep** — filtering a point drops its class/prob too, so the
  three arrays stay aligned. (Today it filters a plain `[x, y]` list; extend to filter aligned
  triples.)
- `_pad_to_min` is unchanged (padding is on pixels, pre-inference).
- `_stub_segment_array` (GPU-free grid): assign a **deterministic** class per grid point so the typed
  path is exercised with `CELLVIT_MODEL=stub` (CI). e.g. `type = 1 + (index % 5)`.

### 3.2 `services/cellvit/src/cellvit_service/app.py` — `/segment` response

- Offset only the xy: `centroids = offset_points(points, bbox["x"], bbox["y"], region.scale)`; the
  `classes` / `type_probs` ride alongside untouched (they are region-invariant labels).
- Compute `counts_by_type` **server-side** (so the number the model later narrates is tool-computed
  by construction), keyed by class **name**.
- New response body (existing keys preserved):

```json
{
  "count": 195,
  "centroids": [[39430.0, 29726.0], ...],
  "classes": [1, 2, 1, 3, ...],
  "counts_by_type": {"Neoplastic": 142, "Inflammatory": 31, "Connective": 22},
  "class_names": {"1": "Neoplastic", "2": "Inflammatory", "3": "Connective", "4": "Dead", "5": "Epithelial"},
  "bbox": {"x": ..., "y": ..., "width": ..., "height": ...},
  "mpp": 0.503
}
```

`counts_by_type` omits classes with zero count. `class_names` is the full map (informational /
future-proofing; our own consumers below never hardcode a name — the service already emits
`counts_by_type` by name and the store persists names).

**Class representation boundary (avoid the int-vs-name trap):**
- **Live path** (`/segment` → `segmenter` → `run_segmentation` geometry): class is the **int** id.
- **Persistence** (`girder_annotations.put`): maps int → **name** for `group` and int → colour for
  `fillColor`.
- **Read-back / frontend** (`girder_annotations.get` → store → overlay): class is the **name**
  string. The frontend colour map is keyed by **name**.

The overlay is fed from the read-back path, so its `classes` are names — key `CLASS_COLOR` by name,
never by int.

### 3.3 `services/agent/src/agent/loop/segmenter.py` — client model

- `SegmentResult` gains `classes: list[int]` and `counts_by_type: dict[str, int]` (+ keep
  `count`, `points`, `mpp`). Parse them from the response; default to empty/`{}` when absent
  (older service / stub) so nothing crashes.

### 3.4 `services/agent/src/agent/loop/tools.py` — typed summary + typed geometry

- Summary string enumerates the breakdown, sorted by count desc, e.g.:
  `"segmented 195 nuclei — 142 Neoplastic, 31 Inflammatory, 22 Connective (at 0.503 µm/px)"`.
  Degrade gracefully: no classes → today's `"segmented N nuclei ..."`; single class → just that one.
- `geometry` handed to the store gains the aligned class list:
  `{"kind": "nuclei", "count": N, "points": [[x, y], ...], "classes": [int, ...]}`.
- Both stub paths (`_stub_nuclei_geometry` here, and the cellvit-service stub in 3.1) produce classes
  so the typed summary path is unit-testable without a GPU.

### 3.5 `services/agent/src/agent/loop/girder_annotations.py` — persist the class

- `put`: each point element carries its class as a DSA `group` **and** a matching `fillColor`
  (from the PanNuke colour table), so it renders coloured natively in the Annotations panel and the
  group is queryable:

```json
{"type": "point", "center": [39430.0, 29726.0, 0], "group": "Neoplastic", "fillColor": "rgb(255,0,0)"}
```

  When `classes` is absent (stub/older), fall back to today's plain point (no group) — backward safe.
- `get`: read `group` back into an aligned `classes` list of **class-name strings**; return
  `{"kind": "nuclei", "count": N, "points": [...], "classes": [...]}`. Elements without a group →
  class `null`, so a mixed/legacy annotation still loads.

### 3.6 Frontend overlay — colour by class + legend

- Artifact fetch path (`copilotApi` → store `copilotNuclei`) carries `classes` alongside `points`.
- `src/components/viewer/NucleiOverlay.jsx`: colour each dot from a JS `CLASS_COLOR` map **keyed by
  class name** (mirroring the PanNuke table); points with `null`/unknown class keep today's cyan
  (safe default). Keep the dark stroke for contrast on light tissue.
- A small **legend** (class name + swatch) shown only for classes actually present in the current
  overlay. Placement: reuse the existing overlay-toggle affordance area (exact spot decided in the
  plan; it is a presentational detail, not an architectural one).

---

## 4. Grounding & wording discipline

- **Every typed number is tool-derived.** `counts_by_type` is computed in the CellViT service and
  passed through as data; the model sees it only inside the tool `summary` string (the existing D4
  handle/summary split is unchanged). The model must not compute or invent a count.
- **No overclaiming.** The agent may report class fractions ("~16% inflammatory cells in this
  region") but **must not** label them a validated **TILs score** or a diagnosis — PanNuke
  `Inflammatory` ≠ clinical TILs. This belongs in the agent system prompt as an explicit line, and is
  reinforced by the existing "RESEARCH USE ONLY · NOT A DIAGNOSTIC DEVICE" framing.
- Full claim-binding **as an enforced mechanism** (parse the model's prose, bind each number to a tool
  output, abstain otherwise) is **Increment 2**, not here. Increment 1 keeps the current
  by-construction sourcing (numbers live only in tool strings) and adds the wording rule.

---

## 5. Testability (GPU-free)

The real classification path needs a GPU, so both stub layers must carry classes:

- `cellvit_service` stub (`CELLVIT_MODEL=stub`): deterministic per-point class → the service's
  `/segment` contract test asserts `classes`, `counts_by_type`, `class_names` shape and alignment.
- agent-loop stub (no `cellvit_url`): `_stub_nuclei_geometry` assigns classes → `run_segmentation`
  unit tests assert the typed summary string and that geometry carries an aligned `classes` list.
- Pure helpers get their own unit tests first (TDD): id→name mapping, `counts_by_type` aggregation,
  lockstep clip, typed-summary formatting (zero/one/many classes), colour lookup.
- Frontend: a `NucleiOverlay` / store test that a `classes` array drives per-dot colour and the legend
  reflects only present classes; a `girder_annotations` round-trip test (put→get) that class survives.

Real-GPU verification is a manual browser E2E after the container rebuild (same ritual as the R11
milestones): segment a small ROI, confirm typed counts in the answer and coloured dots on the ROI.

---

## 6. Out of scope / deferred

- Multi-tool orchestration, `region_composition` / spatial-stats tool → **Increment 4**.
- Claim-binding/verification as an enforced mechanism, abstention → **Increment 2**.
- Deterministic UI tool palette (buttons/param panels) → **Increment 3**.
- Whole-slide / async segmentation, `type_prob` thresholding / low-confidence filtering,
  per-class density (needs mpp²), TILs as a validated metric → later increments.
- No change to the approval gate, the SSE event contract, the two-class tool boundary, or the token
  isolation (D3). No new tool is registered — `run_segmentation` is enriched in place.

---

## 7. Risks & open questions

- **`offset_points` arity:** it unpacks exactly `(x, y)`; keeping xy 2-D and carrying classes in a
  parallel array (not `[x, y, type]` tuples) avoids touching it. (Decided: parallel arrays.)
- **DSA `group` styling:** confirm the Annotations panel renders per-element `fillColor`/`group` as
  expected for `point` elements; if group-level style is required, set an annotation-level style map.
  (Verify during implementation; the overlay's own canvas colouring does not depend on this.)
- **Legacy annotations:** pre-Increment-1 "Copilot nuclei" annotations have no group → load as class
  `null` (cyan). Acceptable; optional cleanup of stale ones is a separate chore.
- **Colour accessibility:** PanNuke green/blue/red on H&E is generally legible; revisit only if a
  reader study flags it.

---

## 8. Success criteria

1. A real segmentation of a mixed region returns `counts_by_type` and the agent's answer enumerates
   the breakdown (not just a total), with numbers matching the tool output exactly.
2. The persisted DSA annotation carries per-nucleus class; after reload the overlay renders the same
   colours (class survives the round-trip).
3. The viewer overlay colours nuclei by PanNuke class with a legend of present classes.
4. `CELLVIT_MODEL=stub` and the agent-loop stub exercise the full typed path; all unit tests green;
   `ruff` clean.
5. No regression: an all-one-class or class-less result still produces today's behaviour.
