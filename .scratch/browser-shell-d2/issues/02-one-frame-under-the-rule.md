# 02 — One frame under the rule

**What to build:** the D2 shell. A full-width logo band with a rule under it; below the rule, a
single 12px-radius frame, inset 8px, holding the rail, the table and the preview. The rail is
separated from the table by a hairline rather than by a gutter — that is what makes it one frame
instead of three touching ones.

Design: `docs/Chen/plans/2026-08-03-browser-shell-d2-design.md` §4.

**Blocked by:** 01

**Status:** ready-for-agent

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
