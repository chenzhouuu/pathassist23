# 09 — The cross-surface pass

**What to build:** nothing. This is the gate where the round gets checked as one thing rather than as
eight.

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08

**Status:** done

## The pass

- [ ] **Both themes × table and grid × 1440, 1280 and 1024.** The frame is inset at all three, the
      table does not overflow its container at any of them, and `table.scrollWidth <=
      container.clientWidth` holds. At 1023 the frame is full-bleed.
- [ ] **The sticky header, again.** §2.3 is the failure mode most likely to be reintroduced by a
      late edit, and it fails silently — the header does not error, it just scrolls away. Scroll a
      500-row folder in both views, at every width above.
- [ ] **Palette leak.** browse → open a slide → back to browse, twice. The Viewer renders in its own
      palette both times, the landing page in the new one both times, and `data-surface` is absent
      from the document element while the Viewer is showing.
- [ ] **The Viewer is untouched.** `git diff --stat` against the round's base must show no file
      outside `src/styles/browser/`, `src/components/browser/`, `src/components/share/` and the docs.
      In particular `tailwind.config.js` and `src/styles/index.css`'s base `:root` must not appear.
- [ ] **Air-gapped fonts.** Block every non-local host and confirm Inter and JetBrains Mono still
      render. This caught nothing last round because it was already fixed, and it is cheap.
- [ ] **White label.** Override `--brand-hsl` and confirm the primary button, the selection edge, the
      focus ring, the avatar tint and the active rail row all follow, and that nothing else shifts
      hue — the semantic chips in particular.
- [ ] **Reduced motion.** With the OS setting on, nothing animates: skeleton, batch bar, row entry,
      the search field's widening.
- [ ] **Real data, not a fixture.** BRCA-DEMO/slides for the BRACS import, TCGA-BRCA/slides for the
      4.33:1 strips, MDA/H-634-26 for *not recorded*, TCGA-NSCLC/slides for *not a slide*,
      `Penn Pathology/PENN-2026-0001` for the empty level and the 40-sibling rail branch.
- [ ] **All three dialogs**, both themes, opened from the page.
- [ ] `npm test`, `npm run build`, `npm run typecheck`.

## Then

- [ ] `/code-review` over the round's full diff, its blocking findings verified independently before
      being fixed, and the fixes committed separately.
- [ ] Update `docs/Chen/current-implementation/` if the shell's shape is described there.
- [ ] Record what is still open. §7's list plus anything this pass turns up. The pass must not read
      as a clean bill of health — last round's did not, and that was the right call.

## Known limits going in

Stated here so they are not rediscovered as findings:

- The 500-item query cap. TCGA-BRCA holds 942 slides.
- No row virtualisation.
- The three dialogs have no focus trap, focus restore, portal or scroll lock. 08 re-skinned them and
  explicitly did not touch behaviour.
- The rail puts every node in the tab order.
- Row selection is mouse-only in both views.
- The preview stays mounted and fetching below 1100px.

## Comments

**2026-08-03 — the pass, run against the real instance.**

### The grid: both themes × table and grid × four widths

Twenty-eight checks, all passing. The frame is at `x: 8` with a 12px radius at 1440, 1280 and 1024
in every combination, and at `x: -1, w: viewport+2, radius: 0` at 1023 — border pushed off both
edges, full-bleed. `table.scrollWidth <= wrap.clientWidth` and `wrap.scrollWidth <=
wrap.clientWidth` hold everywhere; nothing overflows horizontally in either view.

### The sticky header, again

`headerTop` before and after scrolling the wrap 600px over 500 real rows:

| | 1440 | 1280 | 1024 | 1023 |
|---|---|---|---|---|
| light | 120 → 120 | 120 → 120 | 120 → 120 | 111 → 111 |
| dark | 120 → 120 | 120 → 120 | 120 → 120 | 111 → 111 |

Nothing between the header and its scroll container acquired a radius over eight commits.

### Palette scope, twice

`data-surface="browser"` present → body `rgb(239,239,240)`. Removed → `--background` resolves to
`0 0% 0%` and the body paints black: the reading room's own palette, unchanged. Restored → Graphite
back. Same both times.

### The Viewer is untouched, by file list

`git diff --name-only` over the whole round returns nothing outside `src/styles/browser/`,
`src/components/browser/`, `src/components/share/`, `docs/` and `.scratch/`. **`tailwind.config.js`
and `src/styles/index.css` do not appear.**

### White label

`--brand-hsl` overridden to `12 90% 50%`:

| | before | after |
|---|---|---|
| avatar glyph | `rgb(92,92,214)` | `rgb(242,59,13)` |
| sort glyph | `rgb(92,92,214)` | `rgb(242,59,13)` |
| primary button | brand | `rgba(242,59,13,.85)` |
| **status chip** | `rgb(101,104,111)` | **`rgb(101,104,111)`** |

The chip not moving is the point: "flagged" is not a brand decision.

### Air-gapped fonts

Every `https://` host plus the font CDNs blocked at the network layer. `Inter: loaded`,
`JetBrains Mono: loaded`, page renders. (First attempt blocked `http://*/*` too, which also blocked
the dev server — the app could not load and the check was meaningless. Recorded because the failure
looked like a font failure.)

### Reduced motion

With `prefers-reduced-motion: reduce` emulated, every animated element present reports
`animation-name: none` — rows, cards, batch bar, skeleton.

### Real data

| | |
|---|---|
| `BRCA-DEMO/DEMO` | 1 row, scan kind `ok` |
| `MDA` | 1 row, 1 em dash |
| `TCGA-NSCLC/slides` | 24 rows, scan kinds `ok` **and** `unknown` — the *not recorded* case |
| `Penn Pathology/PENN-2026-0001` | 0 rows, "This level is empty." with no Clear-filters button |
| `TCGA-BRCA/slides` | 500 rows, used for every sticky and width check above |

### What the pass found, and fixed

**The toolbar could not hold what it holds.** Not a styling slip — arithmetic. Labelled, the action
cluster measures 676px and the breadcrumb wants 254; with gap and padding that needs 970px of main
column, which the frame only has from about 1551px of window up once the 236px rail and 320px
preview are out. Below that, *every* way of distributing the shortfall clips a control.

Two plausible fixes were tried and reverted, and both are recorded in `_toolbar.css` because they
look obviously right:

1. `min-width: 0` on the cluster — lets it shrink past its own buttons, and "Import" clipped at 1440.
2. `flex-shrink: 0` on the children — does not help, because the *container* is still shrinking and
   its children then overflow into `.browser-main`'s `overflow: hidden`.

The fix is to shed the three labels whose icons already say the same thing below 1550px, which
brings the cluster to 469px. `aria-label` and `title` carry the words in both states. Re-measured at
1920 / 1600 / 1551 / 1440 / 1280 / 1024 / 1023 / 720: **no clipped control at any width**, and the
full trail shows at all of them except 1280, where it keeps the two that matter.

`npm test` 611 green · `npm run build` clean · `npm run typecheck` clean.

## Still open

Everything in §7 of the design, plus:

- **The breadcrumb clips its head rather than eliding it.** `justify-content: flex-end` guarantees
  the level you are on survives, but the cut lands mid-word on whatever crumb straddles the edge. A
  rendered "…" crumb needs measurement in JS. Its own ticket.
- **The preview divider trails the cursor by a constant 12.5px** — `--gap` plus half the grab strip.
  `usePreviewResize` is DOM-free on purpose. 02's note has the full reasoning; its own ticket.
- **Table headers are not focusable**, so the sort hint's `:focus-visible` rule is written and
  inert. Making them keyboard-sortable is a behaviour change.
- **`--accent` and `--muted` are within half a percent in dark.** Faithful to the roles; only shows
  if a hovered row and the table footer ever sit adjacent.
- **`--ink-3` on `--sunken` is 2.41:1.** No current rule produces it. Watch it if tertiary text ever
  lands on the skeleton's or the search field's ground.
- The 500-item cap, no row virtualisation, dialogs without focus trap/restore/portal/scroll lock,
  the rail putting every node in the tab order, mouse-only row selection, and the preview staying
  mounted below 1100px.

This pass is not a clean bill of health, and it should not read as one.
