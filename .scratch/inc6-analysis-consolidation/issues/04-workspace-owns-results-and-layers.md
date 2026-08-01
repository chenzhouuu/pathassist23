# 04 — The Workspace owns the results and the layer controls

**What to build:** an artifact row expands. Inside it are the numbers that artifact stores and the
controls its layer is drawn with — opacity, render mode, per-class visibility and counts, marker
channels. They move out of the five panels and land next to the eye that was already there.

Continues the Inc 5 vendoring: `SegmentationTable.Config` is the slider block, and
`SegmentationTable.Segments` is the per-class row with its own eye and swatch. The header of
`vendor/ohif/PanelSection.tsx` already names this directory as their destination.

**Blocked by:** nothing structurally — but land it after 02 so the emptied panels have somewhere to
have gone.

**Status:** needs-triage

- [ ] `SegmentationTable`'s `Config` and `Segments` vendored verbatim under
      `src/components/workspace/vendor/ohif/`, with the same provenance header discipline: what was
      copied, from which tag, and every edit enumerated.
- [ ] An expanded nuclei row shows coverage, total, per-class counts and fractions, an opacity
      slider and the class/instance render toggle — everything `NucleiPanel` renders today.
- [ ] Per-class visibility is a `Segments` row's eye. Hiding a class from the picture must not hide
      its count from the arithmetic — the rule `NucleiPanel` already states in a comment.
- [ ] Layer parameters stay in the store. The Workspace is where they are edited, not where they
      live; the layer still outlives the panel.
- [ ] Colours come off the artifact's palette, so a swatch here and the mask on the slide cannot
      disagree.
- [ ] A row whose artifact is still building renders from the Runs data, joined on `art_hash`, and
      becomes the real row without flicker when the job finishes (plan §5).
- [ ] **Verified on DEMO:** with a nuclei artifact present, expand its row, hide a class, change
      opacity, switch render mode — all reflected on the slide, and all surviving a tab switch.
