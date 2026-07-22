# Cell Classification + Typed Counts — Design (Approach A, Increment 1)

> **Status:** design **final** — amended per review (`…-cell-classification-design-review.md`) and
> turned into a task-by-task TDD plan: `…-cell-classification-typed-counts-plan.md` (ready to execute).
> **Date:** 2026-07-22 · **Author:** Chen + Claude · **Branch:** `feature/copilot-agent`
>
> **Amendments folded in (2026-07-22, from the review):** (F1) the class value is a **name-string end
> to end** past the CellViT service — the int id lives only inside the service, both artifact stores
> return names, and the overlay keys colour by name uniformly; (F3) **`type_prob` is dropped from
> Increment 1** (no consumer this increment — re-added when low-confidence filtering lands); (F4) each
> DSA `point` element carries `group` + a per-element `lineColor` matching the repo's own `makePoint`
> convention (an annotation-level style map was considered but **rejected** — the repo's annotation
> renderer keys off per-element `lineColor`, `annotationUtils.js:55,237`); (F2) an explicit alignment
> invariant is asserted at the service boundary.

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
rest. **Increment 1 additionally reads `type` only** — `type_prob` stays dropped (F3; re-introduced
by the increment that filters on confidence).

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

- `_cellvit_segment_array`: when reading `cells.json`, keep `type` alongside `centroid` (**`type_prob`
  is dropped — F3**). Return a structured region-local result rather than bare `[x, y]`:
  `(points: list[[x, y]], classes: list[int])` — **two parallel, index-aligned arrays** — from a
  single helper so the xy pipeline (`offset_points`, `_clip_to_region`) stays 2-D and clean. `classes`
  stays **int** here: the int id is the model's native output and lives only inside this service; it
  becomes a name at the segmenter boundary (§3.3).
- `_clip_to_region`: must clip **in lockstep** — filtering a point drops its class too, so the two
  arrays stay aligned. (Today it filters a plain `[x, y]` list; extend to filter aligned pairs.)
- `_pad_to_min` is unchanged (padding is on pixels, pre-inference).
- `_stub_segment_array` (GPU-free grid): assign a **deterministic** class per grid point so the typed
  path is exercised with `CELLVIT_MODEL=stub` (CI). e.g. `type = 1 + (index % 5)`.

### 3.2 `services/cellvit/src/cellvit_service/app.py` — `/segment` response

- Offset only the xy: `centroids = offset_points(points, bbox["x"], bbox["y"], region.scale)`; the
  `classes` ride alongside untouched (they are region-invariant labels).
- Compute `counts_by_type` **server-side** (so the number the model later narrates is tool-computed
  by construction), keyed by class **name** (map int → name via `TYPE_NUCLEI_DICT_PANNUKE`).
- **Alignment invariant (F2), asserted right before returning:**
  `count == len(centroids) == len(classes) == sum(counts_by_type.values())`. This one check catches
  every way the lockstep clip / offset / aggregation can drift; a failure is a 500, not a silently
  miscoloured overlay.
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

`counts_by_type` omits classes with zero count. The wire `classes` stay **int** (compact) and
`class_names` is the int→name map the segmenter uses to translate them (§3.3).

**Class representation boundary — name-first past the service (F1, resolves the int-vs-name trap):**

The int id exists **only inside the CellViT service**. The `segmenter` translates it to a name the
moment the result crosses back into the gateway, so **every consumer past that point sees a name** and
there is exactly one representation to key on:

| Boundary | class value |
|---|---|
| `cells.json` → `infer` → `/segment` **wire** | **int** (`+ class_names` map alongside) |
| `segmenter.SegmentResult` onward (tools, geometry, **both** stores' `get`, overlay) | **name string** |

- **Why this and not "int through geometry":** the overlay is *always* fed by `artifacts.get`, and the
  in-memory store returns its stored geometry verbatim. If geometry held ints, the stub store would
  return ints while the DSA store returned names — the exact split the review (F1) caught. Making the
  geometry hold **names** makes both stores return the same thing.
- **Persistence** (`girder_annotations.put`): `group = name` **directly** (no mapping); colour comes
  from an annotation-level group→style map (§3.5), not per-element `fillColor`.
- **Read-back / frontend** (`girder_annotations.get` / in-memory `get` → store → overlay): class is the
  **name** string; the frontend colour map is keyed by **name**, never by int.

### 3.3 `services/agent/src/agent/loop/segmenter.py` — client model

- `SegmentResult` gains `classes: list[str]` (**names**) and `counts_by_type: dict[str, int]` (+ keep
  `count`, `points`, `mpp`). This is the **single int→name translation point**: parse the wire
  `classes` (ints) and map each through the response's `class_names` to a name; keep `counts_by_type`
  as-is (already by name). Default to empty `[]`/`{}` when absent (older service / stub) so nothing
  crashes, and a class whose id is missing from `class_names` maps to `None` (→ cyan downstream).
- Preserve alignment: `len(SegmentResult.classes) == len(SegmentResult.points)` (map, never filter).

### 3.4 `services/agent/src/agent/loop/tools.py` — typed summary + typed geometry

- Summary string enumerates the breakdown from `counts_by_type`, sorted by count desc, e.g.:
  `"segmented 195 nuclei — 142 Neoplastic, 31 Inflammatory, 22 Connective (at 0.503 µm/px)"`.
  Degrade gracefully: no classes → today's `"segmented N nuclei ..."`; single class → just that one.
- `geometry` handed to the store gains the aligned class list, **as names** (F1):
  `{"kind": "nuclei", "count": N, "points": [[x, y], ...], "classes": ["Neoplastic", ...]}` — taken
  straight from `SegmentResult.classes` (already names), so no int lives in the geometry.
- Both stub paths produce classes so the typed path is unit-testable without a GPU, and both must
  produce **names** to match the real path: the cellvit-service stub (§3.1) emits int ids that the
  segmenter names; the agent-loop stub (`_stub_nuclei_geometry`, used when no `cellvit_url`) never
  touches the service, so it assigns **names directly** — cycle the five PanNuke names
  (`["Neoplastic", "Inflammatory", "Connective", "Dead", "Epithelial"][i % 5]`) and build its own
  `counts_by_type` for the summary.

### 3.5 `services/agent/src/agent/loop/girder_annotations.py` — persist the class

- `put`: `geometry["classes"]` are already **names** (F1), so each point element just tags its
  `group` with the name — no int→name mapping here. Colour is a **per-element `lineColor`** (F4),
  following the repo's own `makePoint` convention (`src/components/annotations/annotationUtils.js:55`,
  whose renderer reads `el.lineColor` at `:237`). An annotation-level style map was considered but
  **rejected**: the repo's annotation renderer keys off per-element colour, and the interactive ROI cap
  (`_MAX_SEG_AREA`) already bounds the element count, so per-element colour is both pattern-consistent
  and guaranteed to render natively. Element shape (PanNuke hex from the vendored colour table):

```json
{"type": "point", "center": [39430.0, 29726.0, 0], "group": "Neoplastic", "lineColor": "#ff0000"}
```
  When `classes` is absent (stub/older) or an entry is `null`, fall back to today's plain point (no
  `group`, default colour) — backward safe.
- `get`: read each element's `group` back into a `classes` list of **name strings**, built **in
  lockstep with the same `point`-element filter that produces `points`** (skip a non-point element and
  its class together). Return `{"kind": "nuclei", "count": N, "points": [...], "classes": [...]}`.
  Elements without a `group` → class `null`, so a mixed/legacy annotation still loads (and
  `len(classes) == len(points)` always holds).

### 3.6 Frontend overlay — colour by class + legend

- Artifact fetch path (`copilotApi` → store `copilotNuclei`) carries `classes` alongside `points`.
- `src/components/viewer/NucleiOverlay.jsx`: colour each dot from a JS `CLASS_COLOR` map **keyed by
  class name** (mirroring the PanNuke table); read the class as `classes?.[i] ?? null` (F6) so a
  missing/short/absent `classes` array never throws, and `null`/unknown class keeps today's cyan
  (safe default). Keep the dark stroke for contrast on light tissue.
- A small **legend** (class name + swatch) shown only for classes actually present in the current
  overlay. Placement: reuse the existing overlay-toggle affordance area (exact spot decided in the
  plan; it is a presentational detail, not an architectural one).

---

## 4. Grounding & wording discipline

- **Every typed number is tool-derived.** `counts_by_type` is computed in the CellViT service and
  passed through as data; the model sees it only inside the tool `summary` string (the existing D4
  handle/summary split is unchanged). The model must not compute or invent a count.
- **No overclaiming (F8, precise system-prompt line).** Absolute counts must be **quoted verbatim from
  the tool summary** (the model never computes a count); the model **may** narrate a **fraction of
  those tool-provided counts** ("~16% of the cells here are Inflammatory") — dividing two tool numbers
  is allowed narration, inventing one is not. It **must not** label such a fraction a validated **TILs
  score** or a diagnosis — PanNuke `Inflammatory` ≠ clinical TILs. This is an explicit line in the
  agent system prompt, reinforced by the existing "RESEARCH USE ONLY · NOT A DIAGNOSTIC DEVICE" framing.
- Full claim-binding **as an enforced mechanism** (parse the model's prose, bind each number to a tool
  output, abstain otherwise) is **Increment 2**, not here. Increment 1 keeps the current
  by-construction sourcing (numbers live only in tool strings) and adds the wording rule.

---

## 5. Testability (GPU-free)

The real classification path needs a GPU, so both stub layers must carry classes:

- `cellvit_service` stub (`CELLVIT_MODEL=stub`): deterministic per-point class → the service's
  `/segment` contract test asserts `classes`, `counts_by_type`, `class_names` shape and the **F2
  invariant** `count == len(centroids) == len(classes) == sum(counts_by_type.values())`.
- agent-loop stub (no `cellvit_url`): `_stub_nuclei_geometry` assigns **names** → `run_segmentation`
  unit tests assert the typed summary string and that geometry carries an aligned **name** `classes`
  list.
- Pure helpers get their own unit tests first (TDD): int→name mapping, `counts_by_type` aggregation,
  lockstep clip, typed-summary formatting, colour lookup. Because the integration stub always emits
  all five classes (`1 + i%5`), the **zero-/one-class summary branches are covered only by these pure
  formatter tests (F7)** — they can't be reached through the stub, so they must be explicit unit cases.
- **Test-migration budget (F5):** changing `segment_array`'s return shape breaks three existing
  cellvit-service tests that must be updated in the same task — `tests/test_infer.py` (stub-grid shape
  + the `_clip_to_region` case), and `tests/test_segment_route.py` (the injected `fake_segment` return
  + `body` assertions, which now also cover `counts_by_type`). Keep the injectable
  `SEGMENT`/`READ_REGION` seams.
- Frontend: a `NucleiOverlay` / store test that a **name** `classes` array drives per-dot colour and
  the legend reflects only present classes, plus a guard case (absent/short `classes` → all cyan, no
  throw — F6); a `girder_annotations` round-trip test (put→get) that the class **name** survives.

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
- **DSA `group` + `lineColor` (F4):** each `point` element carries `group` (name) and a per-element
  `lineColor` (PanNuke hex), matching the repo's `makePoint`/renderer convention
  (`annotationUtils.js:55,237`) — so native panel rendering follows the exact path existing annotations
  already use, no unverified schema. The copilot overlay's own canvas colouring is independent (it
  colours from `classes`).
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
