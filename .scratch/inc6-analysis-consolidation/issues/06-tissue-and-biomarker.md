# 06 — Tissue and biomarker move across

**What to build:** the two remaining JobQueue-shaped kinds follow nuclei. Their submission moves to
the catalog, their numbers and layer controls to the Workspace, and their tabs go.

Mostly replication of 05. The one new thing is that `biomarker` has a real upstream requirement
(`nuclei_hash`, refused without — Inc 5 · D9), so it is the first entry whose form has to say what
it needs before 08 generalises that.

**Blocked by:** 05.

**Status:** done — verified on DEMO.

- [x] Both kinds submit through the catalog and appear in Runs with the same vocabulary as nuclei.
- [x] Biomarker's form names its missing upstreams explicitly and refuses rather than guessing.
      A hand-rolled check here is expected; 08 replaces it.
- [x] Marker mode/preset/channel controls and the tissue class list land in the Workspace row
      (04's components), including the two mutually exclusive marker modes.
- [x] `TissuePanel.jsx`, `MarkersPanel.jsx` and their tabs removed; `tissueUtils` / `markerUtils`
      keep the pure logic and their tests.
- [x] Cooperative stop for biomarker, which did not have it — the pattern is tissue's and nuclei's,
      and this is the third and last copy before 09 extracts it.
- [x] **Verified on DEMO:** a tissue map and a marker map built, drawn, tuned and stopped; the
      marker map correctly refusing until the nuclei artifact from 05 exists.

## What moved

```
tissue svc     POST /tissue/hash          the address, computed without enqueuing anything
biomarker svc  POST /biomarker/hash       the same
               POST /biomarker/cancel/{job_id}   + Progress/cancel in jobs.py, should_stop in
                                                   wholeslide.run_region
routing        biomarker.cancel           no longer None — Stop means the same thing for all three
gateway        start_tissue               content-address → dispatch → no row
               start_biomarker            the same, refusing without nuclei by name
               _parent_of                 the DAG edge, derived from the run's own params
               — cancel_tissue_build, the tissue/biomarker polling, four worker clients
               — _reconcile_artifact's three JobQueue branches and its `cancelled` case
frontend       workspace/tissue.js        was panels/tissueUtils.js, minus its panel half
               workspace/markers.js       was panels/markerUtils.js, minus its panel half
               artifactDetail.js          two more registry entries; `config` grew a vocabulary
               ArtifactConfig.jsx         choices / toggles / sliders / actions, one onChange
               ArtifactSegments.jsx       an optional colour, for the one kind whose colours are
                                          the user's
               store/runs.js              the Stop intent ends when the run settles
               — TissuePanel, MarkersPanel, their two tabs, cancelTissue, getTissueStats
```

`config` is the interesting part. Nuclei needed modes and an opacity; a tissue map also has a
confidence ramp and an H&E fade, and a marker map has a panel preset, a channel list and a display
transfer function. Rather than three props per kind, `artifactDetail` declares a small vocabulary
(`choices`, `toggles`, `sliders`, `actions`) and `ArtifactConfig` renders it without knowing what
any entry means — so a control's *reason* stays next to the kind that has it, and every control
reports back through one `onChange(key, value)`.

## Three calls worth not re-litigating

**The parent edge is derived in the gateway, not plumbed through the driver.** A tissue map's
parent is its segmentation; a marker map's is its nuclei; nuclei has none. The driver dials a URL
and forwards a result — it has no view of the DAG, and the gateway is what refuses a delete, so
the gateway is what says which edges exist (`_parent_of`, off the run's own params).

**A tissue map's parent *is* its segmentation, unlike nuclei's.** For nuclei the mask only decides
which tiles are worth the GPU, which is coverage; for the tissue map everything outside the
contours is masked out of the raster and the `seg_hash` is in the content address, so deleting the
segmentation would invalidate the map.

**Two things did not come across, and neither is an oversight.** *Measure region* — the tissue
panel's composition of a drawn rectangle — needs a region picker, which is Analysis's input surface
rather than the Workspace's; what the row reports is the artifact's own coverage, which is the
honest denominator for the numbers beside it. *Per-channel recolour* did come across, as upstream's
own "Change Color" menu item, because a channel colour is a choice about legibility; a tissue
class's and a phenotype's are the artifact's and stay fixed, which is what makes a swatch a
reliable key to the picture.

## What the runs showed (2026-08-02, DEMO slide)

Both workers had to be rebuilt onto their GPU images first — see below.

```
05:01:23  tissue, region 2574²  →  Running · tiles  →  Done in ~15 s
          row written by the report: ready · parent b7123a791abbbda1 · 4 tiles · 0.874 mm²
          TSR 0.6086, hard and soft fractions for all five classes
05:03:45  marker map, same region, on the nuclei artifact from 05
          Running · starting → sampling → tiles → Done
          row: ready · parent 22df87650797898e · 3,513 cells
05:06:02  marker map, whole slide → Stop
          driver forwarded the cancel; the service stopped at the core boundary
          settled CANCELED · 8 tiles · 3,565 cells · remaining 35
05:14:33  tissue map, whole slide → Stop → CANCELED · 7 tiles · remaining 36
```

The Workspace row for each, opened:

```
Tissue map    Covered 4 tiles · 0.874 mm²   TSR 0.609
              Tumour 28.6% · soft 27.2%   Stroma 44.5% · soft 42.1%   …
              Classes | Probability | Outline · Opacity 0.45 · Alpha follows confidence
              · Faintest 0.20 · H&E 1.00 · Export CSV
Biomarker map Covered 4 tiles · 1.07 mm²    Cells 3,513
   markers    CK · CD3 (no separable positive population) · CD138 · CD68
              · CD34 · endothelial — near-equivalent of CD31
   phenotype  Tumour 1,554 · 44.2%   Endothelial 1,047 · 29.8%   Other 465 · 13.2%   …
```

Switching to Probability drops the confidence toggle and its slider; switching to Phenotype
replaces the channel list with the lineage list; picking a marker from **Add** appends it. Both
layers draw on the slide from the Workspace's eye. Nine tabs remain (was eleven).

The marker form on a slide with no nuclei (`TCGA-A2-A04N`) says both halves of it: the picker
reads *No nuclei on this slide yet — run one first*, and the submit line reads *This slide has no
nuclei yet — run it first, then come back*, with Run disabled.

## Two things the runs turned up

- **Neither the tissue nor the biomarker container had torch**, so the first dispatch came back
  `503: tissue segmentation needs the GPU worker (fcn_resnet50_unet-bcss.pth not loaded)` — the
  same class of deployment fact as the preprocess image in 05, and the third time it has cost an
  hour. Both were rebuilt on their `docker-compose.{tissue,biomarker}.yml` overrides (245 MB →
  7.86 GB, 239 MB → torch 2.2.2 + CUDA). The dispatch itself was correct throughout, and the
  worker's exact words reached the Runs list, which is what made the cause obvious rather than
  mysterious.

- **A stopped run read "Stopping…" forever.** `stopping` in the runs store is a *local intent* —
  it covers the gap between the click and the server's CANCELING, which is up to a poll away — and
  it only expired when the row aged off the feed. So a run that had genuinely settled kept the
  label of one that was still holding the GPU, which is the exact lie the intent exists to prevent
  at the other end. Cleared now in `applyJobEvent`, the moment the run is no longer unfinished.
  Pre-existing since 03; only visible once a stop was watched to the end.
