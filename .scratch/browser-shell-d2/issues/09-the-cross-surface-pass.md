# 09 — The cross-surface pass

**What to build:** nothing. This is the gate where the round gets checked as one thing rather than as
eight.

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08

**Status:** ready-for-agent

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
