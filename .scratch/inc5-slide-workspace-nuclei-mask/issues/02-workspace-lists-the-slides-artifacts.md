# 02 — The Workspace lists the slide's real artifacts

**What to build:** Open a slide, open the Workspace, and see every artifact that slide has — one row
each, each row saying in one line what it is and what it cost. The data is the slide-artifact list
the gateway already serves; no new server fields are introduced. The full OHIF segmentation-table
component set is vendored here and bound to those rows.

The plan's Phase 4 ended on a fixture. It ends on live data instead, so the vendoring is verifiable
as a thing a user can look at rather than as a storybook.

**Blocked by:** 01 — Workspace tab shell and the TypeScript toolchain.

**Status:** ready-for-agent

- [ ] Every artifact kind that exists today gets a row, with the four segments from plan §5.2:
      kind · params · scale · state + age.
- [ ] Row content is derived from the `params` and `result` payloads already stored — no new columns,
      no new service call per row.
- [ ] Kinds that cannot be drawn (`features`, `prediction`) still get a row and a summary line, and
      carry no eye (decision D2).
- [ ] A `queued` / `running` artifact shows that state and reaches `ready` without a manual refresh:
      start a segmentation with the Workspace open and watch the row change.
- [ ] A slide with no artifacts shows an empty state, not an empty table.
- [ ] The vendored components keep OHIF's collapsed/expanded structure, hover and keyboard behaviour;
      only the data binding is new (plan §5.1 — this boundary is the reason the provenance headers
      exist).
