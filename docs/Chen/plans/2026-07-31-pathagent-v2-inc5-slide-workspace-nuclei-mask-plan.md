# PathAgent v2 · Inc 5 — Slide Workspace + Nuclei as Mask · Plan

> **Date:** 2026-07-31
> **Author:** Chen (with Claude)
> **Status:** Plan — awaiting sign-off. No code written.
> **Reuses:** Inc 2b (`preprocess_artifact` DAG), Inc 3b (marker map), Inc 4 (tissue map) —
> tiling, pyramid, coverage, cooperative stop, authenticated tile proxy, OSD layer stack.
> **Ask (verbatim):** 我需要这些 artifact 存下来，比如任何一张 slide 我都希望他有一个
> workspace，然后存下来所有的 artifact，每个 artifact 都给出 brief 信息，这样你需要哪个
> overlay 你就点击哪个，你不需要你可以直接删除。我不需要你自己实现，我需要的是你在
> open-source 的 project 中找到类似的实现，并且复制粘贴他们的代码。
> **Amendment (verbatim):** 还要加上 nuclei，不要把 nuclei 放到 annotation，目前的
> implement 需要改掉，nuclei 不是需要 centroid 而是 mask。

---

## 0. What this is

Two things the ask binds together:

1. **A per-slide workspace** — one place that lists every artifact a slide has, says what each one
   is in a line, switches its overlay on and off, and deletes it. The UI is copied from OHIF.
2. **Nuclei become a first-class artifact carrying masks** — CellViT already computes a polygon per
   nucleus and the storage layer throws it away. Nuclei move out of Girder annotations into the
   same content-addressed artifact machinery as tissue and markers, with the polygon kept.

These are one increment because the workspace is not worth building over a registry that is missing
its most-used entry, and nuclei-as-artifact has no user-visible surface without the workspace.

---

## 1. Decision ledger (grilled with Chen, 2026-07-31)

| # | Decision | Choice | Why |
|---|---|---|---|
| **D1** | What "workspace" is | **A UI view over the existing `preprocess_artifact` table** | The table already *is* a per-slide registry: `girder_item` + `kind` + `art_hash` + `params` + `status` + `result` + `created_at`, 30 rows across 6 kinds today. A named-workspace concept would invent an ownership question the data does not have — an artifact belongs to a slide, not to a folder. |
| **D2** | List scope | **All 6 kinds + nuclei** | Kinds that cannot be drawn (`features`, `prediction`) still answer "what has this slide cost me"; they get a summary line and a delete, no eye. |
| **D3** | Nuclei mask representation | **Vector polygons are the truth; server-rendered raster tiles are the picture** | Only this keeps the number in a report and the picture on screen coming from one stored object. Pure raster loses per-nucleus identity; pure vector means shipping ~10⁶ polygons to a browser. |
| **D4** | Copy-paste scope | **Research both halves first** (done, §2) | Result: the UI has a direct open-source analogue; the storage does not. |
| **D5** | Nuclei render stack | **Keep OSD + server-side PNG tiles**, format aligned to OME-NGFF `labels` instance-id semantics | Viv/Vitessce render bitmasks client-side via deck.gl + Zarr — a second renderer beside OpenSeadragon and a second coordinate system to keep aligned. The repo's own `contours → rasterise → pyramid` path already runs twice. |
| **D6** | Workspace panel source | **Copy OHIF `SegmentationTable` wholesale, TypeScript included** | Chen's call, against the alternative of re-writing it in the repo's JS+Tailwind. Consequence: TS, Radix, `Icons`, `react-i18next` enter a repo that has none of them (§7 R1). |
| **D7** | Who owns visibility | **The workspace is the only switch.** Visibility unifies into `visibleArtifacts: {[art_hash]: bool}` in zustand | Today there are *three* mechanisms: `TissuePanel` local `useState`, `showTissueOverlay` boolean, `visibleAnnotations` map. "Click the one you want" is not implementable over three. The `visibleAnnotations` map is the shape that generalises. |
| **D8** | Delete semantics | **Row + on-disk artifact. Refuse if anything's `parent_hash` points at it**, and name the dependants | The DAG is real and deep. Cascade would let one click erase hours of GPU time; DB-only delete is a trap, because content addressing means a re-run hits the surviving directory and the artifact returns with stale content. |
| **D9** | Who owns nuclei | **The `cellvit` service grows artifact machinery; `nuclei` becomes a kind.** `biomarker` consumes it via `parent_hash` instead of re-running CellViT | Correct dependency direction — biomarker is built *on* nuclei. Side effect: a whole-slide biomarker stops paying for a second CellViT pass. Extraction of the now-threefold machinery is deferred (§9). |
| **D10** | The never-commit conflict | **Finish the dashboard WIP first**, as Phase 0 | The panel needs 5 files that are all dirty with unrelated in-progress work. Without this the increment cannot be delivered as a committable unit — and `src/styles/index.css` has already been local-only for several increments. |
| **D11** | Placement | **New tab, first in the bar, default landing for `ai-users`** | The three existing panels keep their parameter controls (D7), so they stay. Ten tabs becomes eleven; the workspace answers "what does this slide have" before you pick a panel to tune. |

**Determined by fact, not chosen:**

- **Old nuclei cannot be migrated.** Girder holds `{"type":"point","center":[x,y,0]}`. The contour was
  never stored, so there is no source to migrate from — only a re-run produces masks. Existing point
  annotations stay where they are as ordinary annotations.
- **`GirderAnnotationStore` survives.** It is the agent loop's generic bulk-geometry sink
  (`loop/tools.py`), not nuclei-specific. Only the nuclei path detaches from it.

---

## 2. Open-source survey (D4 result)

### The workspace UI — a direct analogue exists

| Candidate | Licence | Stack | Verdict |
|---|---|---|---|
| **OHIF `platform/ui-next/.../SegmentationTable`** | MIT | React + Tailwind + **TS** | **Chosen.** 9 files / 1013 lines. Collapsed row = eye + brief info; expanded = per-item controls. Exactly the interaction asked for. |
| Vitessce layer controller | MIT | React + **MUI** | MUI against this repo's Tailwind. |
| napari layer list | BSD-3 | Python/Qt | Pattern only. |
| QuPath | **GPL-3** | Java | Licence-incompatible; excluded. |

**Its dependency tail**, measured: `Button`, `DropdownMenu`, `Icons` (608 KB), `Input`, `Label`,
`PanelSection`, `Slider`, `Switch`, `Tabs` — 9 Radix/shadcn primitives, plus `react-i18next`. This
repo has **0** `.ts`/`.tsx` files, no TypeScript, no i18next, no Radix. It does already have
`lucide-react` and Tailwind 3.4.6.

### The nuclei mask — no analogue at this stack

| Candidate | Licence | How | Distance |
|---|---|---|---|
| [Viv](https://github.com/hms-dbmi/viv) / [Vitessce](http://vitessce.io/docs/data-troubleshooting/) | MIT | OME-Zarr `labels` + deck.gl WebGL shader, instance id → colour client-side | Needs deck.gl + Zarr beside OpenSeadragon |
| [TissUUmaps](https://github.com/TissUUmaps/TissUUmapsCore) | MIT | **OpenSeadragon** + WebGL markers, D3 regions, millions of points | Stack matches; but plain JS, not React, and it draws markers not masks |
| [large_image / DSA](https://github.com/girder/large_image) | Apache-2.0 | Vector annotation elements + HistomicsUI rendering | This project's own foundation — and the path being replaced |
| OME-NGFF `labels` | spec | The de-facto instance-mask format; napari/QuPath/Vitessce read it | A **format**, not code |

**No open-source project combines OpenSeadragon + server-rendered mask tiles + a React panel.** What
is copyable here is the *format*, and the repo's own twice-proven pipeline is the closest thing to
prior art. This is the one place "copy their code" does not apply, and D5 accepts that.

---

## 3. What exists today (measured, 2026-07-31)

```
preprocess_artifact         30 rows / 6 kinds
  segmentation → patching → features → prediction
  segmentation → tissue
  segmentation → biomarker
DELETE endpoints            none for artifacts (only /conversations/{id})

on-disk        tissue whole-slide   290 MB      biomarker whole-slide  235 MB (222,412 cells)
               tissue region      1.5–2.6 MB    biomarker region        1.3 MB (327 cells)

services       cellvit    465 lines, 6 modules, STATELESS — no artifacts/jobs/pyramid/wholeslide
               tissue    2241 lines, 11 modules   ┐ the same machinery,
               biomarker 2600+ lines, 22 modules  ┘ written twice

cellvit contours   computed in infer.py:213, used by the phenotype rasteriser, PERSISTED NOWHERE
biomarker call     cellvit_client.fetch_centroids()  ← the name is the bug
```

---

## 4. The `nuclei` artifact

### 4.1 Storage layout

Mirrors `tissue`/`biomarker` exactly, so the third copy stays recognisable as a copy:

```
/cache/{item}/nuclei/{art_hash}/
  meta.json          slide dims, mpp, store_mpp, level_offset, levels, backend, classes, palette
  coverage.json      {core, done: [[tx,ty]…], totals}     ← tallies ride the same atomic write
  summary.json       n_nuclei, counts_by_class, area_mm2, n_tiles
  cells/{tx}_{ty}.npz    per-core-tile vector truth
  classes/{z}/{x}_{y}.png    paletted class raster  (PanNuke class per pixel, 0 = background)
  instances/{z}/{x}_{y}.png  instance-id raster, RGBA-packed uint32  ← OME-NGFF labels semantics
```

`cells/*.npz` fields, extending the biomarker sidecar rather than inventing a shape:

| field | dtype | note |
|---|---|---|
| `xy` | float32 `[N,2]` | centroid, level-0 slide px — what exists today |
| `cls` | uint8 `[N]` | PanNuke class index |
| `ring_off` | int32 `[N+1]` | CSR offsets into `ring_xy` |
| `ring_xy` | int16 `[P,2]` | polygon points, **relative to the core-tile origin** — the whole reason int16 fits |
| `inst` | uint32 `[N]` | instance id, unique within the artifact; the value written into `instances/` |

**Sizing, from real counts:** CellViT rings run ~20–40 points; at 4 B/point that is ~120 B/nucleus.
The 222,412-cell slide measured above → ~27 MB of vector. A dense WSI at 1–3 M nuclei → 120–360 MB,
the same order as the 290 MB tissue map already accepted.

### 4.2 Why two rasters

`classes/` answers "what is here" at any zoom and is what the overlay shows by default.
`instances/` is what makes hover-a-nucleus and per-cell selection possible later without shipping
vectors. Packing uint32 into RGBA is the OME-NGFF labels convention, so a future export is a
re-container rather than a re-compute. Both are cheap: they rasterise from the same rings in one
pass, in the code path that already exists for the phenotype layer.

### 4.3 Store resolution

Nuclei are ~10 µm. The tissue map's 1 µm/px would make them mush, so nuclei store at
**0.25 µm/px (`level_offset` 0)** — 16× the pixels per unit area of the tissue map, which is why the
raster is paletted (`classes/`, 1 B/px) rather than probability planes.

### 4.4 Service changes

- **`cellvit`** gains `artifacts.py`, `jobs.py`, `pyramid.py`, `tiling.py`, `tiles.py`, `slides.py`,
  `wholeslide.py`, `routes.py` — copied from `tissue` (~1650 lines) and adapted. Keeps `infer.py`,
  `geometry.py`, `pannuke.py`, `region.py`. Gains cooperative stop for free (it is in `jobs.py`).
- **`biomarker`** replaces `cellvit_client.fetch_centroids()` with a read of a ready `nuclei`
  artifact addressed by `parent_hash`, and 409s if none exists — the same precondition shape
  `patch`/`features` already use.
- **Gateway** gains the `nuclei` control plane + tile proxy, copied from the `tissue` routes.

---

## 5. The workspace panel

### 5.1 Copy provenance

Files are taken from `/home/chen/github/Viewers` @ MIT, each carrying a header naming its origin
file, the OHIF commit, and the MIT notice. `platform/ui-next/src/components/` →
`src/components/workspace/vendor/ohif/`:

```
SegmentationTable.tsx  SegmentationCollapsed.tsx  SegmentationExpanded.tsx
SegmentationHeader.tsx  SegmentationSegments.tsx  SegmentationTableConfig.tsx
SegmentStatistics.tsx  AddSegmentationRow.tsx  AddSegmentRow.tsx  contexts/
+ PanelSection, Button, DropdownMenu, Input, Label, Slider, Switch, Tabs, Icons
```

**What is genuinely copied:** layout, class names, collapsed/expanded structure, keyboard and hover
behaviour, the config popover, the icon set.
**What must be rewritten regardless:** every data binding. OHIF's components are written against its
`SegmentationService` domain object — the context shape, prop names, and the add/remove/toggle calls
are all OHIF's. Wiring them to `preprocess_artifact` rows is new code. This is stated as a limit of
the ask, not a deviation from it.

### 5.2 Row content (D2)

Four segments per row: **kind · params · scale · state+age**.

| kind | params | scale |
|---|---|---|
| `segmentation` | segmenter, mpp | n tissue regions |
| `patching` | patch_size, mag, overlap | n patches |
| `features` | encoder | n vectors × dim |
| `prediction` | model | label + probability |
| `tissue` | backend | n tiles · mm² · TSR |
| `biomarker` | panel | n cells · phenotype mix |
| `nuclei` | backend | n nuclei · mm² · class mix |

Only `tissue`, `biomarker`, `nuclei` and `segmentation` carry an eye. Sources: `params` and `result`
JSONB, already populated — no new server fields.

### 5.3 Visibility (D7)

```js
// store: replaces TissuePanel's local `on`, PreprocessPanel's showTissueOverlay boolean
visibleArtifacts: {},                       // { [art_hash]: bool }
setArtifactVisible: (hash, on) => …,        // shape copied from setAnnotationVisible
```

Each panel keeps its render parameters and reads visibility from the store. `showTissueOverlay`
becomes a derived read during migration and is deleted at the end of Phase 5.

---

## 6. Phases

### Phase 0 — unblock delivery (prerequisite, D10)

Resolve the dashboard WIP in `package.json`, `package-lock.json`, `vite.config.js`,
`src/styles/index.css` (+492/−542), `RightPanel.jsx`, `LeftSidebar.jsx`. Either land it or park it
on a branch. **Nothing below is committable until this is done.** Chen's call which way.

### Phase 1 — artifact delete (backend)

`DELETE /slides/{item}/artifacts/{art_hash}` → 409 + `{dependants: [...]}` when anything's
`parent_hash` matches; otherwise delete the row, then the on-disk directory in the owning service
(`tissue`/`biomarker`/`nuclei`/`preprocess`), then return 204. Service-side `DELETE
/{kind}/{item}/{hash}` in each. Disk removal after the row so a crash leaves an orphan directory
(recoverable) rather than a row pointing at nothing (not).

### Phase 2 — `nuclei` artifact (backend)

Copy the tissue machinery into `cellvit`; persist rings (§4.1); rasterise `classes/` and
`instances/`; build the pyramid; write summary and coverage with totals inside `coverage.json`.
Whole-slide + region + resume + cooperative stop, all inherited.

### Phase 3 — biomarker consumes nuclei

Replace `fetch_centroids` with a nuclei-artifact read; set `parent_hash`; 409 without one. Existing
biomarker artifacts keep working — their rows are untouched, only new builds take the new path.

### Phase 4 — vendor OHIF (frontend)

TypeScript + Radix + i18next into `package.json`; `vite.config.js` and vitest to accept `.tsx`;
shadcn CSS variables into `index.css`; the file set of §5.1 with provenance headers. Ends with the
components rendering against a **fixture**, not live data — so the vendoring is verifiable on its
own.

### Phase 5 — wire to artifacts + unify visibility

`visibleArtifacts` in the store; the workspace bound to `listArtifacts`; row summaries per §5.2;
delete wired to Phase 1; `TissuePanel`/`MarkersPanel`/`PreprocessPanel` lose their own switches and
keep their parameters.

### Phase 6 — placement

New tab, first position, default for `ai-users`; `nuclei` joins `LAYER_ORDER`.

---

## 7. Risks

| | Risk | Mitigation |
|---|---|---|
| **R1** | **TS/Radix/i18next entering a pure-JS repo.** Build, test and lint configs all move; a mixed repo is permanent. | Phase 4 is standalone and ends on a fixture — if the toolchain fights back, it is revertable without touching backend work. |
| **R2** | **The third copy of the artifact machinery.** ~1650 lines duplicated a second time; a bug fixed in `tissue` will not reach `cellvit`. | Accepted by D9, deferred by §9. The three call sites are what makes a later extraction safe. |
| **R3** | **Nuclei raster at 0.25 µm/px is 16× the tissue map's density.** | Paletted 1 B/px, not probability planes. Measure on a real WSI at the end of Phase 2 before committing to whole-slide runs. |
| **R4** | **Delete is irreversible and now reachable in one click.** | 409-on-dependants (D8); confirm dialog naming the artifact and its size; never cascades. |
| **R5** | **Copy fidelity vs data binding.** The ask says copy; the binding layer cannot be copied. | Stated in §5.1 and acknowledged in the ledger — provenance headers make the boundary auditable. |
| **R6** | **Biomarker regression when it stops running CellViT itself.** | Phase 3 lands behind the artifact precondition; existing artifacts unaffected; L1-exact comparison of phenotype counts on one region before and after. |

---

## 8. Test strategy

- **Phase 1:** dependants refused with the list; disk gone; orphan-directory recovery; deleting a
  leaf leaves the parent intact.
- **Phase 2:** ring round-trip (`cells/*.npz` → polygon → raster → same count); instance ids unique
  and stable across resume; coverage/tallies atomicity (the Inc 4 invariant); stop mid-build then
  resume without double-counting.
- **Phase 3:** phenotype counts identical before/after the nuclei-artifact switch on one region.
- **Phase 4:** the vendored components render against a fixture; `npm run build` clean.
- **Phase 5:** toggling in the workspace mounts/unmounts the right layer; the three panels no longer
  own visibility; delete removes the row from the list.
- **E2E on real weights:** run nuclei on a region, see the mask, toggle it, delete it, confirm the
  directory is gone.

---

## 9. Out of scope

- Extracting the artifact machinery into a shared package (R2) — a separate refactor, better done
  with three call sites in hand than two.
- Named/multiple workspaces per slide (D1 alternative).
- Migrating existing point-annotation nuclei — impossible, §1.
- Client-side instance picking / hover-a-nucleus — `instances/` is written to make it possible, not
  wired up here.
- Nuclei as an agent tool.
