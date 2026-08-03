# 10 — Responsive column priority, and the cross-surface pass

**What to build:** the table sheds columns gracefully as it narrows instead of squeezing all seven,
and the whole redesign gets checked as one thing rather than as nine.

With the tree taking 240px and the preview 320px, a 1280px laptop leaves 720px for seven columns.
Something has to give, and which column gives first is a decision worth making once, explicitly.

**Blocked by:** 06, 07, 08, 09 — this is the integration gate.

**Status:** ready-for-agent

- [ ] Each column carries a priority, and columns drop in priority order as the table narrows. Name
      never drops. The mechanism is the one OHIF uses for the same problem in its StudyList (MIT),
      which this project already vendors from.
- [ ] A user's own choice in the column menu survives a resize — an automatic drop must not be
      written back as if the user had asked for it.
- [ ] Collapsing the preview pane widens the table and columns return.

## Cross-surface pass

- [ ] Both themes, at 1440px and 1280px, in table and grid.
- [ ] **Palette leak:** browse → open a slide → back to browse, twice. The Viewer renders in its own
      palette both times and the landing page in Graphite both times. The scoping attribute is
      absent from the document element while the Viewer is showing.
- [ ] **Air-gapped fonts:** with the network blocked, the landing page renders Inter and JetBrains
      Mono, not a system fallback. This is the check that would have caught the CDN defect at any
      point in the last year and has never been run.
- [ ] **White label:** override the brand token and confirm the primary button, selection wash,
      focus ring, avatar and active tree row all follow it, and that nothing else shifts hue.
- [ ] `npm test` — the 37 `browseUtils` cases green **without edits**, plus the navigation hook's
      own tests. `npm run build` and `npm run typecheck` clean.
- [ ] Real data, not a fixture: a BRACS folder, TCGA-BRCA for the 4.33 : 1 strips, the MDA tiffs for
      the *not recorded* scan state, and Penn Pathology for the deep-but-empty tree branch.

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

## Known limits, not fixed here

Stated so the pass does not read as a clean bill of health:

- The item query is capped at 500. TCGA-BRCA holds 942 slides; the rest do not exist as far as this
  UI is concerned, at any row height.
- There is no row virtualisation. A 56px row makes that more pressing, not less.
- The hand-written dialogs have `role="dialog"` and `aria-modal` but no focus trap, focus restore,
  portal or scroll lock.
