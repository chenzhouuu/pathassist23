# 09 — The grid view

**What to build:** a second way to look at a level, where the slide image is the primary thing and
the metadata is secondary. A control in the toolbar switches between the table and a grid of cards;
the selection, the filters and the preview pane carry across unchanged.

This is where the decision to contain rather than crop pays off most visibly: a wall of cards makes
the difference between a square block of tissue and a 4.33 : 1 strip immediately legible, which a
wall of square crops does not.

**Blocked by:** 05.

**Status:** ready-for-agent

- [ ] A segmented control in the toolbar switches table and grid. The choice does not reset the
      selection, the search or the status filter.
- [ ] Cards lay out on a responsive grid and hold a 4:3 image frame with the thumbnail contained
      and centred on the sunken surface, then the name over two lines, the status chip and the scan
      parameters.
- [ ] Clicking the name or the image opens; clicking elsewhere on the card only selects. Same rule
      as the table, so the two views do not teach different habits.
- [ ] A slide with no thumbnail, a non-slide item and a folder each get a distinguishable
      placeholder rather than all sharing one.
- [ ] Long names wrap and clamp rather than overflowing. Real filenames here reach 89 characters.
- [ ] Verified in both themes against TCGA-BRCA, which is where the aspect-ratio spread is widest.
