# 02 — Delete the two dead colour mechanisms

**What to build:** two colour mechanisms that nothing reads are removed, so the third one this
redesign introduces (05) arrives in a namespace where every remaining mechanism is live.

Neither is used by anything. The `dsa.*` palette is fifteen lines of Tailwind config defining a
twelve-colour hex scale with **zero** references in `src/` or `index.html`. The `data-theme`
bootstrap writes an attribute to the document element on every page load, defaulting to `'he'`,
and **no CSS selector and no JavaScript reads it**.

The second one is why this ticket is not merely tidy. 05 needs a document-level attribute to scope
the new palette; leaving a same-shaped attribute that means nothing turns a harmless corpse into a
live ambiguity for whoever next reads the head of `index.html`.

**Blocked by:** 01 — both tickets edit `index.html`, and doing them in parallel would collide. This
is a file-level gate, not a logical one; the two changes are unrelated.

**Status:** ready-for-agent

- [ ] The `dsa.*` colour scale is gone from the Tailwind config. Verified by searching the source
      for each of its keys — `dsa-bg`, `dsa-panel`, `dsa-accent` and the rest — in both class and
      config form, and finding no consumer.
- [ ] The `data-theme` bootstrap script is gone from `index.html`, along with the attribute it
      wrote. Verified: no CSS selector matches `[data-theme]` and no JavaScript reads it.
- [ ] `npm run build`, `npm test` and `npm run typecheck` all pass.
- [ ] No visual change on any surface — the landing page, the Viewer, and the panels are
      pixel-identical before and after.
- [ ] The removal is its own commit, so a bisect that lands here has an unambiguous answer.
