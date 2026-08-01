# 02 — The Workspace lists the slide's real artifacts

**What to build:** Open a slide, open the Workspace, and see every artifact that slide has — one row
each, each row saying in one line what it is and what it cost. The data is the slide-artifact list
the gateway already serves; no new server fields are introduced. The full OHIF segmentation-table
component set is vendored here and bound to those rows.

The plan's Phase 4 ended on a fixture. It ends on live data instead, so the vendoring is verifiable
as a thing a user can look at rather than as a storybook.

**Blocked by:** 01 — Workspace tab shell and the TypeScript toolchain.

**Status:** done

- [x] Every artifact kind that exists today gets a row, with the four segments from plan §5.2:
      kind · params · scale · state + age.
- [x] Row content is derived from the `params` and `result` payloads already stored — no new columns,
      no new service call per row.
- [x] Kinds that cannot be drawn (`features`, `prediction`) still get a row and a summary line, and
      carry no eye (decision D2).
- [x] A `queued` / `running` artifact shows that state and reaches `ready` without a manual refresh:
      start a segmentation with the Workspace open and watch the row change.
- [x] A slide with no artifacts shows an empty state, not an empty table.
- [x] The vendored components keep OHIF's collapsed/expanded structure, hover and keyboard behaviour;
      only the data binding is new (plan §5.1 — this boundary is the reason the provenance headers
      exist).

## Comments

**Vendored `DataRow`, not `SegmentationTable`** — Chen's call after the survey. `SegmentationTable`
is a domain component: its context carries ~30 OHIF callbacks over a `{segmentation, representation}`
model, so using it would have meant an adapter dressing artifact rows as segmentations. The
component that actually draws a row is `DataRow`, which `SegmentationSegments` loops over, and it
carries no segmentation concept at all. That is what was copied. Lost: OHIF's collapsed mode, which
is a dropdown for picking one segmentation — the Workspace lists everything, so it was never wanted.

Icons are a **stand-in, not a copy**: eight lucide glyphs behind OHIF's names, so `DataRow`'s JSX is
unedited. The seam is one file wide if visual parity is ever needed.

"No eye on a `features` row" is implemented by not passing `onToggleVisibility`, not by branching on
kind inside the row. Ticket 03 wires the eye by passing that callback for the drawable kinds only.

**Two things §5.2 asks for that the data does not have.** Segmentation's `mpp` is not in `params`
(only the segmenter and the conf/removal switches), and biomarker's `panel` and phenotype mix are
not in `result` (only `art_hash`, `n_tiles`, `n_new_tiles`, `n_cells`, `seconds`). Both would need
the gateway to store more at reconcile time, which this ticket's own criteria rule out. The rows
render what exists; closing the gap is a separate ticket.

Verified: 236 tests green (31 new), typecheck and build clean, the two new theme aliases present in
the built CSS resolving to the palette, and the list clicked through in the running app by Chen.
