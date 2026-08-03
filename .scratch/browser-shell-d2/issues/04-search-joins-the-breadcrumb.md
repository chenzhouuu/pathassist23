# 04 — Search joins the breadcrumb, and the toolbar stops mixing control systems

**What to build:** search lands in the toolbar beside the status filter, and every control in that
row finally looks like it came from the same place.

Design: `docs/Chen/plans/2026-08-03-browser-shell-d2-design.md` §4, §5 gaps 7 · 9 · 10.

**Blocked by:** 01, 03 (03 deletes the field from the top bar; this one re-creates it)

**Status:** done

**Files:** `src/styles/browser/_toolbar.css`, `src/components/browser/BrowserToolbar.jsx`.

- [ ] Search renders in the toolbar's action cluster. It searches the level the breadcrumb names,
      which is why it belongs beside it rather than in a band that now carries application settings.
- [ ] It is a **well, not a box**: `--sunken` ground, no border, `inset 0 0 0 1px var(--brand)` on
      focus. 28px to match its neighbours. It widens 190 → 240px on focus, on the layout duration.
- [ ] The debounce and the state stay exactly where they are — `useBrowseNavigation` owns
      `search`/`debouncedSearch` and this ticket moves a field, not a behaviour. Its 291-line test
      file must stay green untouched.
- [ ] The status filter stops being a native `<select>` with a system border and a system arrow.
      `appearance: none`, the `.pill` treatment, and the page's own chevron absolutely positioned in
      a `.selwrap`. It is currently the one control in that row wearing platform chrome.
- [ ] `.browser-select`'s `border: 1px solid hsl(var(--border))` is gone — one of §6's 22.
- [ ] `.browser-toolbar`'s `border-bottom` becomes `inset 0 -1px var(--line)`, and the toolbar grows
      from 42px to 48px (gap 11).
- [ ] The batch bar becomes a brand event rather than a grey one: `--wash` ground, the count in
      `--brand` at medium weight, and a 240ms `slidedown` on appearance (gap 9). Its
      `border-bottom` becomes an inset hairline like everything else.
- [ ] `.browser-crumb`'s hard-coded `border-radius: 4px` becomes `var(--radius-1)`. It is the only
      literal radius in the CSS partials and 07 would otherwise have to come back for it.

## Acceptance

- [ ] Type in the search field: the table filters after the existing 300ms debounce, and the field
      widens without pushing the buttons beside it off the row.
- [ ] Open the status filter: the menu is the platform's (it is still a native `<select>`), but the
      closed control matches the pills either side of it — same height, same radius, same ring.
- [ ] Select two slides: the batch bar slides down, tinted, with the count in brand.
- [ ] At 720px the toolbar still wraps rather than clipping.
- [ ] `prefers-reduced-motion: reduce` suppresses the slide. 06 owns the shared gate; if 06 has not
      landed, write the media query here and let 06 consolidate.

`npm test` green, `npm run build` and `npm run typecheck` clean.

## Comments

**2026-08-03 — done, committed with 03.** See 03's note on why they share a commit.

| | rest | focused |
|---|---|---|
| search width | 190px | **240px** |
| ground | `rgb(230,230,232)` = `--sunken` | same |
| ring | `transparent` inset | **`rgb(92,92,214)` inset 1px** |

Status filter: 28px, `appearance: none`, `border-width: 0`, `border-radius: 6px`, ring
`rgba(0,0,0,.1)` — the same shape as the pills either side of it. Toolbar 42 → **48px**, which is
also the table header's height. Typing `A0SI` filtered TCGA-BRCA/slides from 500 rows to 2 through
the existing debounce; `useBrowseNavigation` was not touched and its 291 tests are untouched.

Batch bar: ground `rgba(92,92,214,.09)` = `--wash`, count in `rgb(92,92,214)` at weight 510,
`animation: browser-slidedown 0.24s`. With `prefers-reduced-motion: reduce` emulated, the same bar
reports `animation-name: none` and `duration: 0s` — and is still there, because the bar is not the
optional part, the movement is.

### A regression this ticket caused, caught by screenshot and then measured

**The breadcrumb lost the level you were on.** Adding a 190px field to a row that already held seven
controls made it tight, and `overflow: hidden` on a `flex-start` row clips the TAIL — so at 1440px
"All collections › TCGA-BRCA › slides" rendered as "All collections", dropping the folder and the
level and keeping only the root nobody needed told. Two fixes:

- `justify-content: flex-end` on `.browser-crumbs`, so the elision moves to the head. This is what
  every file manager does and it costs nothing while there is room, because a `flex: 0 1 auto`
  container is only as wide as its content until it has to shrink.
- `min-width: 0` on `.browser-toolbar-actions`, without which **the cluster could not shrink at
  all**: a flex item's automatic minimum is its min-content, every label is `nowrap`, so the row's
  entire shortfall landed on the breadcrumb and the search field never gave up a pixel whatever its
  own `flex-shrink` said. The field now yields first, down to 140px.

| width | crumbs | search | visible trail |
|---|---|---|---|
| 1600 | 254 | 190 | All collections › TCGA-BRCA › slides |
| 1440 | 223 | **140** | TCGA-BRCA › slides |
| 1280 | 180 | 140 | TCGA-BRCA › slides |
| 1100 | 220 | 140 | TCGA-BRCA › slides |
| 720 | 254 | 190 | full — the toolbar wraps |

`tableFits` holds at every width.

**Still open, and it is a real limit.** Below 1600 the trail's head is clipped rather than replaced
by an ellipsis, so the cut lands mid-word on whatever crumb straddles the edge. The proper fix is
either a rendered "…" crumb, which needs measurement in JS, or dropping the button labels to icons
below some width — both are their own ticket. What this one guarantees is that the level you are
looking at is never the thing that gets lost.
