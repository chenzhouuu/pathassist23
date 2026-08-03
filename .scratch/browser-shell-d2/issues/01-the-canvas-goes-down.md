# 01 — The canvas goes down, and the card stops being white

**What to build:** the palette shift that everything else in this round rests on. Nothing moves and
nothing is reframed; the page simply stops being near-white on near-white.

Design: `docs/Chen/plans/2026-08-03-browser-shell-d2-design.md` §3.

**Blocked by:** —

**Status:** done

**Files:** `src/styles/browser/_tokens.css` only. If this ticket touches a second file, something has
gone wrong.

- [ ] The Graphite roles take the new values in both themes — §3's first table. Light and dark are
      both authored; dark is not a mechanical inversion.
- [ ] `--surface` is **no longer `#ffffff`** in light and no longer `#141416` in dark. This is the
      whole point and it is the thing most likely to get quietly reverted by someone who thinks a
      card should be white.
- [ ] A new `--sel` role exists, distinct from `--hover` and from `--wash`: it is the neutral fill a
      checkbox-selected row carries. See 05 for who reads it.
- [ ] New shell scales: `--gap: 8px` and `--card-r: var(--radius-4)`. `--radius-4` is currently
      defined and referenced nowhere in the repo — this is the ticket that finally gives the largest
      radius its job.
- [ ] The shadcn contract is **restated, not left behind**. Every triplet in §3's second table is the
      new role flattened. Getting this wrong is invisible in the partials and obvious in the vendored
      components, because `ui/table.tsx`, `ui/button.tsx`, `ui/dropdown-menu.tsx` and
      `ui/checkbox.tsx` read only these names.
- [ ] Every shadcn triplet stays alpha-free. Tailwind compiles `bg-primary/30` to
      `hsl(var(--primary) / .3)`; a triplet carrying its own alpha yields `hsl(… / .5 / .3)`, which is
      not a colour and is dropped in silence.
- [ ] The comment at the old `--border` line is corrected while you are in there. It claims
      "line-2 flattened over canvas"; `#e5e5e5` is line-2 flattened over **white**, and the toolbar,
      batch bar and select that use it all sit on the canvas, not on a card. The new value is
      flattened over the new `--surface` and the comment should say so.
- [ ] The base `:root` block in `index.css` is **not edited**. The Viewer's palette stays identical
      by construction, exactly as it did in the Graphite round.

## Acceptance

Load the landing page. It is visibly greyer, the toolbar and table read as sitting *on* something,
and nothing has moved. Open a slide and come back: the Viewer is unchanged both ways.

`npm run build` clean. The existing 611 tests are untouched by this ticket and must stay green.

## Values

Both tables in §3 are computed rather than estimated — the lightness ladder lands at 6.08% / 2.16%
down from white against Linear's measured 6.14% / 2.22%. Do not re-derive them by eye.

## Comments

**2026-08-03 — done.** One file, `src/styles/browser/_tokens.css`, +70/−34. Build, typecheck and all
611 tests green.

**Every shadcn triplet was verified by computation, not by eye.** Each Graphite role was composited
over the surface it sits on and converted to HSL; all twelve match what was written, including the
two the design gave to one decimal:

| | light computed → written | dark computed → written |
|---|---|---|
| `--background` ← canvas | `240 3.2% 93.9%` → `240 3% 94%` | `240 5.3% 3.7%` → `240 5% 3.7%` |
| `--card` ← surface | `240 9.1% 97.8%` → `240 9% 98%` | `240 2.7% 7.3%` → `240 3% 7.3%` |
| `--secondary`/`--muted` ← sunken | `240 4.2% 90.6%` → `240 4% 91%` | `240 5.3% 11.2%` → `240 5% 11%` |
| `--muted-foreground` ← ink-2 | `222 4.7% 41.6%` → `222 5% 42%` | `240 4.2% 62.4%` → `240 4% 62%` |
| `--accent` ← hover over surface | `240 3.4% 94.3%` → `240 3% 94%` | `240 1.8% 10.8%` → `240 2% 10.8%` |
| `--border`/`--input` ← line-2 over surface | `240 1.6% 88.0%` → `240 2% 88%` | `240 1.1% 18.2%` → `240 1% 18%` |

**"Nothing has moved" was measured rather than asserted.** Before and after screenshots of the same
page at 1440×900 @2x: 99.8% of pixels changed value, and the **largest single-pixel delta is 14/255**.
A glyph or an edge that moved would produce deltas above 100 somewhere; there are none above 30.

**The Viewer is untouched, checked live rather than by construction.** With the page loaded on 500
real rows, removing `data-surface` from the document element makes `--background` resolve to
`0 0% 0%` and the body paint black — the reading room's own palette, unchanged. Putting it back
restores Graphite. `git diff --stat` is one file.

### Two things this turned up that belong to later tickets

- **`--accent` and `--muted` are within half a percent of each other in dark** — `(27,27,28)` against
  `(27,27,30)`. That is faithful to the roles (hover-over-surface really is that close to sunken near
  black) and they were left distinct rather than aliased, since the light pair are not. If a hovered
  row and the table footer ever sit adjacent, 09 is where it would show.
- **`--ink-3` on `--sunken` is 2.41:1**, which no current rule produces — ink-3 is only ever on
  surface or canvas today. **04** makes the search field a sunken well and **06** puts skeletons on
  sunken; if either lands tertiary text on that ground, it needs `--ink-2`. Noted here so it is not
  rediscovered as a finding.

  For the record, ink-3 on surface is 2.86:1, below AA for text. It was 2.69:1 before this ticket, so
  the change improved it; it is pre-existing and out of 01's scope. It carries chevrons, tree meta
  counts and the empty-state subtitle — decoration, not content.
