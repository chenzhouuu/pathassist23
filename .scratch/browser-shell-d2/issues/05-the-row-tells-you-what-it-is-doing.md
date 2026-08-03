# 05 — The row tells you what it is doing

**What to build:** six table details the evaluated prototype specified and the implementation never
got, plus two the research overturned.

Design: `docs/Chen/plans/2026-08-03-browser-shell-d2-design.md` §2.4–2.7, §5 gaps 1–6, 13.

**Blocked by:** 01

**Status:** done

**Files:** `src/styles/browser/_table.css`, `src/components/browser/browserColumns.jsx`.

## The six gaps

- [ ] **Sort direction, at all.** Today a sorted header only darkens; which way it is sorted is
      invisible. Primer's two-tier affordance: a persistent arrow on the sorted column in `--brand`,
      and a `visibility: hidden` hint arrow on every other sortable header revealed on hover and
      focus. `visibility`, not `display`, so revealing it shifts nothing. 8px gap, icon trailing the
      label.
- [ ] **Numeric alignment**, per §2.6 and Cloudscape's quantitative/categorical rule — **not** per
      the 2026-08-02 prototype, which right-aligned Size and Updated together:
      | Size | **right**, tabular | quantitative |
      | Scan | left, tabular | categorical — `40×` has a handful of values |
      | Updated | left, tabular | categorical — a date is a label |
      On a right-aligned column the sort glyph moves to the **left** of the label, so it stays
      against the numbers (Primer does this with `flex-direction: row-reverse`).
- [ ] **Empty values render `—`** at `--ink-3`, 60% — U+2014 em dash, which is what shipped code
      does (PostHog, Documenso, Dub, Sentry) even though Spectrum says en dash and Primer says leave
      it blank. A blank cell cannot be told apart from a column that does not apply to this row.
      The Scan column's existing *not recorded* / *not a slide* distinction stays — that is the
      "unknown vs not applicable" split §2.7 says matters more than the glyph.
- [ ] **Folder rows show `—` for an uncounted folder.** Girder never computes `nItems`, so today
      *every* folder row's sub-label is simply absent. The prototype shows `—`.
- [ ] **`title` on the truncated name**, and on the three clipping free-text columns. Names here reach
      89 characters; the grid card already has it and the table does not.
- [ ] **The table is inset from the frame** — the grid has `padding: 16px`, `.browser-table-wrap` has
      none, so today the table runs into the rail seam.

## The two the research overturned

- [ ] **Row hover comes back.** `_table.css` currently argues the row carries no hover fill because
      it is not a click target for opening. It *is* a click target — it selects. §2.4: VS Code ships
      the same hover colour in both its single-click and double-click open modes. Use `--hover`,
      calibrated to the frame rather than to white — shadcn's `bg-muted/50` computes to `#FAFAFA` and
      is invisible on anything that is not pure white. **Delete the comment along with the rule**; a
      stale rationale outlives the code it justified.
- [ ] **Selection becomes fill-plus-edge, not a second tint.** §2.5: a row can be checkbox-selected
      *and* the active preview row at once, and two background tints cannot coexist. Checkbox
      selection takes the neutral `--sel` fill; the active row adds `inset 2px 0 var(--brand)` on its
      first cell. 2px, because 2 and 4 are the only widths anything ships. Follow Thunderbird and
      draw the active edge on a selected row only when more than one row is selected — with a single
      selection the two states coincide and the bar is noise.

## Acceptance

- [ ] Sort each sortable column both ways: the direction is visible every time, and hovering an
      unsorted header reveals its hint arrow with no reflow.
- [ ] Sort Name descending: **folders still lead**. `foldersFirstIn(desc)` handles this and its five
      tests must stay green — the comparator is not being touched, but the header that triggers it is.
- [ ] A row with no size and no date shows two dashes, not two blanks.
- [ ] Hover a row, then select it, then check its box: three distinguishable states.
- [ ] Check two boxes and select one of them: the active edge appears. Uncheck one: it goes.

`npm test` green — the 37 `browseUtils` cases and the 5 `foldersFirstIn` cases untouched.
`npm run build` and `npm run typecheck` clean.

## Comments

**2026-08-03 — done.** `_table.css`, `browserColumns.jsx` and — see below — `BrowserPage.jsx`.
611 tests green, build and typecheck clean.

### Sort direction, measured

Headers on TCGA-BRCA/slides, read out of `getComputedStyle`:

| column | aria-sort | glyph | colour | label direction |
|---|---|---|---|---|
| Name | ascending | visible | `rgb(92,92,214)` — brand | row |
| Status / Updated | — | hidden | `rgb(148,148,157)` — ink-3 | row |
| Scan | — | *none* | — | — (`enableSorting: false`) |
| Size | — | hidden | ink-3 | **row-reverse** |

Clicking Size: `aria-sort: descending`, glyph visible and brand, still `row-reverse` so it sits
against the digits. Clicking again: `ascending`, and the icon path changes to `ArrowUp`. Nothing
reflows when a hint appears, because it is `visibility` and not `display`.

### The three row states, measured

Every cell background read live while driving real pointer events:

| | row 0 | row 1 | row 2 | `data-multi` |
|---|---|---|---|---|
| rest | — | — | — | false |
| hover row 1 | — | `rgba(0,0,0,.035)` `--hover` | — | false |
| click row 0 | `.055` `--sel` **+ 2px brand edge** | hover | — | false |
| tick row 0's box | `.055`, **edge gone** | — | — | false |
| tick row 2's box | `.055` **+ edge back** | — | `.055`, no edge | **true** |
| untick row 2 | `.055`, edge gone | — | — | false |

Thunderbird's rule behaves exactly as intended: the edge disappears when the only ticked row is the
one the pane is already showing, and returns the moment there is a second row for it to pick
between. Three states remain distinguishable — `.035`, `.055`, `.055` + edge.

### Reached beyond the declared files, and why

**`BrowserPage.jsx`.** The sort glyph, `data-align`, `data-checked` and `data-multi` all live in the
one `<TableHead>`/`<TableRow>` that renders every column. Which way the table is sorted is a fact
about the table's *state*, not about any column, so putting it in nine `header` definitions would
have been nine places to keep in step. The column still owns what is a column's: `meta.align` is
declared on Size in `browserColumns.jsx`, beside the reasoning for why it is the only one.

### Two items resolved differently from the ticket, both deliberate

- **"The table is inset from the frame" — not done, and it should not be.** The ticket measured this
  against the 2026-08-02 prototype's `padding: 16px` grid. The **D2 demo the user actually chose has
  no inset**: `tbody td { padding: 0 var(--s3) }` at 12px, which is exactly what
  `_table.css` already had. Adding one would diverge from what was judged at full size on real
  data, and would leave the row's hover fill and its divider stopping short of the seam. Measured
  after 02: the first cell's content starts 12px from the rail seam, not 0.
- **`th` reveals its hint on `:focus-visible` too, but no header is focusable yet.** The selector is
  written and inert. Making the headers keyboard-sortable is a real gap and a behaviour change; it
  belongs to its own ticket rather than to a styling sweep.

### One acceptance line could not be checked in the browser

**"Sort Name descending: folders still lead."** No level in this instance mixes folders and slides —
the collections root, Penn Pathology and TCGA-BRCA are folders only; BRCA-DEMO/DEMO and
TCGA-BRCA/slides are items only. The toggle itself was verified live (asc → desc, `aria-sort`
updates, the glyph flips), and `foldersFirstIn`'s five unit tests pass, but the comparator is
untouched by this ticket and its grouping behaviour rests on those tests rather than on a browser
check. Stated rather than claimed.
