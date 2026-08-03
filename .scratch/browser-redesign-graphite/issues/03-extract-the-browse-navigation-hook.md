# 03 — Extract the browse navigation into a hook

**What to build:** the landing page's navigation, filtering and selection state moves behind one
hook, so that the three tickets which add a tree, a resizable pane and a grid have somewhere to
attach that is not an ever-growing component.

`BrowserPage` is 328 lines with 24 hook calls today. Tickets 07, 08 and 09 each add state to it —
which node is expanded, how wide the preview is, which view is showing. Doing that first and
splitting afterwards means writing the wiring twice.

Nothing changes for the user. This is the "make the change easy" half.

**Blocked by:** None — can start immediately. Runs in parallel with 01 and 04; the three touch
disjoint files.

**Status:** ready-for-agent

- [ ] One hook owns the `(collection, path)` navigation pair, the search and status filters, the
      single selection and the multi-select set, and exposes the operations the page performs on
      them — descend, ascend, jump to a breadcrumb, select, toggle, clear.
- [ ] Behaviour is unchanged and demonstrably so: single click selects, a click on the name opens,
      double click opens, Backspace ascends, and Backspace is suppressed both while a dialog is
      open and while a text field has focus.
- [ ] Moving to another level still clears the filters, the selection and the optimistic status
      overrides — a status filter carried in from the previous folder would silently hide the new
      one's contents.
- [ ] The 37 existing `browseUtils` cases pass **without edits**. A test that needs changing means
      the row model moved, which this ticket does not do.
- [ ] The hook has its own tests, in the shape of the existing `useRegionSelect` tests.
- [ ] `BrowserPage` is under 300 lines afterwards.
