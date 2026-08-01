# 02 — Analysis becomes one algorithm catalog

**What to build:** the HistomicsTK docker CLIs and the five native tools appear in one searchable
list. Clicking either opens a parameter form; submitting returns to the list. `AnalysisPanel`'s
existing `list → form → running` state machine is the frame; native tools declare their form as
data where a CLI declares it as Slicer XML.

Native entries render but do not yet submit on the new path — 05 through 07 move them one at a
time. Until a kind moves, its entry hands off to the existing endpoint, and its old tab stays.

**Blocked by:** nothing (the Runs section is 03).

**Status:** needs-triage

- [ ] One list, two groups: `NATIVE` and each docker image, with the existing search box and image
      filter covering both.
- [ ] A native tool's form is generated from a declaration next to the tool, not from XML and not
      by hand-writing a second form renderer.
- [ ] The three shapes the native forms need that CLIs do not have: a drawn region (reuse
      `useRegionSelect`), a whole-slide toggle, and an upstream-artifact picker.
- [ ] `running` view is dropped — a submission returns to the list and appears in Runs (03).
      A submitted job is not a modal state.
- [ ] The CLI path is byte-for-byte the behaviour it has today, including the ROI draw and the
      auto-filled image/folder params.
- [ ] **Verified on DEMO:** open Analysis, filter to find both a CLI and a native tool, submit one
      of each, and land back on the list both times.
