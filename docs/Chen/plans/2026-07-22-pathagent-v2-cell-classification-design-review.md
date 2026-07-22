# Cell Classification + Typed Counts — Design Review (adversarial)

> **Reviews:** `2026-07-22-pathagent-v2-cell-classification-typed-counts-design.md` (Increment 1).
> **Status:** review complete — **1 blocking finding, 4 should-fix, 3 nice-to-have.** Recommend a
> small design amendment (F1–F3) before `writing-plans`; the rest are plan-level.
> **Date:** 2026-07-22 · **Reviewer:** Claude (code-grounded) · **Branch:** `feature/copilot-agent`
> **Method:** verified the design's "confirmed ground truth" against the running code + the installed
> `cellvit` package, then traced the class value through all 6 boundaries looking for a break.

---

## 0. Ground truth — verified ✅

Every factual claim the design rests on checks out against the code, so the review is about the
*design*, not its premises:

| Claim (design) | Verified against | Result |
|---|---|---|
| `TYPE_NUCLEI_DICT_PANNUKE = {1:Neoplastic … 5:Epithelial}` | `cellvit/config/config.py` (installed) | ✅ exact |
| PanNuke colours (red/green/blue/yellow/orange) | `COLOR_DICT_CELLS[1..5]` | ✅ exact (`1:[255,0,0] 2:[34,221,77] 3:[35,92,236] 4:[254,255,0] 5:[255,159,68]`) |
| `infer.py` reads only `centroid`, drops the rest | `infer.py:163` | ✅ `[[float(c["centroid"][0]), float(c["centroid"][1])] for c in cells]` |
| `offset_points` unpacks exactly `(x, y)` | `geometry.py:13` | ✅ `for x, y in points` — a `[x,y,type]` triple *would* break it; parallel arrays are the correct call |
| `_clip_to_region` filters a plain `[x,y]` list | `infer.py:71-73` | ✅ must become lockstep |
| `SegmentResult` = count/points/mpp | `segmenter.py:14-22` | ✅ |
| `run_server_tool` geometry = `{kind,count,points}` + summary | `tools.py:155,152` | ✅ |
| `GirderAnnotationStore` put/get plain point elements, no group | `girder_annotations.py:30-72` | ✅ |
| Overlay paints every dot cyan; `copilotNuclei={points,count}` | `NucleiOverlay.jsx:30`, `store/index.js:229` | ✅ |
| Overlay is fed by `fetchTurnArtifact` → `artifacts.get` | `CopilotPanel.jsx:251-253`, `copilotApi.js:107` | ✅ (**both live and post-reload go through `get`** — see F1) |

**Architecture verdict:** the core choices are right — parallel index-aligned arrays (not `[x,y,type]`
tuples), server-computed `counts_by_type` (numbers tool-derived by construction), class persisted on the
DSA annotation, native PanNuke vocabulary with no lossy remap. Proceed, after resolving F1.

---

## 1. Findings (ranked)

### 🔴 F1 — BLOCKING: class representation is **not uniform** at the `get` boundary

The design (§3.2, "Class representation boundary") says read-back class is a **name string** and "key
`CLASS_COLOR` by name, never by int." But the two artifact stores disagree at exactly that boundary:

- **Real path** — `GirderAnnotationStore.get` reads the DSA `group` back → **name-string** classes. ✅
- **Stub path** — `InMemoryArtifactStore.get` returns the stored geometry **verbatim**
  (`artifacts.py`), and §3.4 defines that geometry's `classes` as **`[int, ...]`**. So the stub returns
  **int** classes. ❌

The overlay is *always* fed from `get` (`CopilotPanel.jsx:251` → `fetchTurnArtifact` → `get_turn_artifact`
→ `artifacts.get`) — there is no separate "live" path that bypasses the store. So a name-keyed
`CLASS_COLOR` map colours correctly in real/GPU mode and **silently falls through to cyan for every dot in
stub mode** — which is the mode all CI, the frontend unit test (§5), and every GPU-free demo run in. This
is precisely the "int-vs-name trap" §3.2 set out to avoid; it slipped through at the stub store.

**Recommended amendment — pick ONE representation for `geometry["classes"]` and the `get` return, and make
both stores honour it. Recommend name-strings, end to end:**

- `tools.py` maps `int → name` once (using the service's `class_names` map, which §3.2 already returns) and
  stores `classes` as **names** in the geometry dict. The typed *summary* is already built by name, so this
  is the same lookup.
- `InMemoryArtifactStore` then stores & returns names automatically (verbatim passthrough). ✅
- `GirderAnnotationStore.put`: `group = name` directly (no map needed); `fillColor` from a **name→colour**
  table. `get`: `group` → name. ✅
- Frontend keys `CLASS_COLOR` by name, uniformly, in both modes. ✅

Net effect: the int id lives only *inside* the CellViT service and `segmenter` (where the model computes
it); the moment it becomes an artifact it is a name, and stays a name across store, reload, and overlay.
This removes the trap instead of relocating it. (If you'd rather keep ints in geometry, the alternative is
to make `InMemoryArtifactStore.get` map int→name too — but that pulls the PanNuke taxonomy into
`artifacts.py`, which should stay domain-free; the name-first option is cleaner.)

### 🟠 F2 — SHOULD-FIX: no stated cross-array length invariant

The whole design is an alignment contract (`centroids[i]` ↔ `classes[i]` ↔ `counts_by_type`). The one
assertion that catches every way that contract can break is never written down:

```
count == len(centroids) == len(classes) == sum(counts_by_type.values())
```

`_clip_to_region` (lockstep), `offset_points` (1:1), the `segmenter` re-parse, and the `get` round-trip
each preserve it *if written correctly* — but a single off-by-one drops it silently, and the symptom
(miscoloured or mis-tallied nuclei) is hard to spot by eye. **Recommend:** assert this invariant in the
`/segment` route right before returning, and add it as an explicit test at each boundary (§5 lists a
"lockstep clip" and "counts_by_type aggregation" test — make the length-equality the assertion in both).
Cheapest possible guard against the design's own stated top risk.

### 🟠 F3 — SHOULD-FIX: `type_prob` is threaded halfway, then dropped

§3.1 says keep `type` **and** `type_prob`; §3.3 adds neither to `SegmentResult`'s persisted shape for prob;
the §3.2 response JSON has **no `type_probs`**; and §6 explicitly defers all `type_prob` use (thresholding,
low-confidence filtering) to a later increment. So Inc1 carries `type_prob` out of `cells.json` and through
`_clip_to_region` (a third aligned array to keep in lockstep) only to discard it at the HTTP boundary —
pure carrying cost, extra alignment surface, zero consumer. **Recommend:** drop `type_prob` from Increment
1 entirely (YAGNI; re-add it in the increment that filters on it), *or* expose it in the response for
future-proofing but don't thread it into the persisted/overlay path. Don't carry it halfway.

### 🟠 F4 — SHOULD-FIX: prefer annotation-level group→style over per-element `fillColor`

§3.5 writes `fillColor` onto **every** point element. For a 4096² ROI that is thousands–tens-of-thousands
of elements, each growing from `{"type":"point","center":[x,y,0]}` to include a repeated
`"fillColor":"rgb(34,221,77)"` — roughly doubling the POST body and duplicating one of 5 colours across
every element. DSA/`large_image` supports an **annotation-level group→style map** (define the 5 group
styles once, tag each element with only `group`). §7 flags this as "verify … if group-level style is
required" — **recommend making the annotation-level style map the default** (lean payload, single source of
colour truth) and dropping per-element `fillColor`. Two things to verify during implementation, both
already half-noted in §7: (a) that DSA renders `group` on `point` elements, and (b) the exact style-map
shape. The overlay's own canvas colouring does not depend on either (it colours from `classes`).

### 🟠 F5 — SHOULD-FIX: `segment_array`'s return-type change has a concrete test blast radius

Changing `segment_array` from `list[[x,y]]` to the 3-/2-array shape is a contract change that breaks the
CellViT-service tests the plan must budget for:

- `tests/test_infer.py:25` — asserts the stub grid's `[[x,y],…]` shape.
- `tests/test_infer.py:73-75` — `_clip_to_region([[x,y],…])`; its signature becomes lockstep.
- `tests/test_segment_route.py:29-47` — the injected `fake_segment` returns `[[0,0],[10,20]]` and asserts
  `body["centroids"]`; the fake must return the new shape and the route now also emits `counts_by_type`.

Not a design flaw — just the honest cost. **Recommend** the plan touch these three in the same task that
changes the return shape, and keep the injectable `SEGMENT`/`READ_REGION` seams (they're how the route is
tested GPU-free).

### 🟡 F6 — NICE-TO-HAVE: frontend must guard index alignment

`NucleiOverlay` will read `copilotNuclei.classes[i]`. A legacy/mixed annotation yields a `classes` array
that is shorter than `points` (or absent). Read it as `classes?.[i] ?? null` → cyan fallback; never index
past the end. One line, but it's the difference between "legacy overlay renders cyan" and "overlay throws."

### 🟡 F7 — NICE-TO-HAVE: the default stub never exercises the zero/one-class summary branches

`type = 1 + (index % 5)` over 1234 points always yields all 5 classes, so the "single class → just that
one" and "no classes → today's string" degradations (§3.4) are never hit through the stub. That's fine
**because** §5 unit-tests the summary formatter as a pure function (zero/one/many) — just confirm those
pure-fn cases are in the plan, since the integration stub can't reach them.

### 🟡 F8 — NICE-TO-HAVE: tighten the wording rule (§4)

The new summary ("segmented 195 nuclei — 142 Neoplastic, 31 Inflammatory, …") invites the model to divide
(31/195 ≈ 16%). §4 permits fractions but forbids the "TILs"/diagnosis label — good, but the system-prompt
line should be precise so it doesn't collide with "the model must not compute a count": **fractions of
tool-provided counts are OK to narrate; absolute counts must be quoted verbatim from the tool; never label
a PanNuke-Inflammatory fraction as a TILs score or a diagnosis.**

---

## 2. What the design got right (keep as-is)

- Parallel arrays over `[x,y,type]` tuples — directly avoids the `offset_points` arity break (verified).
- `counts_by_type` computed **server-side** → the narrated number is tool-derived by construction; the
  model only ever sees it inside the summary string (D4 handle/summary split unchanged).
- Native PanNuke 5-class vocabulary, colours verbatim from `COLOR_DICT_CELLS`, no Tumor/Immune/Stroma
  grouping at the storage/tool layer (grouping is a later presentation concern) — most flexible substrate.
- Backward-compat posture (absent `classes` → plain point / cyan; legacy annotations load as class `null`).
- Honest scoping: Inc1 *enriches one tool*, real orchestration waits for Tool #3 — stated up front, §1.
- Two GPU-free stub layers (service + loop) both carry classes so the typed path is unit-testable.

---

## 3. Recommended path

1. **Amend the design** for F1 (name-string classes end-to-end — the one blocking item), F3 (decide
   `type_prob`: I recommend *drop from Inc1*), and F4 (annotation-level style map). These change the
   contract the plan will encode, so they're cheaper to fix now than mid-plan.
2. Fold F2 (length invariant), F5 (test blast radius), F6–F8 into the plan as tasks/acceptance criteria —
   they don't need a design edit, just to be *in* the plan.
3. Then `superpowers:writing-plans` → the task-by-task TDD plan (same format as the DSA-persistence plan),
   with the amended name-first contract as its backbone.

**One-line verdict:** the design is sound and its premises are verified; fix the single class-representation
inconsistency (F1) so the stub and real stores return the same thing, decide `type_prob` and the annotation
style-map, and it's ready to plan.
