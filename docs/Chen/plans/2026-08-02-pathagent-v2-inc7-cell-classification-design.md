# PathAgent v2 · Inc 7 — Cell Classification as a Second Step · Design

> **Date:** 2026-08-02
> **Author:** Chen (with Claude)
> **Status:** Implemented and verified on the DEMO slide — GPU smoke and browser E2E both green
> (§12). The E2E found four dispatch/UI defects, all fixed and covered by tests; one of them
> (a second region being a silent no-op) predates this increment and affects `tissue` and
> `biomarker` too. Not committed.
> **Reuses:** Inc 5 (nuclei artifact, coverage + tallies, cooperative stop, instance raster),
> Inc 6 (Analysis catalog, Girder job substrate, Runs list, artifact rows).
> **Ask (verbatim):** 不需要管 main 的分支，讲这个分类头下载下来，并且接入 nuclei segmentation
> 的功能中，再 nuclei segmentation 中加入一个新选项是 cell classification, 然后可以选择不同的
> 模型。所以整个流程分成两步： 先 segment，再分类
> **Amendment (verbatim):** 那可以再运行 cellvit 的过程中不做 Pannuke 的分类么 · 旧的 artifact
> 不需要了 可以都删除掉

---

## 0. What this is

CellViT's segmentation and its cell typing are two different things wearing one name. Today they
arrive together and leave together: one run produces polygons *and* PanNuke labels, and the labels
are the only ones this system will ever have for that slide. This increment splits them.

1. **Segmentation stores what classification needs.** CellViT's classifier heads do not look at
   pixels — they look at a 1280-dimensional token the encoder already produced for every nucleus,
   and which we currently throw away. Persisting it makes classification a second step that costs
   no GPU and no encoder pass.
2. **Classification becomes its own tool.** `Cell classification` joins the Analysis catalog: pick
   a nuclei artifact, pick a model, run. It can be run again with a different model on the same
   artifact, as many times as there are models.
3. **PanNuke stops being special.** It becomes one taxonomy among six, stored the same way as the
   other five, differing only in that segmentation produces it for free.

The result on a breast slide is the point of the exercise: NuCLS and PanopTILs were trained on
TCGA-BRCA, and they name **sTIL** — a quantity PanNuke's five pan-organ classes cannot express.

---

## 1. Decision ledger (grilled with Chen, 2026-08-02)

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Where step 2 gets the 1280-d token | Segmentation persists it (`graph=True` → per-core `.npy`, fp16) | Classification then needs no GPU, no encoder, no ray. A re-run of the encoder would cost the whole segmentation again per model, and its new instances would not align with the stored rings. |
| D2 | Does token presence enter `art_hash` | Yes — `tokens=1` in the canonical string | An artifact without tokens cannot be classified. That is a difference in what the artifact *is*, and the address should say so rather than leaving two incompatible things at one address (the `conch_v1` lesson). |
| D3 | Where classification results live | Sidecar inside the same nuclei artifact; **no new artifact row** | Rings are stored once. One row cannot show two contradictory colourings of the same cells. Structurally identical to a second region run extending coverage — a job in the Runs list, no new row. |
| D4 | UI entry point | A separate `Cell classification` tool in the Analysis catalog | The whole value of D1 is re-classifying an artifact that already exists. A parameter on the segmentation form cannot express that without asking for a segmentation nobody wants. |
| D5 | Which heads to expose | NuCLS super, NuCLS main, PanopTILs, MIDOG, OCELOT | The three breast heads are the point; MIDOG (mitosis) is one of the three components of breast grading; OCELOT is a cheap tumour/other mask. Lizard and CoNSeP are colorectal and are left out. |
| D6 | How the heads reach the box | Upstream's own `cache_classifier()` | Do not invent a mechanism. It downloads Zenodo's `classifier.zip` into `$CELLVIT_CACHE/classifier/sam-h/` — the same volume, the same failure mode as the 2.8 GB SAM-H checkpoint already there. |
| D7 | Coverage when segmentation grows past a taxonomy | Each taxonomy carries its own `coverage.json` and `summary.json` | Inc 4's invariant: a tally describes exactly the tile list it is written beside. Re-running the tool fills the gap and skips what is done. |
| D8 | Where PanNuke goes | Into `labels/pannuke/` like the rest; `cells/*.npz` loses its `cls` column | Symmetry with no special case in the reader. PanNuke is not a *cheaper* taxonomy, it is one the segmentation pass happens to produce; that is a fact about *when* it is computed, not about *where* it belongs. |
| D9 | Scope of a classification run | None — it covers the upstream artifact's whole coverage | Classification is cheap. A `scope` parameter would let every taxonomy hold an arbitrary subset, turning "how much of this slide is labelled" into a question needing six answers. |
| D10 | Agent / Copilot | Untouched this increment | The ask is entirely UI-side, and "which taxonomy should the agent pick" is a real question (it would have to know Lizard is colorectal) that deserves its own thinking rather than a rider here. |
| D11 | Palette | One colour per semantic family, shared across taxonomies | Inherits the existing rule that a nucleus called *neoplastic* and a region called *tumour* get the same colour because they are the same claim at two scales. Extends it sideways: switching taxonomy then changes the subdivision, not the picture's dominant colour, so the two are comparable. |
| D12 | Per-cell confidence | Store softmax `prob` (fp16); show nothing this increment | 2 bytes a cell, and re-running to get it later is cheap but not free. Nobody has looked at its distribution yet, and a number that looks like confidence gets believed — the find_regions z-score was removed for exactly that. |
| D13 | Deliverable | This design doc, then one implementation pass | Smaller than Inc 6 and confined to one service plus two frontend files. |
| D14 | Existing artifacts | **Deleted**, not migrated | Chen: 旧的 artifact 不需要了 可以都删除掉. Removes the compatibility layer that reading two `npz` schemas would otherwise need. |

---

## 2. What CellViT++ actually gives us

Established by reading the installed package (`cellvit==1.0.9`, image `agent-cellvit:latest`) and
the checkpoint tensors, not from the paper.

**The heads are tiny MLPs over cell tokens.** `LinearClassifier` is
`Linear(embed_dim→hidden) · ReLU · Dropout · Linear(hidden→C)`. Verified from the checkpoint
storage sizes: every SAM-H head has `embed_dim = 1280`, and `hidden` is 128 (nucls_super) or 512
(the rest). All three inspected heads were trained with `normalize_stains = False`, so no Macenko
step is implied — the token from our ordinary segmentation pass is the input the head expects.

**The taxonomy is applied after the fact, not during.** In `postprocessing_cupy.py` the pipeline
is: `nuclei_binary_map` + `hv_map` → watershed → instances; then `nuclei_type_map` gives each
instance a PanNuke type; then, *if a classifier is loaded*, `classifier(tokens)` → softmax → argmax
overwrites `cell["type"]`. `binary=True` likewise just rewrites every type to 1 afterwards.

Two consequences the design leans on:

- **PanNuke costs nothing and cannot be switched off.** `nuclei_type_map` is one of the decoder's
  three heads and `check_network_output` asserts it is present. Turning it off would save no time
  and no memory, only the writing of a pyramid. So D8 keeps it — as a taxonomy, not as a privilege.
- **Our classify step is a verbatim copy of the upstream operation**, moved in time. Same tokens,
  same MLP, same softmax-argmax. We are not inventing an inference path; we are running theirs
  later, from disk.

**Two upstream defects we route around rather than inherit:**

- `f["type_prob"] = int(z)` truncates a 0–1 float to an int, so upstream's confidence is always 0.
  Computing softmax ourselves gives the real value (D12).
- `_load_classifier` reads `run_conf["data"]["label_map"]`, but neither NuCLS checkpoint carries
  that key (only `classification_level`), so `nuclei_taxonomy="nucls_super"` raises `KeyError` in
  1.0.9. Since we load the head ourselves and supply names from our own registry (§4), this never
  executes. The names come from upstream's `cellvit/training/datasets/nucls.py`, vendored the same
  way `pannuke.py` already vendors the PanNuke map.

**Token alignment is guaranteed.** `graph_data["cell_tokens"]`, `positions` and `nuclei_types` pass
through the same `keep_idx` filter, the same `_reallign_grid` and the same `_remove_padding` as
`cell_dict_wsi["cells"]`. Row *i* of `cells.pt` is cell *i* of `cells.json`.

---

## 3. Artifact layout

```
/cache/{item}/nuclei/{art_hash}/
  meta.json              slide dims · mpp · store_mpp · level_offset · backend · taxonomies{}
  coverage.json          core · done[[tx,ty]…] · totals        ← segmentation's coverage
  cells/{tx}_{ty}.npz    xy · inst · ring_off · ring_xy · origin      (no cls)
  tokens/{tx}_{ty}.npy   float16 [N, 1280], row-aligned with cells/
  instances/{z}/{x}_{y}.png   packed instance ids                     ← shared substrate
  cover/{z}/{x}_{y}.png       per-pixel nucleus fraction              ← shared substrate
  labels/
    pannuke/
      coverage.json      done[[tx,ty]…] · totals                      ← this taxonomy's own
      summary.json       n_nuclei · counts_by_class · n_tiles · area_mm2
      cls/{tx}_{ty}.npz  cls uint8 [N] · prob float16 [N]             row-aligned with cells/
      classes/{z}/{x}_{y}.png   paletted class raster
    nucls_super/   … same five entries
    panoptils/     … same five entries
```

`art_hash = sha1("nuclei|backend=cellvit-sam-h|mpp=0.25|tokens=1|ver=inc7-1")[:16]`

Unchanged from Inc 5: the slide is in the path, not the hash; the bbox is coverage, not identity;
a tissue segmentation selects tiles and therefore is coverage too. New: `tokens=1` (D2), and the
version bump that D14 makes free of consequence.

**What is taxonomy-independent stays at the root.** Geometry, tokens, the instance-id raster and
the coverage raster are the same array for every taxonomy. Only the class raster and the counts
are per-taxonomy — which is exactly §5's point.

### Measured sizes

From the existing whole-slide demo artifact (`6a6e1ca82ae96ce927e33818`, 121 cores, 32.4 mm²,
16,093 nuclei):

| plane | today | after |
|---|---|---|
| `cells/` | 2.1 MB | 2.1 MB |
| `tokens/` | — | **≈ 41 MB** (16,093 × 1280 × 2 B) |
| `instances/` | 34 MB | 34 MB |
| `cover/` | 41.6 MB | 41.6 MB |
| `classes/` | 40.9 MB | ≈ 41 MB **per taxonomy** |
| total | 119 MB | ≈ 160 MB segmented, ≈ 365 MB with all six taxonomies |

The tokens are not the expensive part; the per-taxonomy class pyramid is. Both are small enough
that the existing `CELLVIT_MIN_FREE_GB=20` guard needs no new arithmetic — it already refuses to
*start* a whole-slide run below 20 GB, and six taxonomies of a slide this size fit in 0.4 GB. The
guard's estimate is left alone; if a much denser slide changes that, the number to revisit is in
one place.

---

## 4. The taxonomy registry

A new `services/cellvit/src/cellvit_service/taxonomy.py` replaces `pannuke.py`, holding for each
of the six: stored ids, upstream names, display names, colours, and — for the five heads — the
checkpoint filename.

**Stored ids are 1-based, always.** Palette index 0 means "no nucleus here" (Inc 5's rule, and
what makes the background and a class impossible to confuse). PanNuke's model already emits 1–5;
the classifier heads emit 0-based ids, so the registry records `stored_id = model_id + 1` for
them. This shift lives in the registry and nowhere else.

| taxonomy | organ | stored id → upstream name → display name → colour |
|---|---|---|
| `pannuke` | pan-organ (19) | 1 `Neoplastic` · D55E00 — 2 `Inflammatory` · 009E73 — 3 `Connective` · 0072B2 — 4 `Dead` · CC79A7 — 5 `Epithelial` · E69F00 |
| `nucls_super` | breast (TCGA-BRCA) | 1 `tumor_any` → Tumour (any) · D55E00 — 2 `nonTIL_stromal` → Stromal (non-TIL) · 0072B2 — 3 `sTIL` → sTIL · 009E73 — 4 `other_nucleus` → Other · 999999 |
| `nucls_main` | breast (TCGA-BRCA) | 1 `tumor_nonMitotic` → Tumour (non-mitotic) · D55E00 — 2 `tumor_mitotic` → Tumour (mitotic) · F0E442 — 3 `nonTILnonMQ_stromal` → Stromal (non-TIL, non-macrophage) · 0072B2 — 4 `macrophage` → Macrophage · 56B4E9 — 5 `lymphocyte` → Lymphocyte · 009E73 — 6 `plasma_cell` → Plasma cell · CC79A7 — 7 `other_nucleus` → Other · 999999 |
| `panoptils` | breast | 1 `Other Cells` · 999999 — 2 `Epithelial Cells` · E69F00 — 3 `Stromal Cells` · 0072B2 — 4 `TILs` · 009E73 |
| `midog` | pan-organ | 1 `Mitotic` · F0E442 — 2 `Non-Mitotic` · 999999 |
| `ocelot` | multi-organ | 1 `Other Cell` · 999999 — 2 `Tumor Cell` · D55E00 |

The colour column is one function of the class's semantic family, not seven independent choices
(D11): tumour → vermillion `D55E00` (the tissue map's Tumour), immune → bluish green `009E73`,
stromal → blue `0072B2`, epithelial → orange `E69F00`, mitotic → yellow `F0E442`, macrophage →
sky blue `56B4E9`, apoptotic/plasma → reddish purple `CC79A7`, other → grey `999999`. All
Okabe-Ito, as `pannuke.py` already was, so nothing on screen changes language.

Class names are stored under their upstream spelling and displayed under the readable one; the
key a hidden-class toggle uses is the stored one, so hiding cannot break on a rename.

---

## 5. The class raster is derived, not redrawn

The single most useful property of the Inc 5 rasteriser is that it does **one** drawing pass and
derives two planes from it (`raster.rasterise_core`): polygons are filled with the nucleus's
*instance id*, and the class raster is `lut[ids]` — a lookup table from id to class.

Under the sidecar model that lookup is the whole of classification's drawing work:

```
classify(core):
    read  instances/{0}/{x}_{y}.png  for this core's tiles   (already on disk)
    build lut: instance id → stored class id, from labels/{tax}/cls/{tx}_{ty}.npz
               plus the eight neighbours' (a nucleus is drawn into the core its ring reaches)
    write labels/{tax}/classes/{0}/{x}_{y}.png = lut[ids]
    build_levels_above for those tiles
```

No polygon is filled, no ring is read, no geometry is touched. A taxonomy's pyramid costs a LUT
apply over the stored instance raster.

**One change this forces at segmentation time.** `rasterise_core` currently skips a nucleus whose
class is not in `DRAWABLE`, so the instance raster is filtered by a PanNuke judgement. Once the
instance raster is the shared substrate for six taxonomies that filter is wrong: a nucleus PanNuke
declined to name must still exist for NuCLS to name it. **Every nucleus is drawn.** A nucleus a
given taxonomy has no class for renders as background in *that* taxonomy's plane and stays in its
counts, which is what the old comment intended anyway.

**Neighbour dependency.** A core's class raster needs labels for the nuclei of its eight
neighbours, because their rings reach in. This is the same dependency `_needs_redraw` /
`draw_one_core` already manage for segmentation, and it is why D9 runs classification over the
whole coverage rather than a sub-region: a partial pass would leave seams that a later pass has to
find.

---

## 6. The two steps

### Step 1 — segmentation (changed)

`infer.py` builds `CellViTInference(..., nuclei_taxonomy="pannuke", graph=True)` — the one flag
change — and `_cellvit_segment_array` additionally loads `cells.pt` beside `cells.json`, returning
`tokens` as a fourth aligned array. `segment_array`'s contract becomes
`(points, classes, contours, tokens)`; the stub backend returns a zero token block of the right
shape so the GPU-free path and CI stay identical in shape.

`nuclei.run_region` writes `tokens/{tx}_{ty}.npy` in the same atomic write as `cells/`, and writes
PanNuke's labels to `labels/pannuke/` instead of into the `npz`. Its tallies go to
`labels/pannuke/coverage.json`; the root `coverage.json` keeps the tile list and drops
`counts_by_class` (a count belongs to a taxonomy now).

### Step 2 — classification (new)

`services/cellvit/src/cellvit_service/classify.py`:

```
run_classify(root, taxonomy, report, should_stop):
    head = load_head(taxonomy)          # cache_classifier() → torch.load → LinearClassifier
    for (tx, ty) in upstream_coverage - taxonomy_coverage:
        tokens = np.load(tokens/{tx}_{ty}.npy)          # [N, 1280] fp16
        logits = head(tokens.float())                   # CPU or GPU, whichever is present
        prob   = softmax(logits); cls = argmax + 1      # +1: stored ids are 1-based
        write labels/{tax}/cls/{tx}_{ty}.npz atomically
        extend labels/{tax}/coverage.json  (tile list + tallies, one write)
        redraw this core and any neighbour whose picture the new labels change
        report(done, total)
        if should_stop(): break
```

Cooperative stop at the core boundary, tallies in the same atomic write as the tile list, resume
by skipping what is covered — the three properties Inc 4 and Inc 5 settled, inherited rather than
re-derived.

Torch is imported lazily, as everything GPU-adjacent in this service already is: the head is 3 MB
and runs on CPU in about a second per core, so the base image can do this even with no GPU.

---

## 7. HTTP surface

New on the cellvit service:

| route | purpose |
|---|---|
| `POST /classify` | `{slide_ref, art_hash, taxonomy}` → enqueue; returns `{art_hash, job_id, status, taxonomy}`. Refuses 404 if the artifact has no `tokens/`, 400 for an unknown taxonomy. |
| `GET /classify/status/{job_id}` · `POST /classify/cancel/{job_id}` | The `JobQueue` shape the three map services already serve. |
| `GET /nuclei/catalog` | The taxonomy registry as data: id, label, organ, classes, colours, and which heads this box actually has on disk. Modelled on `/tissue/catalog`, and for its reason — which models a deployment has is a deployment fact. |

Changed:

- `GET /nuclei/{item}/{ahash}/meta` — `classes` / `colors` / `class_ids` become
  `taxonomies: {id: {label, organ, classes, colors, class_ids, coverage, summary}}`, so one read
  still answers everything the expanded row shows for every taxonomy.
- `GET /nuclei/{item}/{ahash}/tile/classes/{z}/{x}/{y}.png` — takes `?taxonomy=`, default
  `pannuke`. The `instances` layer is unaffected: it is taxonomy-independent.
- `GET /nuclei/{item}/{ahash}/cells` — takes `?taxonomy=`, default `pannuke`; the `classes` array
  is that taxonomy's display names. Its shape is unchanged, which matters because `/segment`
  returns the same shape.
- `POST /nuclei/hash` — the canonical string gains `tokens=1`.

`POST /segment` (the agent's stateless call) is untouched (D10).

---

## 8. Job substrate

`classify` is a new **run kind**, not a new artifact kind. One entry in
`girder_pathassist/routing.py`:

```python
"classify": Route(
    env="PATHASSIST_CELLVIT_URL", default="http://localhost:8020",
    submit="/classify", status="/classify/status/{job_id}",
    cancel="/classify/cancel/{job_id}", nested_result=True, item_key="slide_ref",
),
```

and one in the gateway's `_HASH_ROUTE` — `("cellvit", "/nuclei/hash")`, the same address as
`nuclei`, because a classification run *is* a run against that artifact's hash.

That identity is what makes D3 free in the Workspace: `runJoin.js` unions artifacts and runs on
`art_hash`, so a classification job attaches its progress line to the existing Nuclei row
(`18 / 43 · classify`) and produces no ghost row, because the row already exists. Nothing in
`runJoin.js` changes.

The gateway gains `POST /slides/{item}/classify` beside `start_nuclei`, dispatching through the
same plugin path. It writes no row and updates none: the artifact row already exists and its
identity has not changed.

---

## 9. UI

### Analysis catalog

One entry in `nativeCatalog.js`, after `nuclei`:

```
Cell classification
  Nuclei artifact  ▾   (pa-artifact, kind 'nuclei', required)
  Model            ▾   (string-enumeration, options from GET /nuclei/catalog)
```

The artifact picker lists this slide's ready nuclei rows. The model list comes from the service
because which heads are on disk is a deployment fact; each option carries its organ and class count
as the `note` the form already renders, so choosing a colorectal head for a breast slide is a
visible act rather than an invisible one.

### Workspace

`artifactDetail.js`'s `nuclei` entry gains a taxonomy selector above the class list. Selecting one
switches, together: the class rows and their counts, the `Covered` line (that taxonomy's coverage,
which may be smaller than the segmentation's — D7), and the `?taxonomy=` on the layer's tiles. The
selection lives in the store as `nucleiLayerParams.taxonomy` beside `render`, `opacity` and
`hidden`, so the mask keeps its colouring while the Workspace is closed.

Default is `pannuke` — the one taxonomy every artifact is guaranteed to have.

When a taxonomy's coverage is smaller than the artifact's, the row says so in one line rather than
silently reporting a number over a smaller area than the reader assumes.

`hidden` is per-taxonomy (a class name hidden in one is not a class name in another), so it becomes
`hidden: {[taxonomy]: {[class]: true}}`.

---

## 10. Migration

There is none: the two existing artifacts are deleted (D14).

```bash
docker run --rm -v agent_cellvit_cache:/c alpine \
    sh -c 'rm -rf /c/*/nuclei/22df87650797898e'
```

631.8 MB across `6a6e1ca82ae96ce927e33818` (the DEMO slide) and `6a3d59bed59c30f37fd998a0`. Their
rows are removed through the gateway's existing artifact delete so Postgres and disk agree.

This is what buys the clean `npz` schema: `read_cell_arrays` recognises exactly one layout, and no
code anywhere asks whether an artifact predates tokens.

---

## 11. What this is not

- **Not an agent capability.** Copilot keeps answering from PanNuke via stateless `/segment` (D10).
- **Not a confidence-filtered view.** `prob` is stored and displayed nowhere (D12).
- **Not a second segmentation backend.** `backend` stays `cellvit-sam-h`; a taxonomy is a label on
  the same outlines, and the hash reflects that by not including it.
- **Not multi-taxonomy rendering.** One taxonomy is drawn at a time, by construction (D3).
- **Not Lizard or CoNSeP.** Both are on disk after `cache_classifier()` and neither is offered
  (D5); adding them later is a registry entry.

---

## 12. Verification, on the DEMO slide

Every check runs on `TCGA-WT-AB44-01A-01-TS1` in `BRCA-DEMO/DEMO`
(item `6a6e1ca82ae96ce927e33818`), per the standing rule.

**Split (Chen, 2026-08-02):** the only new verification written this increment is the GPU smoke.
Browser E2E is Chen's, against a spec Chen edits.

### Existing suite — kept green, not extended

`services/cellvit/tests/` has ten files and seven of them read the `cls` column that §3 removes.
They are updated to the new layout so the suite stays green. This is maintenance of a schema
change, not new test coverage: no assertion is added for behaviour that did not exist before,
beyond what a renamed field forces.

| file | why it moves |
|---|---|
| `test_nuclei_instances.py`, `test_nuclei_raster.py` | build cells with `cls=`; the class raster now comes from a taxonomy's labels |
| `test_nuclei_routes.py`, `test_nuclei_wholeslide.py` | assert on root `summary.json` / `classes/` paths |
| `test_pannuke.py` | renamed to `test_taxonomy.py`, its PanNuke assertions kept as one taxonomy of six |
| `test_region.py`, `test_segment_route.py` | `segment_array` returns a fourth array |
| `test_recycle.py`, `test_infer.py`, `test_geometry.py` | unchanged |

### GPU smoke — the new verification

Run on the box, real weights, real slide. **All seven green, 2026-08-02**, on a six-core region of
the DEMO slide (`art_hash 179992e8d87cf34b`, 6 679 nuclei over 1.61 mm²).

1. A region run writes `tokens/{tx}_{ty}.npy` whose row count equals that core's row count in
   `cells/`, dtype `float16`, second dimension 1280. This is the `cells.pt` alignment claim of §2
   checked against real output rather than against upstream's source.
2. `labels/pannuke/` appears with the same counts the pre-Inc-7 artifact reported for the same
   region — the taxonomy moved, the numbers did not.
3. `Cell classification` with `nucls_super` over that region: every nucleus lands in stored ids
   1–4, and `sTIL` is non-zero on tissue with visible lymphocytic infiltrate.
4. The same again with `nucls_main`, `panoptils`, `midog` and `ocelot` — five heads load, five
   `labels/` directories appear, `cells/` and `tokens/` are written once.
5. `labels/{tax}/coverage.json`'s tallies describe exactly the tile list beside them, for each.
6. A stop mid-classification leaves a valid artifact; resuming completes it without recomputing a
   covered core.
7. `nucls_super` and `pannuke` disagree about individual nuclei but agree on the total — the same
   outlines, two labellings.

**What it found, over one 1.61 mm² region.** All six namings total 6 679, and the rendered tiles
carry the same 13 297 nucleus pixels — the shapes are drawn once and looked up six ways (§5).

| naming | tumour | immune | stroma / other |
|---|---|---|---|
| PanNuke | Neoplastic 1 573 (23.6 %) | Inflammatory 69 (1.0 %) | Connective 4 968 |
| NuCLS super | tumor_any 2 228 (33.4 %) | **sTIL 234 (3.5 %)** | nonTIL_stromal 4 216 |
| NuCLS main | tumor_nonMitotic 1 476 | lymphocyte 62 + plasma_cell 64 (1.9 %) | stromal 5 077 |
| PanopTILs | Epithelial 1 995 (29.9 %) | TILs 423 (6.3 %) | Stromal 3 943 |
| OCELOT | Tumor Cell 1 725 (25.8 %) | — | Other 4 954 |
| MIDOG | — | — | Mitotic 0 |

Five independently trained heads put the tumour population in a 1 476–2 228 band, which is the
agreement worth having. The immune population is where they separate: the three breast-trained
heads find 2–6× what PanNuke's pan-organ `Inflammatory` does, which is the whole reason this
increment exists. Zero mitoses in 1.61 mm² is what MIDOG should say at this area.

Two behaviours checked on the way through and worth recording because they are easy to get wrong:
the class tile's ETag follows *its own* naming's coverage (`pannuke` rev 2 while `midog` was still
rev 1), and the instance tile is byte-identical whether or not a taxonomy is named in its URL.

### Browser E2E — run 2026-08-02, all green after four fixes

Driven with Playwright against the running stack (`localhost:3000`, real Girder, real GPU) on the
DEMO slide. Every item below was run through the UI: the rectangle is a mouse drag on the canvas,
the model is picked from the form's select, the job goes on the Girder queue.

| | |
|---|---|
| A drawn rectangle survives screen → slide → request | ✓ max \|Δ\| 1 px on a 1001 × 800 drag |
| Segmenting a region produces one Nuclei row offering PanNuke only | ✓ |
| Filling in the classification form dispatches nothing | ✓ **after fix 1** |
| One click is one job | ✓ **after fix 1** (was four POSTs, three jobs) |
| The job attaches to the **existing** Nuclei row; no second row, in flight or after | ✓ **after fixes 2–3** |
| Six namings on one artifact, all counting 5 083 cells | ✓ |
| Switching the naming swaps the class table and recolours the mask | ✓ |
| Tumour / stroma / immune / epithelium each keep one colour across namings (D11) | ✓ measured off the rendered swatches |
| Extending the outlines leaves the classifier namings behind, and the row says so | ✓ **after fix 4** — 5 cores vs 4, "1 core has outlines this labelling has not reached" |
| A reload brings every naming, its counts and its colours back off disk | ✓ |
| No React key collisions anywhere in the flow | ✓ **after fixes 2–3** |

**Corrected from the pre-run spec.** That spec said "a reload restores taxonomy *selection*". It
does not, and should not: `nucleiLayerParams` is cleared on `setActiveItem` and never persisted,
exactly like `tissueLayerParams` and `markerLayerParams`. Which naming you last had selected is
session state of the same rank as opacity and the colour-by mode. What comes off disk is the list
of namings, their tallies and their palettes — and that does.

#### What the E2E found that the GPU smoke could not

All four are dispatch- or UI-path defects, invisible to a smoke test that calls the service
directly. They are recorded here rather than quietly fixed because each one is a shape worth not
repeating.

1. **The cost probe was running the job.** Every native form asks what a submission would cost by
   calling its own `submit` with `mode: 'plan'`, debounced, on each change. The `classify` entry
   dropped the argument and `POST /classify` had no `mode` parameter, so picking the run and then
   the model dispatched two real classifications before anyone pressed Run. Fixed in all three
   places (catalog entry, `startClassify`, the route) and pinned by
   `test_planning_a_classification_queues_nothing`.

2. **`KINDS` did not list `classify`.** The kind was added to `ROUTES` alone, so Girder refused
   every dispatch with a 400. Three tables describe a kind — `KINDS` gates, `ROUTES` addresses,
   `TITLES` names — and they are read in two different processes, which is why only a test notices
   when one is updated and the others are not. `tests/test_kinds.py` now holds them against each
   other.

3. **Two runs on one address made two rows.** `joinRuns` mapped its ghost rows over every
   unfinished run rather than over one per address. Inc 7 is the first kind where two runs
   legitimately share an address, so this surfaced as a "classify · Starting…" row that duplicated
   the Nuclei row's React key — and then outlived its own run, because a duplicate key lets React
   drop or keep children arbitrarily. It also read `classify`, since `KIND_LABEL` had no entry.

4. **A second region was a silent no-op** — see below. This one is not Inc 7's, and is the answer
   to what Chen reported seeing.

#### The region complaint, measured

Reported as "what it ran isn't what I selected". Two separate causes, one by design and one a bug.

**By design, and now stated in the form.** Coverage is a set of 2048 px core tiles, which is what
lets two regions of one slide share one artifact and lets a stopped build resume. A drawn rectangle
is therefore rounded *outwards* to whole tiles. Measured: a 1001 × 800 box at (13 799, 12 000)
straddles a tile corner and computes 4 × 2048² = 4096 × 4096 at (12 288, 10 240) — **21× the drawn
area, its origin 1 511 px left and 1 760 px above the rectangle**. Nothing said so, so it read as a
misplaced run. The Region field's help text now says it.

**The bug.** A nuclei artifact is addressed by model and resolution, never by the rectangle — that
is what makes the shared coverage set possible. But `missing()` read "its bytes exist" as "there is
nothing left to run", so the *second* region on a slide, and every resume of a stopped whole-slide
build, was answered `ready` with an empty step list: no job queued, no error, the mask still
showing the first region. The panel's own description promises the opposite ("stopped … and resumed
by starting the same run again"). `GROWABLE_KINDS` now exempts the target of a submission — and
only the target, so a marker map still reuses the nuclei underneath it rather than re-running an
hour of GPU. Covered by four tests in `test_plan.py` and two in `test_dispatch_routes.py`.

The same rule applied to `tissue` and `biomarker`, which have the same growable shape and were
broken the same way.

---

## 13. Files

**`services/cellvit/`**

**`services/cellvit/`**

| file | change |
|---|---|
| `taxonomy.py` | **new**, replaces `pannuke.py` — six taxonomies, ids/names/display/colours/checkpoints, `model_offset`, `palette_bytes()` |
| `pannuke.py` | deleted |
| `heads.py` | **new** — `cache_classifier()` wrapper, `torch.load` → four numpy arrays, `Head.__call__` runs the MLP in numpy so the GPU-free image can classify too |
| `classify.py` | **new** — `run_classify` (the step-2 loop of §6) |
| `artifacts.py` | `art_hash` gains `tokens=1`; `PIPELINE_VERSION` → `inc7-1`; `write_cells` / `read_cell_arrays` drop `cls`; new `tokens_path` / `label_dir` / `labels_path` / `write_labels` / `read_labels` / `write_tokens` / `read_tokens` / `has_tokens` / `stored_taxonomies`; `summary_path` and `class_tile_path` take a taxonomy; `Coverage` reused per taxonomy, unchanged |
| `infer.py` | `graph=True`; read `cells.pt`; `segment_array` returns a `Segmented` — five named, index-aligned arrays instead of a three-tuple, because five parallel lists positional-unpacked at six call sites is the shape that mis-pairs once and then labels every nucleus from its neighbour's embedding |
| `nuclei.py` | write `tokens/`; write PanNuke into `labels/pannuke/` with its own coverage; `_write_meta` writes `taxonomies[]`; new `refresh_meta` |
| `raster.py` | `rasterise_core` draws **every** nucleus; class raster from a taxonomy's labels; new `rasterise_class_core` / `rasterise_labels` (the lookup path); per-plane self-healing |
| `pyramid.py` | class tile read/write take a taxonomy; `build_levels` splits into shared and per-taxonomy |
| `tiles.py` | `parse_show` / `parse_colors` / `colourise` take a taxonomy |
| `routes.py` | `/classify`, `/classify/status`, `/classify/cancel`, `/nuclei/catalog`; `?taxonomy=` on tile and cells; per-taxonomy coverage and summary in meta |
| `app.py` | `warm_heads()` at boot; `/segment` reads a `Segmented` |
| `tests/` | `test_pannuke.py` → `test_taxonomy.py`; new `support.py`; seven files updated for the schema |

**`services/girder_pathassist/`** — one `Route` in `routing.py`.

**`services/agent/`** — `POST /slides/{item}/classify` and `GET /nuclei/catalog` in `gateway/routes.py`;
`get_nuclei_json` in `loop/nuclei_client.py`; a `TITLES` entry in `gateway/plan.py`. Deliberately
**not** through `_plan_and_dispatch`: its input is a built artifact, so the planner would find the
address already in `have` and answer `ready`.

**Frontend**

| file | change |
|---|---|
| `src/api/nucleiApi.js` | `startClassify`, `getNucleiCatalog`; `tileUrl` params carry `taxonomy` |
| `src/components/panels/analysis/nativeCatalog.js` | the `Cell classification` entry |
| `src/components/workspace/nuclei.js` | every reader takes a taxonomy: `classRows` / `colorsOf` / `classesOf` / `coverageSummary` / `formatArea` / `totalNuclei`; new `taxonomiesOf` / `resolveTaxonomy` / `hiddenIn` / `unlabelledTiles` |
| `src/components/workspace/artifactDetail.js` | taxonomy selector, per-taxonomy coverage line and `hidden`, `segment()` splits key from label |
| `src/components/viewer/ArtifactLayers.jsx` | resolve the taxonomy, pass it into the tile URL, take `rev` from that naming's coverage |
| `src/store/index.js` | `nucleiLayerParams.taxonomy`, `hidden` keyed by taxonomy |

**Not** `src/components/viewer/pannukeColors.js`. It colours the *Copilot's* overlay, which reads
the stateless `/segment` and therefore still gets PanNuke and only PanNuke (D10). Listing it here
in the first draft was a mistake: it has nothing to do with the artifact layer.

---

## 14. Open questions

None blocking. Two things deliberately deferred:

- **Whether `prob` deserves a UI.** Look at its distribution on the DEMO slide first (D12).
- **Whether the agent should choose a taxonomy.** It needs to know what each head was trained on
  before it can pick one responsibly (D10).
