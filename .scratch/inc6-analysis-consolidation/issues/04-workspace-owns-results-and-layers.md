# 04 — The Workspace owns the results and the layer controls

**What to build:** an artifact row expands. Inside it are the numbers that artifact stores and the
controls its layer is drawn with — opacity, render mode, per-class visibility and counts, marker
channels. They move out of the five panels and land next to the eye that was already there.

Continues the Inc 5 vendoring: `SegmentationTable.Config` is the slider block, and
`SegmentationTable.Segments` is the per-class row with its own eye and swatch. The header of
`vendor/ohif/PanelSection.tsx` already names this directory as their destination.

**Blocked by:** nothing structurally — but land it after 02 so the emptied panels have somewhere to
have gone.

**Status:** done

- [x] ~~`SegmentationTable`'s `Config` and `Segments` vendored verbatim~~ — **the primitives are,
      the two files are not.** See below. `Slider` and `Tabs` are new verbatim copies from the same
      tag, with the same provenance-header discipline as `accordion.tsx`.
- [x] An expanded nuclei row shows coverage, total, per-class counts and fractions, an opacity
      slider and the class/instance render toggle — everything `NucleiPanel` renders today.
- [x] Per-class visibility is a `Segments` row's eye. Hiding a class from the picture must not hide
      its count from the arithmetic — the rule `NucleiPanel` already states in a comment.
- [x] Layer parameters stay in the store. The Workspace is where they are edited, not where they
      live; the layer still outlives the panel.
- [x] Colours come off the artifact's palette, so a swatch here and the mask on the slide cannot
      disagree.
- [x] A row whose artifact is still building renders from the Runs data, joined on `art_hash`, and
      becomes the real row without flicker when the job finishes (plan §5).
- [x] **Verified on DEMO:** with a nuclei artifact present, expand its row, hide a class, change
      opacity, switch render mode — all reflected on the slide, and all surviving a tab switch.

## Why the two files were not vendored verbatim

Both are `useSegmentationTableContext` consumers, and that is the whole difference from Inc 5's
copies. `DataRow`'s own header says it was vendorable precisely because it "carries no segmentation
domain"; `Config` and `Segments` are the opposite.

- **`SegmentationTableConfig`** is fill/outline tabs, a Border-width slider and a "display inactive
  segmentations" switch. Those describe a Cornerstone labelmap representation. Our layer is a
  raster tile pyramid with an alpha and a choice of two lookups — no outline to widen, no inactive
  sibling to show. Vendoring the file and feeding it a context of look-alike names would have put
  three tab icons and a Border slider in front of a pathologist, none of which do anything.
- **`SegmentationSegments`** reads `representation.segments` out of two contexts. Copying it means
  copying `contexts/`, `SegmentStatistics`, `ScrollArea` and `HoverCard`, and then assembling a
  fake Cornerstone representation per nuclei class — "an adapter pretending to be a segmentation",
  which `DataRow`'s header records as the thing Inc 5 rejected.

So the **primitives** are verbatim (`ui/slider.tsx`, `ui/tabs.tsx`, joining `DataRow` and
`PanelSection`), and `ArtifactConfig` / `ArtifactSegments` are app code that keeps upstream's
layout to the class string — the `bg-muted rounded-b px-1.5 pt-0.5 pb-3` block, the
`Label w-14 · Slider flex-1 · value w-10` control row, the `TabsList` segmented control, the
`space-y-px max-h-80` segment list, a `DataRow` per segment. Each file's header names the upstream
file it is modelled on and enumerates what was kept, dropped and substituted, the same discipline
the verbatim copies use.

`ScrollArea` and `HoverCard` were dropped rather than vendored: the first is a radix wrapper for
`overflow-y-auto`, not worth a dependency for five rows, and the second would hide a count and a
percentage behind a hover when both fit on the row.

## The shape

```
artifactDetail.js      one registry keyed by kind → { stats, segments, config }
                       + which store slice holds that kind's layer parameters
runJoin.js             views ∪ runs, unioned on art_hash
ArtifactConfig.jsx     the mode tabs and the opacity slider
ArtifactSegments.jsx   a DataRow per class
```

Nuclei is the only entry the registry has. Tissue and biomarker are 06 and are meant to arrive as
two more entries — the panel never learns which store slice it is editing, so adding one is a table
row rather than a branch.

`NucleiPanel` was **emptied**, not left as a second copy: its "what is stored" and "the mask"
sections are gone, and seven of its tests went with them — reasserted in
`workspace/artifactDetail.test.js` and `WorkspacePanel.test.jsx` rather than deleted. What is left
is the build controls and a line saying where the rest went. That tab goes in 05.

## What the runs showed (2026-08-01, DEMO slide)

A real nuclei artifact, built through the gateway over a 4096² region:
`22df87650797898e` — 15,180 nuclei, 77 tiles, 20.62 mm², both rasters.

- **The row opens onto its own numbers.** `Covered 77 tiles · 20.62 mm²`, `Total 15,180`,
  `Area 20.62 mm²`, then four class rows: Neoplastic 3,836 · 25.3 %, Inflammatory 168 · 1.1 %,
  Connective 10,955 · 72.2 %, Epithelial 221 · 1.5 %. `Dead` is in the palette and in the class
  list and is not a row, because the region had none of it.
- **Hiding a class reaches the slide and leaves the count alone.** Clicking Connective's eye
  refetched tiles with `show=Dead,Epithelial,Inflammatory,Neoplastic`, and `10,955 · 72.2%` stayed
  on screen with the row dimmed.
- **Opacity is a layer opacity, not a tile parameter.** Six arrow-keys took the store from `0.65` to
  `0.35`, OpenSeadragon's world went `[1, 0.65] → [1, 0.35]` — the base slide and the mask — and
  **not one tile was refetched**, which is what `ArtifactLayers.jsx:186` claims and had never been
  checked in a browser.
- **The render switch is a URL.** `Each cell` produced `/tile/instances/…` requests and the note
  about per-cell colours carrying no meaning of their own.
- **All of it survives a tab switch.** Info → Workspace, reopen the row: `render: instances`,
  `opacity: 0.35`, `hidden: {Connective: true}`, mask still mounted at 0.35.
- **The emptied Nuclei tab still starts builds** — `Ready`, both run buttons, and the pointer to
  the Workspace — with no counts and no opacity slider left on it.

Two corrections the browser forced, neither of them in the code under test:

- **The right panel starts collapsed to an icon rail**, and that rail carries only a subset of the
  tabs — Workspace is not one of them. A test that clicks a tab has to open the panel through a tab
  that is on the rail first.
- **"Hide icon bar" collapses the whole right panel**, not the floating left rail. Ticket 02's
  workaround for the overlapping rail was hiding the panel it was overlapping.

Noted, not fixed: the floating left rail still overlaps the panel's left edge at 1700 px and clips
the first character of the stat labels — the same pre-existing layout issue 02 and 03 recorded. And
`DataRow` puts its details block under the title, so each class is two lines where `NucleiPanel`
had one; that is upstream's layout and the price of the swatch and the eye.
