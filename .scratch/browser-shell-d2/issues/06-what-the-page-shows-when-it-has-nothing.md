# 06 — What the page shows when it has nothing yet

**What to build:** the loading and empty states stop being sentences.

Design: `docs/Chen/plans/2026-08-03-browser-shell-d2-design.md` §2.8, §5 gaps 14 · 15.

**Blocked by:** 02 (`BrowserPage`), 05 (`_table.css`)

**Status:** done

**Files:** `src/styles/browser/_table.css`, `src/components/browser/BrowserPage.jsx`, plus a small
new `SkeletonRows.jsx`.

- [ ] `<p>Loading…</p>` becomes **skeleton rows at the real 56px row height**. Carbon's reason for
      preferring skeletons on a data table is that they hold the layout still; a text line does the
      opposite, collapsing the table to one row and then expanding it.
- [ ] Placeholder widths cycle on Primer's five steps — 85 / 67.5 / 80 / 60 / 75% — so nine rows do
      not look stamped from one die.
- [ ] The pulse is **gated**: `@media (prefers-reduced-motion: reduce) { animation: none }`. Carbon
      ships this gate; **shadcn's `Skeleton` does not**, and Tailwind's `animate-pulse` is not gated
      by default — you have to write `motion-safe:` yourself. `src/styles/browser/` currently has no
      reduced-motion query at all, so this ticket introduces the first one.
- [ ] The gate covers the other motion this round adds: the batch bar's slide-down (04) and any row
      entry animation. One query, one place.
- [ ] The empty state gains an icon at ~35% opacity and a minimum height, so "this folder is empty"
      and "the request has not come back" are not two arrangements of the same two text lines.
- [ ] The distinction the empty state already draws — *nothing matches the filters* vs *this level is
      empty* — stays, along with its Clear-filters action.
- [ ] Row and card entry motion (gap 15): a 0.3s fade-and-rise. **Do not stagger it by index.** The
      prototype staggers up to 260ms, which is fine for its 10-row fixture and wrong for the 500-row
      folders this instance actually has — the last row would land a quarter-second after the first
      and the whole list would appear to wipe. If a stagger is wanted, cap it at the first ~8 rows.

## Acceptance

- [ ] Walk into TCGA-BRCA: skeletons appear at the row height the real rows will have, and the table
      does not jump when they are replaced.
- [ ] Walk into `Penn Pathology/PENN-2026-0001` (real, and really empty): the empty state renders
      with its icon, and no Clear-filters button, because nothing is filtered.
- [ ] Type a search that matches nothing: the *other* empty state, with the button.
- [ ] With `prefers-reduced-motion: reduce` set in the OS or DevTools, nothing on the page animates —
      skeleton, batch bar and row entry all still.
- [ ] Both themes: the skeleton is `--sunken` on the frame, and must be visible in dark, where the
      step between `#121213` and `#1b1b1e` is smaller than the light equivalent.

`npm test` green, `npm run build` and `npm run typecheck` clean.

## Comments

**2026-08-03 — done.** `SkeletonRows.jsx` (new), `_table.css`, `_grid.css`, `BrowserPage.jsx`.

### The skeleton, caught with the folder request held open at the network layer

```
{"n":9, "rowH":56, "widths":["85%","67.5%","80%","60%","75%"], "anim":"browser-pulse"}
```

Nine rows at the **real 56px row height**, so the table does not collapse to one line and then
expand — which is what `<p>Loading…</p>` did on every folder you walked into. Primer's five-step
width cycle, so the block is not stamped from one die. Under `prefers-reduced-motion: reduce` the
same element reports `animation-name: none`.

Catching it took three attempts and the first two failures are worth recording: blocking the URL
makes the query **error** rather than load, so the page renders the error state; and patching
`window.fetch` does nothing because the API layer is axios, which is XHR. `Fetch.requestPaused`,
held and never continued, is what actually reproduces "still loading".

### Both empty states

| | icon | opacity | text | action |
|---|---|---|---|---|
| `Penn Pathology/PENN-2026-0001` — really empty | `FolderOpen` | 0.35 | This level is empty. | none |
| search matching nothing | `SearchX` | 0.35 | Nothing matches the current filters. | Clear filters |

`min-height: 260px` on both, so neither is two lines of text floating in a blank frame, and the two
now differ by glyph as well as by sentence.

### Row and card entry

`browser-rowin 0.3s`, measured on a live row; `none` with reduced motion. **Not staggered by
index.** The 2026-08-02 prototype ramps to 260ms, which is right for its ten-row fixture and wrong
for the 500-row folders this instance has — the last row would land a quarter-second after the
first and the list would appear to wipe rather than appear.

### The gate

One contract, three places, because each partial gates its own elements: `_table.css` holds the
keyframes and the rows and skeleton, `_grid.css` the card, `_toolbar.css` the batch bar and the
search field's widening (written first, in 04). Carbon ships this gate on its skeleton; **shadcn's
does not**, and Tailwind's `animate-pulse` is not gated either — `motion-safe:` is something you
have to remember to write.

### Deliberately not mirroring the live column set

The skeleton draws a thumbnail, a name and one number. A skeleton that tracked `columnVisibility`,
the level rule and the responsive ladder would be a hand-maintained second implementation of three
things that already compose in `BrowserPage`, in order to be accurate about content nobody can read
yet. The frame is what has to be right.
