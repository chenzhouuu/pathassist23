# Docker CLI Surface — Technical Report

**Status:** removed 2026-08-03. This document is what remains.
**Scope:** the Slicer CLI / `slicer_cli_web` integration — the HistomicsTK docker CLIs in the
Analysis catalog, the right-click **Annotate Nuclei** modal, and the server-side support that let
those runs appear in the Runs list.
**Companions:** `docs/ai-panel-technical-report.md`, `docs/askpa-technical-report.md`.

---

## 1. What it was

Girder's `slicer_cli_web` plugin registers a docker image's CLIs as Girder items, each carrying a
Slicer XML descriptor. The frontend read that registry, turned each XML into a form, and posted the
filled form back to `POST /slicer_cli_web/<image>/<cli>/run`, which ran the container on the DSA
worker and uploaded its output to Girder.

```
GET /slicer_cli_web/docker_image            api/index.js   getDockerImages()
        │  { image: { tag: { cliName: { xmlspec, run } } } }   — four shapes, all handled
        ▼
AnalysisPanel.cliList                        60 lines of flattening
        │
        ▼  click an entry
GET <xmlspec>                                getCliXmlByPath()
        │  Slicer XML
        ▼
parseXml.js  →  { title, description, groups: [{ label, params }] }
        │       — deliberately the same shape a native tool declares, so ParamField renders both
        ▼
ParamField renders; cliParams.js maps values → wire params
        │       image input → largeImage.fileId · output → name + <name>_folder
        ▼
POST <run>                                   runCliByPath()
        │
        ▼
girder_worker → docker run → annotation or image file uploaded to the slide's folder
```

A second, independent caller existed: **`NucleiDetectionModal.jsx`** (441 lines), reached by
right-clicking an annotation → *Annotate Nuclei*. It probed for
`['NucleiDetection', 'NucleiClassification', 'ComputeNucleiFeatures']`, parsed the XML with its own
smaller parser, and posted a run scoped to the annotation's bounding box.

### The catalog as registered

Girder's task folder held **14 CLIs across 3 images**:

| Image | CLIs | Provenance |
|---|---|---|
| `dsarchive/histomicstk:latest` | 12 | 9 upstream + 3 that were **not in the image** |
| `pathassist/medgemma-report:latest` | 1 | ours |
| `pathassist/path-analysis:latest` | 1 | ours |

The nine genuine HistomicsTK CLIs, by what they produce:

**Measure a parameter** (result is a number or vector in `annotation.attributes`, no geometry)
`BackgroundIntensity` · `SeparateStainsMacenkoPCA` · `SeparateStainsXuSnmf`

**Produce annotations**
`NucleiDetection` · `ComputeNucleiFeatures` · `NucleiClassification` · `SuperpixelSegmentation` ·
`PositivePixelCount`

**Produce images**
`ColorDeconvolution` (three unmixed stain images)

Upstream's intended workflow chains these: measure this slide's stain vectors, feed them into
detection or deconvolution, then compute features and classify.

---

## 2. What actually ran

Measured from this deployment's `job` collection at removal — 200 jobs total, 50 typed `image#cli`.

| CLI | Success | Error | Notes |
|---|---|---|---|
| `Compute Background Intensity` | 4 | 0 | the only upstream CLI ever exercised |
| `Cellpose Nuclei Detection` | 4 | 17 | not in the image at removal |
| `ViT Cell Phenotype Clustering` | 6 | 2 | not in the image at removal |
| `PathAnalysis` | 11 | 2 | ours; last run 2026-07-20 |
| `MedGemma Pathology Report` | 2 | 2 | ours; last run 2026-07-20 |
| **the other 9 registered CLIs** | — | — | **never run** |

So of 14 catalogued entries, five were ever invoked and one of those was an upstream HistomicsTK
CLI. `PathAnalysis` — CellPose + ViT phenotyping + a MedGemma report over ROI patches — was the
only one with sustained use, and its three jobs are each covered by a native service now
(`services/cellvit`, `services/biomarker`, `services/pathvlm`).

---

## 3. Defects found at removal

**D1 · Three catalogued CLIs did not exist in their image.**
`CellposeNuclei`, `cellpose_nuclei` and `vit_phenotype` were registered under
`dsarchive/histomicstk` but absent from `slicer_cli_list.json` and from
`/HistomicsTK/histomicstk/cli/`; running `<cli> --xml` in the image failed for all three. They were
visible and submittable in the catalog and could only fail. The most likely history — inferred, not
proven — is that a locally-built image carrying Cellpose and ViT was replaced by a `docker pull` of
the official one while the Girder registration stayed behind. The job record supports it: those two
CLIs succeeded through April, then failed from 2026-07-20 with a docker API error.

**D2 · `CellposeNuclei` and `cellpose_nuclei` were the same CLI registered twice** — identical
title, description, version and parameters.

**D3 · A measured result was unreadable in the app.**
`BackgroundIntensity` succeeded four times and wrote an annotation with **zero elements**, its
answer in `attributes.intensity_values` (`[241, 242, 241]` on the DEMO slide). `LayersPanel`,
`AnnotationsPanel` and `MetadataPanel` all render `elements` and none reads `attributes`, so the run
produced an empty layer row and a number reachable only through the Girder API. This broke the
intended chain at step one: the whole purpose of the three measurement CLIs is to supply stain
vectors to the detection CLIs, and their output could not be read to supply them.

**D4 · The frontend sent the user's Girder session token as a CLI parameter.**
`AnalysisPanel.jsx` set `params['girderToken'] = localStorage.getItem('girderToken')` on every
docker run, and the value persisted in the job document. Mitigating: it did not appear in the job
log, and jobs were not public. Not mitigating: tokens on this deployment expire ~11 months out, any
site admin can read any job, and `slicer_cli_web`'s worker already injects `--girder-token` itself,
so the frontend copy was redundant as well as exposed. The three phantom CLIs went further and
declared `girderApiKey` / `girderToken` as ordinary `string` params — which would have rendered them
as plain text inputs in the form.

**D5 · Defaults invited an unbounded run.**
Five CLIs defaulted `analysis_roi` / `region` / `roi` to `-1,-1,-1,-1`, meaning the whole slide.
`NucleiDetection` then scans at 20× on a 1024 tile grid. The DSA worker has the docker socket but no
GPU device requests, so every such run is CPU-only.

---

## 4. Why removed rather than repaired

The catalogue was mostly untried, partly broken, and structurally different from where the rest of
the app had gone. Every native tool submits through a gateway service, runs as a Girder job on the
`pathassist` queue, and lands as an **artifact** the Workspace lists and a second reader can open. A
docker CLI ran on a different queue and landed as a Girder **annotation or file** — which is why D3
could happen at all: there was no artifact to carry a number that was not a shape.

Keeping it would have meant fixing D1–D5 and then maintaining a second execution model, a second
credential path, and a second result location, for a set of tools of which one upstream CLI had ever
been run successfully.

The cost is real and worth stating: `PathAnalysis` (11 successful runs) and the MedGemma report went
with the mechanism they rode on.

---

## 5. What was removed

**L1 · Repo code** — one commit.

| Deleted | Lines |
|---|---|
| `src/components/annotations/NucleiDetectionModal.jsx` | 441 |
| `src/components/panels/analysis/cliParams.test.js` | 95 |
| `src/components/panels/analysis/cliParams.js` | 87 |
| `src/components/panels/analysis/parseXml.js` | 58 |

| Edited | Change |
|---|---|
| `AnalysisPanel.jsx` | the docker half — 640 → 474 lines; `isNative` is gone because everything is |
| `AnalysisPanel.test.jsx` | the mixed-list and CLI-path assertions |
| `api/index.js` | five `/slicer_cli_web` bindings |
| `config/girder.js` | the `dockerImages` URL builder |
| `analysis/ParamField.jsx` | the `region` / `float-vector` field and its Draw button |
| `annotations/ContextMenu.jsx` | the *Annotate Nuclei* entry |
| `annotations/AnnotationCanvas.jsx` | the modal's state and mount |
| `girder_pathassist/runs.py` | the `#` clause in `job_types_query`, `CLI_LANE`, `cli_item_id()` |
| `girder_pathassist/rest.py` | the `loadFile` resolver `cli_item_id` needed |

**L2 · Girder registration** — `DELETE /slicer_cli_web/docker_image` for the three images, removing
the task folder's 14 CLI items. Not something a commit can do.

**L3 · Images on the box** — `dsarchive/histomicstk` (2.69 GB), `pathassist/medgemma-report`,
`pathassist/path-analysis`.

**L4 · History** — the 50 `image#cli` job records and the annotations those runs wrote. Attribution
was resolved per job rather than by annotation name, because names like *Cellpose ROI nuclei* do not
by themselves distinguish a docker CLI's output from the native CellViT service's.

**Kept.** `slide_key()` still groups runs across item copies — that was never CLI-specific.
`nativeCatalog` still speaks the Slicer parameter vocabulary, because `ParamField` renders it and a
second vocabulary would buy nothing; the shape outlived the second producer that motivated it.

---

## 6. If a container-run tool is wanted again

Do not re-adopt `slicer_cli_web`. Add a service under `services/`, the way the five native tools
work: it holds its own credential, it is submitted from the Analysis catalog, it runs as a Girder
job on the `pathassist` queue, and it writes an artifact.

Two things from this integration are worth carrying over:

- **`cliParams.js`'s input contract.** A Slicer image input wants `largeImage.fileId`, not the item
  id, and an output wants both `<name>` and `<name>_folder`. Sending the item id is what made every
  image-input CLI answer 400, and it cost real time to find.
- **The declaration-as-data shape.** One catalog with one form renderer over
  `{title, description, groups}` was the right idea, and it survives — it is simply down to one
  producer now.

And one thing to design for from the start: a result that is a **number** needs somewhere to live.
D3 is what happens when the only output channel is a shape.

---

*Removed on branch `feature/copilot-agent`. The code is one `git show` away; this document exists so
that reaching for it is a decision rather than an excavation.*
