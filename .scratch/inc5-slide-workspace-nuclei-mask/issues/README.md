# Inc 5 — Slide Workspace + Nuclei as Mask · tickets

Source: `docs/Chen/plans/2026-07-31-pathagent-v2-inc5-slide-workspace-nuclei-mask-plan.md`.

Constraint applied on top of the plan: **every ticket must be verifiable in the browser UI.** The
plan's Phases 1–3 are backend-only and Phase 4 ends on a fixture, so the work is re-sliced — the
Workspace surface is taken first, and each backend increment afterwards shows up on it.

```
01 toolchain + tab shell
     └── 02 lists real artifacts
           ├── 03a the eye switches the tissue map ── 03b the eye owns every overlay
           └── 04 delete ──────────┐                        │
                                   └── 05 nuclei artifact (region, counts)
                                         ├── 06 the mask ──┬── 07 whole-slide: coverage/stop/resume
                                         │                 └── 08 instance-id raster
                                         └── 09 biomarker consumes nuclei
```

06 needs 03a (the eye machinery), not 03b.

Decided while breaking this down, and not in the plan:

- **Nuclei is triggered from a new Nuclei panel**, shaped like the Tissue panel. The plan gives
  nuclei an eye (§5.2) but never says where a build is started; today it is only reachable through
  the agent. Every nuclei ticket needs that surface to be verifiable.
- **05 is blocked by 04** for a practical reason, not a technical one: 05–08 accumulate large trial
  artifacts and there must be a way to delete them from the UI. Drop the edge to run them in
  parallel.
- Plan Phase 0 (dashboard WIP) is already done — commit `5d218a4`.
- **03 was split into 03a/03b while working it.** The tissue and marker tile layers are mounted by
  panels that unmount on a tab switch, so an eye in the Workspace requires moving them to an
  always-mounted owner first — the shape the canvas overlays already use. 03a does that for tissue;
  03b brings the rest across and deletes the old switches.
- The uncommitted tissue/biomarker delete endpoints in the working tree belong to ticket 04.

## What running it on a real slide turned up

All nine tickets were verified against the live stack (TCGA-3C-AAAU, 151392×37993, 434 tissue
cores), not only against tests. Five defects came out of that, and none of them were visible from
the test suite:

- **The gateway asked cellvit for a nuclei artifact's bytes at the wrong path.** `nuclei` fell into
  the preprocess branch of the address table. Usage reported 0 for every nuclei artifact, and a
  delete removed the durable row while leaving the directory on disk. The route tests double out
  the client, so a wrong URL still "reaches the worker" — the test now pins each kind against the
  route its service registers.
- **The counts and the coverage disagreed mid-run.** `summary.json` is written once at the end,
  coverage after every core, and the meta route paired a live tile list with stale counts. On the
  test slide it was reporting 7,616 nuclei over 26 cores; the real figure was 10,790.
- **The mask only appeared when the job ended**, which for a whole slide is over an hour. Cores are
  now drawn as they land.
- **The CellViT worker wedges** past twenty-odd consecutive `process_wsi` calls: the thread blocks
  in `ray.get()` inside vendored code with the actors alive at ~0 % CPU and the GPU idle, and never
  returns. Seen twice (after 21 cores, then 26) and confirmed by stack dump. Not interruptible from
  here, so the session is now rebuilt every 12 inferences. A mitigation, not a fix — the upstream
  behaviour is unexplained. It was also on the interactive `/segment` path, just more slowly.
- **The deployed tissue and preprocess containers predated ticket 04**, so their usage endpoints
  404'd. A rebuild, not a code change, but it is why the confirm dialog showed no size.

Measured, for plan R3, on TCGA-3C-AAAU (151392×37993, 434 tissue cores of 1406):

| | |
|---|---|
| whole-slide run | **65 min**, 323,634 nuclei — ~9 s per core |
| of which the finalisation pass | ~7 min (redraws every core to fix its seams) |
| a redraw with no inference | 17 min for all 434 cores |
| vectors (`cells/`) | 32 MB |
| class + cover rasters | 317 MB |
| instance raster (ticket 08) | 167 MB |
| **artifact total** | **514 MB** |

So the per-cell raster nearly doubles the artifact. It is written unconditionally today; if that
becomes the reason a slide does not fit, making it opt-in is a config flag and a `layers` entry,
not a redesign — nothing reads it but the view it feeds.

The number that decides whether whole-slide is routine is not the hour, it is that the run has to
be watched: without the session recycle above, the worker wedges after twenty-odd cores and nothing
in this codebase can interrupt it.
