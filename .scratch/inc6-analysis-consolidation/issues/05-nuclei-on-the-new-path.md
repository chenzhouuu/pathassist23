# 05 — Nuclei runs on the new path, and the artifact table sheds its job columns

**What to build:** the first real kind moves. Nuclei is submitted from the Analysis catalog, driven
by Celery, monitored in Runs, and read in the Workspace. The `Nuclei` tab goes.

This is where the source-of-truth split actually happens (plan D9): `status`, `stage`, `progress`
and `error` leave `preprocess_artifact`, `_reconcile_artifact` and its call site are deleted, and a
row becomes a claim that bytes exist on disk.

Nuclei is the closing ticket of Inc 6a because it is the kind that exercises everything at once —
hours-scale progress, cooperative stop, resume from partial coverage.

**Blocked by:** 01, 03, 04.

**Status:** needs-triage

- [ ] Nuclei submits through the catalog: a drawn region or the whole slide, with the whole-slide
      path still requiring a ready segmentation and saying why when there isn't one.
- [ ] `status` / `stage` / `progress` / `error` dropped from the table and from every reader.
      `girder_job_id` added.
- [ ] `_reconcile_artifact`, its one call site and the four worker status clients it drives are
      deleted, not left unused.
- [ ] The driver writes a row on `ready` **and** on `cancelled` — a stopped run left usable bytes
      and a resumable state. Nothing is written on failure; the failure is the Girder job.
- [ ] Migration for existing rows: bytes on disk ⇒ keep, no bytes ⇒ delete. Report the counts. The
      rows currently stuck `running` from worker restarts are resolved by this and by nothing else.
- [ ] `NucleiPanel.jsx`, `nucleiUtils.js` and the `nuclei` tab removed; the tests that cover the
      pure helpers move with the logic rather than being deleted.
- [ ] **Verified on DEMO:** run whole-slide nuclei. Queue position visible while a second job
      waits; progress shows tile counts; Stop settles as `cancelled` with coverage recorded; a
      re-run resumes and the final count matches an uninterrupted run; a page reload mid-run loses
      nothing.
