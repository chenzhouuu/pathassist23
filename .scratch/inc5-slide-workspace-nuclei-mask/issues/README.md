# Inc 5 — Slide Workspace + Nuclei as Mask · tickets

Source: `docs/Chen/plans/2026-07-31-pathagent-v2-inc5-slide-workspace-nuclei-mask-plan.md`.

Constraint applied on top of the plan: **every ticket must be verifiable in the browser UI.** The
plan's Phases 1–3 are backend-only and Phase 4 ends on a fixture, so the work is re-sliced — the
Workspace surface is taken first, and each backend increment afterwards shows up on it.

```
01 toolchain + tab shell
     └── 02 lists real artifacts
           ├── 03 the eye owns visibility ──┐
           └── 04 delete ──────────┐        │
                                   └── 05 nuclei artifact (region, counts)
                                         ├── 06 the mask ──┬── 07 whole-slide: coverage/stop/resume
                                         │                 └── 08 instance-id raster
                                         └── 09 biomarker consumes nuclei
```

Decided while breaking this down, and not in the plan:

- **Nuclei is triggered from a new Nuclei panel**, shaped like the Tissue panel. The plan gives
  nuclei an eye (§5.2) but never says where a build is started; today it is only reachable through
  the agent. Every nuclei ticket needs that surface to be verifiable.
- **05 is blocked by 04** for a practical reason, not a technical one: 05–08 accumulate large trial
  artifacts and there must be a way to delete them from the UI. Drop the edge to run them in
  parallel.
- Plan Phase 0 (dashboard WIP) is already done — commit `5d218a4`.
- The uncommitted tissue/biomarker delete endpoints in the working tree belong to ticket 04.
