# 02 — Analysis becomes one algorithm catalog

**What to build:** the HistomicsTK docker CLIs and the five native tools appear in one searchable
list. Clicking either opens a parameter form; submitting returns to the list. `AnalysisPanel`'s
existing `list → form → running` state machine is the frame; native tools declare their form as
data where a CLI declares it as Slicer XML.

Native entries render but do not yet submit on the new path — 05 through 07 move them one at a
time. Until a kind moves, its entry hands off to the existing endpoint, and its old tab stays.

**Blocked by:** nothing (the Runs section is 03).

**Status:** done

- [x] One list, two groups: `NATIVE` and each docker image, with the existing search box and image
      filter covering both.
- [x] A native tool's form is generated from a declaration next to the tool, not from XML and not
      by hand-writing a second form renderer.
- [x] The three shapes the native forms need that CLIs do not have: a drawn region (reuse
      `useRegionSelect`), a whole-slide toggle, and an upstream-artifact picker.
- [x] `running` view is dropped — a submission returns to the list and appears in Runs (03).
      A submitted job is not a modal state.
- [x] ~~The CLI path is byte-for-byte the behaviour it has today~~ — **not preserved, deliberately.
      See below.** The ROI draw and the hidden auto-filled params are unchanged in shape.
- [x] **Verified on DEMO:** open Analysis, filter to find both a CLI and a native tool, submit one
      of each, and land back on the list both times.

## The shape

`parseXml.js` turns Slicer XML into `{title, description, groups:[{label, params}]}`.
`nativeCatalog.js` declares **the same shape** as data for the five native tools. One renderer
(`ParamField.jsx`) serves both, so native params speak the Slicer vocabulary (`boolean`, `float`,
`string-enumeration`) plus three prefixed tags Slicer has no word for: `pa-scope`, `pa-region`,
`pa-artifact`.

Five entries, one per current panel. `patching` and `features` are **not** listed: they are
interior DAG stages whose patch size is bound to the encoder the features step will use, and that
binding lives in `PreprocessPanel`'s planner. Listing them standalone would let a user build tiles
no encoder wants. They arrive with the planner in 07.

Native entries still submit to their existing endpoints, as the ticket specifies. Only where a tool
is *found* has changed.

## Why "byte-for-byte" was dropped

Today's CLI behaviour, measured on the DEMO slide, is that **it does not work at all**. Two
pre-existing defects, both found by running the acceptance criterion:

1. `400 Invalid file id (6a6e1ca8…)` — an `<image>` **input** takes a FILE id. The panel sent the
   item id. `slicer_cli_web`'s own selector does
   `new FileModel({_id: image.fileId || image.originalId})` (`ItemSelectorWidget.js:249`), i.e.
   `largeImage.fileId` — which for the DEMO slide, a `copyOfItem`, is not even in that item's own
   file list.
2. `KeyError: 'outputAnnotationFile_folder'` (`prepare_task.py:219`) — an output file needs
   **two** fields: `<name>` = the filename, `<name>_folder` = the destination.
   `WidgetCollection.js:25-28` sets both. The panel sent the folder id *as the filename* and no
   companion.

Both were fixed by copying the rules out of the installed `slicer_cli_web`
(`parser/param.js:31-35`, `collections/WidgetCollection.js:17-41`, `views/ItemSelectorWidget.js`),
now in `analysis/cliParams.js` with the source lines cited per rule. `git show HEAD` confirms the
old mapping was identical to the one that failed, so this is a fix and not a regression.

## What the runs showed (2026-08-01, DEMO slide)

- **19 algorithms** in one list: 5 native under `PathAssist`, 14 CLIs under two docker images.
  Searching `nuclei` returns 6 — `Nuclei segmentation` (native) beside `NucleiDetection`,
  `NucleiClassification`, `CellposeNuclei`, `cellpose_nuclei`. The source filter reaches the native
  group too.
- **Native submit:** Tissue segmentation → `POST /slides/{item}/segment` → back on the list with a
  "submitted" banner. The run appears in Girder as a `pathassist` job (ticket 01's substrate).
- **CLI submit:** Compute Background Intensity → `POST /slicer_cli_web/cli/{id}/run` → a RUNNING
  Girder job, and back on the list. This is the first time a CLI has run from this panel.
- **The guard reads as a sentence:** switching Nuclei to whole-slide with no segmentation on the
  slide disables Run Job and says "Tissue segmentation is required", instead of letting the user
  find out from a 409.

Noted, not fixed: the floating viewer side-rail overlaps the panel's top-left corner at 1700px
wide, covering the form's back button. Pre-existing, and a layout ticket rather than this one.
