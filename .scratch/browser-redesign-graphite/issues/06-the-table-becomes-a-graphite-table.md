# 06 — The table becomes a Graphite table

**What to build:** the row a pathologist actually reads. A 56px row with a thumbnail that has room
to breathe and shows the slide's true macro shape, a header that is not shouting, a status that
reads as a chip rather than a dot, and a column carrying the scanner parameters that make this a
pathology tool rather than a file manager.

Today's row is 44px with a 40px thumbnail inside it — two pixels of air, which is the actual source
of the crowding. The thumbnail is cropped square, which destroys the macro shape. The header is
11px uppercase at `.04em`, which is the single fastest way to date a table.

**Blocked by:** 05.

**Status:** ready-for-agent

- [ ] Rows are 56px, body text 14px on a 20px line height with slightly negative tracking. The
      header is sentence case at body size, differentiated by weight and colour only — no
      uppercase, no wide tracking.
- [ ] The thumbnail is 40×40 on the sunken surface and **contains** rather than covers. Real slides
      in this instance run from 0.62 : 1 to 4.33 : 1; a long tissue strip must read as a long
      tissue strip, not as a square crop of its middle.
- [ ] Dividers are drawn as an inset shadow on the cell, not a border on the row — so they add no
      layout height, survive the sticky header, and switch off for the last row by flipping one
      variable.
- [ ] Status is a soft-tint chip: the semantic hue at roughly 12% over the current surface, the
      full-strength hue as the text, no border. Never a saturated solid fill — that flattens the
      row hierarchy.
- [ ] A `Scan` column shows real magnification and µm/px read from the tiles metadata. Its empty
      states distinguish three different things: a folder shows nothing, a slide whose source did
      not record magnification shows *not recorded*, and a non-slide item shows *not a slide*. The
      14 MDA `.tiff` files are slides with thumbnails and no magnification — labelling them "not a
      slide" would be false on every row.
- [ ] Numeric and identifier columns are mono with `tabular-nums`.
- [ ] Clicking the name or its thumbnail opens; clicking anywhere else in the row only selects.
      This already works — the name is a button — and the hover affordance now sits on that button
      rather than on the whole row, which was promising a click target the row does not have.
- [ ] Folders lead the sort in both directions, and the existing `browseUtils` cases still pass
      untouched.
- [ ] Verified against a folder of BRACS slides and against TCGA-BRCA, which carries the 4.33 : 1
      strips, in both themes.
