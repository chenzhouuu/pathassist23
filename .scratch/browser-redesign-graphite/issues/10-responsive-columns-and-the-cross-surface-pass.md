# 10 — Responsive column priority, and the cross-surface pass

**What to build:** the table sheds columns gracefully as it narrows instead of squeezing all seven,
and the whole redesign gets checked as one thing rather than as nine.

With the tree taking 240px and the preview 320px, a 1280px laptop leaves 720px for seven columns.
Something has to give, and which column gives first is a decision worth making once, explicitly.

**Blocked by:** 06, 07, 08, 09 — this is the integration gate.

**Status:** done

- [x] Each column carries a priority, and columns drop in priority order as the table narrows. Name
      never drops. The mechanism is the one OHIF uses for the same problem in its StudyList (MIT),
      which this project already vendors from.
      → `meta.priority` in `browserColumns.jsx`, `hiddenByWidth()` in `responsiveColumns.js`,
      `useResponsiveColumns.js` for the ResizeObserver. Ladder, lowest first: Collection, Folder,
      Updated, Size, Diagnosis, Scan, Status. Name and the select box carry no priority at all,
      which is how "never drops" is stated.
- [x] A user's own choice in the column menu survives a resize — an automatic drop must not be
      written back as if the user had asked for it.
      → the drop is layered onto `effectiveVisibility`, the same derivation the level rule uses;
      `columnVisibility` holds nothing but the user's own choices, and the Columns menu now reads
      its checkmarks from that map rather than from the result.
- [x] Collapsing the preview pane widens the table and columns return.
      → measured live: 715px → 1040px, Updated returns; reopening drops it again.

## Cross-surface pass

- [x] Both themes, at 1440px and 1280px, in table and grid. `table.scrollWidth <= container
      .clientWidth` asserted at all eight combinations, and at every viewport from 1101 down to 640.
- [x] **Palette leak:** browse → open a slide → back to browse, twice. The Viewer renders in its own
      palette both times and the landing page in Graphite both times. The scoping attribute is
      absent from the document element while the Viewer is showing.
      → `data-surface` null in the Viewer both times, `browser` on both returns; body #000 vs #fafafa.
- [x] **Air-gapped fonts:** with the network blocked, the landing page renders Inter and JetBrains
      Mono, not a system fallback. This is the check that would have caught the CDN defect at any
      point in the last year and has never been run.
      → every non-local host aborted at the route level; the only font requests are
      `localhost:3477/fonts/*.woff2`, no external request was even attempted, and canvas metrics
      separate Inter from both `sans-serif` and `system-ui` and JetBrains Mono from `monospace`.
- [x] **White label:** override the brand token and confirm the primary button, selection wash,
      focus ring, avatar and active tree row all follow it, and that nothing else shifts hue.
- [x] `npm test` — the 37 `browseUtils` cases green **without edits**, plus the navigation hook's
      own tests. `npm run build` and `npm run typecheck` clean. → 606 tests, 30 files.
- [x] Real data, not a fixture: a BRACS folder, TCGA-BRCA for the 4.33 : 1 strips, the MDA tiffs for
      the *not recorded* scan state, and Penn Pathology for the deep-but-empty tree branch.
      → BRCA-DEMO/slides (the BRACS import), TCGA-BRCA/slides (4.33 : 1 in the pane),
      MDA/H-634-26 (*not recorded*), TCGA-NSCLC/slides (`cellpose_test.anot` → *not a slide*),
      Penn Pathology/PENN-2026-0001 (*This level is empty*).

## Found during implementation, and landing here

Three things nobody's ticket owns, each spotted by looking at the page rather than at a diff.
They are in scope for this one because this is the pass that looks at the whole thing.

- **The toolbar shouts.** `ui/button.tsx`'s ghost variant is `text-primary`, and under Graphite
  `--primary` is the brand indigo. On the Viewer's black ground a blue ghost button was the quiet
  option; on a near-white canvas three indigo buttons in a row become the loudest thing on the
  page and flatten the toolbar against the table. The prototype's answer is that a toolbar control
  is `--ink-2` with an `inset 0 0 0 1px var(--line-2)` ring, and only the one primary action
  carries a brand fill. Fix in `_toolbar.css`, not in the vendored button.
- **The logo vanishes in dark.** All three brand assets are dark artwork drawn for a white page,
  and the product is white-labelled so they cannot simply be re-cut. The prototype's rule is
  `[data-mode="dark"] .browser-logo { filter: invert(1) hue-rotate(180deg) }` — the hue rotation
  is what keeps Impart's teal teal and Algopath's magenta magenta, which a plain `invert()` would
  not.
- **The select column is ~140px of dead space.** `browserColumns.jsx` sets `size: 36` and
  `BrowserPage` passes it through as a `width` style, but in an auto-layout table with spare room
  that is a hint rather than a rule, so the checkbox column absorbs the slack and pushes the
  thumbnail a finger's width right. Pre-existing, but invisible on black and obvious on white.
- **The scan query and the status chip are stated twice.** `ScanCell` and `StatusChip` live inside
  `browserColumns.jsx` and are not exported, so the grid restated both rather than importing them
  — the two tickets ran concurrently and the file belonged to one of them. The behaviour that
  matters is already shared: the grid's query key is character-for-character the table's, so
  switching views costs no request. What is duplicated is the wiring. Lift the scan query into a
  `useScanFacts(row)` module both import, and export the chip.

All four are fixed. What each turned into:

- The toolbar → `.browser-quiet` in `_toolbar.css`, applied in `BrowserToolbar.jsx`, the batch bar
  and the preview pane's action row. The vendored button is untouched. The preview pane's
  `variant="secondary"` buttons had the second half of the same problem — a sunken fill on a
  near-sunken ground, no visible boundary — and carry the same class. "Open slide" keeps the brand
  fill and is now the only brand-filled control on the page.
- The logo → `:root[data-mode='dark'] .browser-logo { filter: invert(1) hue-rotate(180deg) }` in
  `_shell.css`.
- The select column → 36px exactly, measured. It comes from `table-layout: fixed`, which is also
  what stops the 219px overflow: every column but Name declares a width in `meta` and Name takes
  the remainder, so the table is exactly its container's width at every size.
- The scan query and the chip → `useScanFacts.js` and `StatusChip.jsx`, imported by the column, the
  card and the pane. `scanFacts.js` now exports the two formatters as well as the sentence, which
  is what let the pane stop keeping its own copies. Verified in the browser: across a table → grid
  → table switch and a row selection, no `/tiles` URL is ever requested twice.

Two more found in the same pass and fixed here, both in `_shell.css`:

- The native `<select>` and the scrollbars stayed light in dark mode. `color-scheme` on
  `.browser-shell`, switched by `[data-mode='dark']`.
- The search field's clear button was `filter: invert(1)`, unscoped — written for the Viewer's
  black ground, and white-on-white here. Now the inversion applies in dark only.

## Known limits, not fixed here

Stated so the pass does not read as a clean bill of health:

- The item query is capped at 500. TCGA-BRCA holds 942 slides; the rest do not exist as far as this
  UI is concerned, at any row height.
- There is no row virtualisation. A 56px row makes that more pressing, not less.
- The hand-written dialogs have `role="dialog"` and `aria-modal` but no focus trap, focus restore,
  portal or scroll lock.
