# Inc 6 — Analysis Consolidation + Celery Job Substrate · tickets

Source: `docs/Chen/plans/2026-08-01-pathagent-v2-inc6-analysis-consolidation-design.md`.

Constraint carried over from Inc 5: **every ticket must be verifiable in the browser UI**, and
every verification runs on the DEMO slide (plan §7) — item `6a6e1ca82ae96ce927e33818` in
`BRCA-DEMO / DEMO`.

```
01 celery driver + girder plugin (substrate)
     └── 02 Analysis becomes a catalog ── 03 the Runs section
           │                                    │
           └── 04 Workspace owns results + layers
                       │
                       └── 05 nuclei runs on the new path   ← Inc 6a ends here
                             ├── 06 tissue + biomarker                    (6b)
                             │      └── 07 the preprocess DAG + the task  (6c)
                             │            └── 08 one planner              (6c)
                             └── 09 removal, one jobs.py, deployment tidy (6d)
```

02 and 04 both depend on 01 only for the Runs data shape; they can start in parallel with it as
long as the shape from plan §5 is agreed first.

Decided while breaking this down, and not in the plan:

- **01 ships with `segmentation`, not `nuclei`, as its first driven kind.** The substrate needs a
  kind to prove itself on, and a segmentation on the DEMO slide is ~2 minutes against nuclei's tens
  of minutes. Nuclei is still what *closes* Inc 6a (05) because it is the one that exercises stop,
  resume and hours-scale progress — but debugging the plugin against a 2-minute job first is the
  difference between a morning and a week. The old path stays wired for segmentation until 07.
- **The artifact-table migration (plan R5) lives in 05**, not in 01. Until a real kind has run end
  to end there is nothing to migrate *to*, and the decision rule ("bytes on disk ⇒ keep the row")
  needs a driver that actually writes rows that way.
- **03 is separate from 02** because the Runs list is the one piece that reads Girder rather than
  the gateway, and it is the piece that answers the original ask. Merging it into the catalog
  ticket would let it be delivered as a footnote.
