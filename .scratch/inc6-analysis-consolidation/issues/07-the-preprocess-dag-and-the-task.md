# 07 — The preprocess DAG and the downstream task move across

**What to build:** the last four kinds — `segmentation`, `patching`, `features`, `prediction` —
move together, because they are one chain and splitting them would mean maintaining a half-migrated
chain across two job systems.

Segmentation has been driven by Celery since 01 as the substrate's proving kind; this is where its
old path is removed and the other three join it.

**Blocked by:** 06.

**Status:** needs-triage

- [ ] All four kinds submit through the catalog. Preprocess is one entry with its build target
      (encoder binds patch size — Fork B), not three entries.
- [ ] The task entry keeps what Inc 2c earned: the declared `feature_spec`, the honest statement of
      what the classifier was trained on, and its caveat.
- [ ] Chained submission uses Celery chain with Girder parent/child jobs; all rows are written at
      submit time from the hashes computable then (plan D7).
- [ ] Runs shows a chain as a parent with its children, so "3 steps, on step 2" is legible.
- [ ] The MIL evidence heatmap keeps working; it is a prediction artifact's layer and belongs in
      the Workspace row like every other.
- [ ] Segmentation's pre-01 submission path deleted.
- [ ] `PreprocessPanel.jsx`, `TaskPanel.jsx` and their tabs removed.
- [ ] **Verified on DEMO:** from a slide with nothing built, run the full chain to a BRCA IDC/ILC
      call in one submission; the three-step progress is legible throughout and the prediction
      matches what the old path gives for the same feature index.
