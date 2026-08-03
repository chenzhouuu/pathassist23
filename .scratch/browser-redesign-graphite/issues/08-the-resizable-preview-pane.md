# 08 — The preview pane becomes resizable, and shows what a slide is

**What to build:** the right-hand pane can be dragged to a width that suits the screen, collapsed
entirely, and remembers both choices. Its contents become the facts that distinguish one slide from
another — magnification, resolution, pixel dimensions, aspect, pyramid depth — rather than the
fields that happen to be in the row already.

The pane is 260px and fixed today. On a 1280px laptop, with the tree taking 240px, a fixed pane is
the difference between a usable table and a cramped one, and the user is better placed than the
design to make that call.

**Blocked by:** 03 (navigation state), 07 — 07 restructures the same layout row, so running them
concurrently would collide. That edge is layout churn, not logic.

**Status:** ready-for-agent

- [ ] The pane defaults to 320px, is dragged by its leading edge, and is clamped between 15% and
      50% of the page width so it can be neither vanished nor made dominant by accident.
- [ ] A toolbar control collapses and restores it. Width and open state both persist across a
      reload.
- [ ] The large thumbnail contains within a frame wider than it is tall — the median real aspect
      here is 1.66, so a square frame spends most of its height on nothing. The 0.62 : 1 portraits
      and the 4.33 : 1 strips both still fit.
- [ ] The field set reads magnification, µm/px, pixel dimensions, aspect ratio and pyramid level
      count from the tiles metadata, alongside file size and last update. A field with no value is
      absent, not blank.
- [ ] A folder selection shows its item count and its own actions, as now.
- [ ] The existing actions — open, change status, share a folder — keep working.
- [ ] Verified in both themes at 1440px and 1280px, and with the pane collapsed.

## Notes

The clamp and the persistence are OHIF's own recipe for the same pane in its StudyList (MIT), which
this project already vendors from. `RightPanel` in the Viewer hand-rolls a similar drag; it is out
of scope here and stays as it is.
