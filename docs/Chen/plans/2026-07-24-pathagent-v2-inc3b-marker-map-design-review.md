# Inc 3b design — adversarial, code-grounded review

> Reviewed: `2026-07-24-pathagent-v2-inc3b-marker-map-design.md`
> Method: read the design against the actual code it will touch
> (`services/cellvit/src/cellvit_service/infer.py`, `services/biomarker/**`,
> `services/preprocess/src/preprocess_service/{jobs,artifacts}.py`,
> `services/agent/src/agent/gateway/routes.py`, `node_modules/openseadragon@4.1.1`).
>
> **Verdict: 2 blocking · 6 should-fix · 3 open.** All blocking findings have a concrete fix; none
> invalidate a grilling decision.

---

## Blocking

### B1 — Job tiles at 1024² double-count and mutilate nuclei at every tile seam

`cellvit_service/infer.py:41-56` pins `_CELLVIT_PATCH = 1024`, `_PAD_MARGIN = 128`,
`_CELLVIT_TARGET_MPP = 0.25`, and

```python
def _min_native_side(mpp): return ceil((1024 + 128) * 0.25 / mpp)
```

At the BRACS mpp of 0.2519 this is **1143 px**. A 1024² job tile is therefore *below* the minimum
and gets `_pad_to_min`-ed on **every single call** — the design's chosen job-tile size guarantees
the pathological path the R11 spike added padding to work around.

Far worse, and independent of padding: the design calls CellViT once per job tile with **no
overlap**. CellViT's internal edge-dedup only operates within one `process_wsi` call, so a nucleus
straddling the boundary between job tile *A* and job tile *B*:

- is detected **twice** (once as a partial in each) → whole-slide counts inflate along every seam,
- is **rasterised as two clipped fragments** → the phenotype map grows a visible grid of chopped
  nuclei, which is precisely the "beautiful map" failure mode this increment exists to fix,
- gets a **truncated pooling disk** on each side → its marker vector, and therefore its lineage,
  is computed from partial evidence.

At a 1024 grid over 3 Gpx of tissue there are ~3000 tiles and ~12 000 internal seam-edges. This is
not an edge case, it is the dominant artifact.

**Fix — haloed tiles with centroid-ownership.** Read each job tile with a halo, detect over the
haloed image, but *own* only nuclei whose **centroid** falls in the core:

```
CORE = 4096            # level-0 px, comfortably above _min_native_side for any real mpp
HALO = 256             # > 2× the largest plausible nucleus diameter (~40 px at 0.25 µm/px)

read   [x-HALO, y-HALO, CORE+2·HALO]²
detect → contours in haloed frame
keep   contours whose centroid ∈ core        # exactly-once ownership, no dedup pass needed
draw   the FULL contour (may extend into the halo) then crop the raster to the core
pool   the marker disk from the HALOED mIF   # complete disk even for core-edge nuclei
```

Centroid ownership is a partition of the plane, so every nucleus is claimed by exactly one tile —
no proximity-dedup heuristic, no threshold to tune. Raising the core to 4096 also drops the tile
count ~16× (≈190 tiles per slide instead of ≈3000), which cuts per-call CellViT fixed overhead
proportionally, and 4096+512 = 4608 > 1143 so `_pad_to_min` becomes the no-op it was designed to
be for large regions.

This also **retires design §10's "Coarse-level phenotype downsampling losing nuclei"** as the only
nucleus-integrity risk — the seam risk was the bigger one and it was unlisted.

### B2 — `204 No Content` for uncovered tiles breaks OpenSeadragon's loader

Design §6: *"Missing tile ⇒ **204 No Content**, which OSD renders as a hole"*. It does not.
OSD 4.1.1's default image loader creates an `Image` element and resolves on its `onload`
(`openseadragon.js`, `ImageJob.prototype.start`); a 204 carries no image body, so `onerror`
fires, the tile is recorded as failed, `tile-load-failed` is raised, and OSD applies its
retry/backoff — for *every* uncovered tile, on *every* viewport move. On a partially-covered
slide that is hundreds of failing requests per pan.

**Fix:** return a **fully transparent 256×256 PNG** (a module-level constant, ~100 bytes gzipped,
built once at import). It renders as a hole, costs one cached response, and never trips the error
path. Set `Cache-Control: public, max-age=31536000, immutable` on it specifically, since the
"nothing here" answer for an uncovered tile is only invalidated by a coverage change, which
already bumps the ETag via `threshold_rev`/coverage revision.

---

## Should-fix

### S1 — Two pyramids with different native resolutions must still align in OSD

The marker pyramid is 1 µm/px and the phenotype pyramid is 0.25 µm/px, so their level-0 raster
dimensions differ by 4×. If each `tileSource` declares its own pixel dimensions, OSD lays them out
in different coordinate frames and the two modes will not register against the H&E.

**Fix:** every `tileSource` declares the **slide's level-0 dimensions** as `width`/`height`, and
each pyramid's own coarser native resolution is expressed as a **level offset**: the marker
pyramid's stored level *k* is served as OSD level *k + 2* (4× = 2 octaves). `meta.json` carries
`level_offset` per layer so the frontend does not hardcode it. Add an explicit test that a fixed
level-0 point maps to the same viewport position in both layers.

### S2 — Store the 20 marker planes as 20 *named* arrays in the npz, not one stacked array

Design §5 specifies `markers/{z}/{x}_{y}.npz  # uint8 [20,256,256]`. A single stacked array must
be fully decompressed to read any channel, so a 3-marker composite pays the full 1.3 MB
decompression on every tile request.

**Fix:** `np.savez_compressed(f, CK=…, CD8=…, …)` — one member per channel. `np.load(f)["CD8"]`
inflates that member only. A typical 4-marker composite then decompresses ~260 KB instead of
1.3 MB, a 5× cut on the hottest path in the system. Same file count, same total size.

### S3 — Phase 1 cannot ship the threshold sliders it promises

Design §9 puts "sliders" in Phase 1 and the cell sidecars in Phase 3, but §7's re-gate reads
`cells/` to recompute lineages. Phase 1 would ship dead sliders.

**Fix:** the per-cell records are a *byproduct* the pipeline already computes — write
`cells/{x}_{y}.npz` from **Phase 1**. Phase 3 then adds only the *consumers* (hover, region
statistics, CSV export). Re-word §9 accordingly, and keep Phase 1's marker sliders scoped to the
display transfer function (`lo`/`hi`/`gamma`), which needs no sidecars at all.

### S4 — Phase 1 must build coarse levels, not just level 0

§9 says Phase 1 skips "coverage/coarse-rebuild machinery". Without coarse levels a region's map is
invisible until you zoom to 1:1 — the exact opposite of the increment's goal. What Phase 1 can
skip is *incremental rebuild on extension* (Phase 2), not level generation.

**Fix:** Phase 1 builds the full pyramid for its region and writes `coverage.json` (ten lines —
Phase 2 cannot reconstruct what Phase 1 computed without it). Reword §9.

### S5 — Whole-slide pixel reads over Girder HTTP are the unexamined cost

`biomarker/region.py` reads pixels through Girder's `/tiles/region` PNG endpoint. The design's
diagram says "read pixels (local slide, or Girder)" but nothing makes the local path exist:
`docker-compose.yml:149-163` gives `biomarker` **no slide mount and no cache volume**, and the
base image has no OpenSlide. Only `preprocess` has `/data2:ro` + `slide_resolver`.

Per slide this is ~190 haloed reads after B1 (not 3000), so Girder is survivable — but each is a
PNG encode/decode of a 4608² region on the Girder side, which is neither fast nor free.

**Fix (explicit, not implied):** add to `biomarker` in compose — `${PREPROCESS_SLIDES_DIR}:/data2:ro`,
a `biomarker_cache:/cache` volume, and `preprocess_cache:/pcache:ro` (to read `contours.geojson`).
Add `openslide-python` to `Dockerfile.trident` only, and port the small `slide_resolver`
name+size matching tier. Girder stays the fallback when the local file is not found. This must be
a **named task**, not a footnote.

### S6 — `phenotype_cells` waiting on a region job can exceed its own timeout

D11 has the tool enqueue a region job and wait. `biomarker_client.phenotype_cells` uses
`timeout=300`, and the design itself quotes region jobs at "30 s–5 min" — so the tool's timeout is
exactly at the top of its own stated range, with threshold sampling (§7, tens of seconds on first
run for that slide) on top.

**Fix:** cap agent-enqueued jobs to one core tile (4096², the B1 core) and return a partial,
honest answer with the artifact handle if the job is still running when the tool's budget expires
("analysis started, N % done — the Markers panel will show it"). Never block the turn on an
unbounded job.

---

## Open (deliberate, revisit later)

- **O1 — Gateway proxies every tile.** Hundreds of tile requests per viewport traverse
  FastAPI→httpx→Flask. It is correct (the Girder token is checked once, the biomarker service is
  never publicly exposed) and async-streamable, but it puts the gateway on the hot path for
  imagery. If it measurably hurts, the fix is a short-lived signed tile URL, not a hole in D3.
- **O2 — `art_hash` requires a `seg_hash`, so a small region job is gated on a whole-slide tissue
  segmentation.** Justified: §7's slide-level thresholds need to sample tissue across the slide,
  which needs the mask. Worth revisiting only if segmentation turns out to be slow on real slides.
- **O3 — 1 µm/px marker storage is 4× above the model's 16 px ≈ 4 µm token resolution.** The design
  already labels the extra levels as decoder interpolation. Left as the user's explicit
  high-fidelity choice (D4); a later measurement of information content per level could justify
  dropping to 2 µm/px and halving disk.
