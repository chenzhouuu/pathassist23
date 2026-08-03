# 05 — The row tells you what it is doing

**What to build:** six table details the evaluated prototype specified and the implementation never
got, plus two the research overturned.

Design: `docs/Chen/plans/2026-08-03-browser-shell-d2-design.md` §2.4–2.7, §5 gaps 1–6, 13.

**Blocked by:** 01

**Status:** ready-for-agent

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
