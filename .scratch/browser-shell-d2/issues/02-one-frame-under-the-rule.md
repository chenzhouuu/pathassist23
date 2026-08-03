# 02 — One frame under the rule

**What to build:** the D2 shell. A full-width logo band with a rule under it; below the rule, a
single 12px-radius frame, inset 8px, holding the rail, the table and the preview. The rail is
separated from the table by a hairline rather than by a gutter — that is what makes it one frame
instead of three touching ones.

Design: `docs/Chen/plans/2026-08-03-browser-shell-d2-design.md` §4.

**Blocked by:** 01

**Status:** done

**Files:** `src/styles/browser/_shell.css`, `_preview.css`, `src/components/browser/BrowserPage.jsx`.
Shares `_shell.css` with 03 — that edge is file-level, not logical; see the README.

## The structure

- [ ] The body becomes **one flat CSS grid of five items plus a backing plate**. Nothing nests.
      §4 gives the grid verbatim.
- [ ] The frame is the **plate** — an empty element behind transparent regions — and not a wrapper
      around them. This is not a style preference: a rounded wrapper with `overflow: hidden` becomes
      a scroll container and `position: sticky` then sticks to a box that never scrolls, so the
      table header silently slides away. §2.3 has the six-variant browser test and the two upstream
      issues (`shadcn-ui/ui#3965`, `radix-ui/themes#767`) that are open for exactly this.
- [ ] **Radius and scrolling go on the same element**, everywhere. The rail takes
      `border-radius: 12px 0 0 12px` and keeps its own `overflow-y: auto`; the preview takes
      `0 12px 12px 0` and keeps its own. Neither gets a clipping ancestor.
- [ ] The frame's edge is `1px solid var(--line-2)`, halving to `.5px` under
      `@media (min-resolution: 192dpi)`. **No shadow.** Linear, Dub and Attio all omit it; on a
      canvas with a real lightness step the hairline plus the inset already carry the edge.
- [ ] The rail's seam is `inset -1px 0 var(--line)` and the rail is otherwise transparent — its
      background must not paint, or it will square off the frame's two left corners.
- [ ] The resizer becomes a 9px grab column painting a 1px line down its middle, widening to 2px in
      brand on hover and for the whole drag. It is no longer the gutter, because inside one frame
      there is no gutter.
- [ ] Below 1024px the frame goes full-bleed by pushing its border and radius off-screen with a
      negative margin — Linear's own `@media screen and (max-width:1023px){ margin:-1px }` — rather
      than a second layout.
- [ ] Every `border: 1px solid hsl(var(--border))` in `_shell.css` is gone. §6 counts 22 places
      drawing that flat opaque line across the surface; this ticket owns the ones here.

## Acceptance

- [ ] Scroll a 500-row folder: the table header stays put. **This is the one that will break** — check
      it before anything else and check it again after any structural edit.
- [ ] The frame's four corners are round and nothing bleeds past them: hover the first and last rows,
      scroll the rail to its ends, select the bottom row.
- [ ] Drag the preview: the pane resizes, the line goes brand for the whole drag, and the frame's
      right edge does not move.
- [ ] At 1440, 1280 and 1024 the frame is inset; at 1023 it is full-bleed with no visible radius.
- [ ] Both themes.

`npm run build` and `npm run typecheck` clean. `usePreviewResize`'s 398-line test file is expected to
stay green untouched — the hook's arithmetic does not change, only what the strip looks like.

## Comments

**2026-08-03 — done.** Seven files. Verified against 500 real rows in TCGA-BRCA/slides, both themes,
at 1440 / 1280 / 1100 / 1024 / 1023 / 900 / 800.

### The one that will break did not

`headerTop` before and after scrolling the wrap 600px, at every width above: **102 → 102** (93 → 93
below the full-bleed breakpoint, where the band is 1px higher). The plate is a backing element, the
four regions over it are transparent, and no ancestor of the header acquired a radius.

### The frame, measured at 1440

| | x | w | radius |
|---|---|---|---|
| plate | 8 | 1424 | `12px`, border `1px`, bg `rgb(249,249,250)` |
| rail | 8 | 236 | `12px 0 0 12px` |
| main | 244 | 859 | — |
| resizer | 1103 | 9 | — |
| preview | 1112 | 320 | `0 12px 12px 0` |

All five share `y: 60, h: 832`, so the regions land exactly on the plate. At 1023 the plate is
`x: -1, w: 1025, radius: 0` — border off-screen both sides, full-bleed. `tableFits` holds at every
width; no horizontal overflow anywhere.

### The drag

`data-dragging` set, line `1px var(--line)` → `2px rgb(92,92,214)` for the whole gesture and back on
release; pane 320 → 490; **the plate's right edge stays at 1432 throughout**.

### One bug the numbers caught that the eye would not have

**At 1024 the main column ran 8px past the plate** — main ended at 1024, the plate at 1016 — because
main carries no left or right margin: the rail and the preview *are* the frame's two sides, and the
moment a breakpoint drops one of them, main becomes that side. Rows would have painted over the
border and squared off two corners. Fixed with two media queries that hand main the margin and the
corners of whichever neighbour left. Re-measured: 1024 → main ends at 1016, 900 → 901, 800 (rail
also gone) → main spans the whole plate.

### Reached beyond the declared files, and why

- **`_tree.css`** (3 lines) — the rail's `background` had to go or it would square off the frame's
  two left corners, and 240 → 236px is §4's number. Its placement and radius are in `_shell.css`
  with the rest of the frame.
- **`_preview.css`** — same: the pane's `--surface-2` fill removed, `flex-grow/shrink` dropped (dead
  in a grid), and the resizer rebuilt at 9px. This file was declared.
- **`_toolbar.css`** (2 rules) — the toolbar and batch bar moved *inside* the frame, so their
  `border-bottom: 1px solid hsl(var(--border))` became a flat opaque bar drawn across it. Both are
  now `inset 0 -1px var(--line)`. The batch bar's `background: hsl(var(--accent))` also went to
  `--sunken`: `--accent` is the hover fill, and a bar permanently wearing it reads as a row stuck
  mid-hover. Everything else in that file is still 04's.
- **`_table.css`** — `.browser-body` and `.browser-table-wrap` moved to `_shell.css`; the sticky
  header's background went from `hsl(var(--background))` (canvas) to `var(--surface)`, which is both
  what makes it opaque against the frame and what makes its overflow past the corners invisible.

### The residual, stated rather than buried

**The divider now sits 12.5px left of the cursor during a drag** — `--gap` plus half the 9px strip.
`usePreviewResize`'s `widthFrom` is `viewportWidth() - clientX`, whose comment asserted the pane was
flush against the window; 02 made that false. It is a constant offset, not a drift: the pane tracks
1:1 and lands where it is released.

Not corrected here. The fix is either a hard-coded 12.5 that duplicates `--gap` and rots when the
inset changes, or reading the pane's rect — and the hook is DOM-free on purpose, which is what lets
its clamp be tested at 640px and 3840px without a layout engine. The stale comment *was* corrected,
because a rationale that outlives its premise is worse than none. This wants its own ticket.
