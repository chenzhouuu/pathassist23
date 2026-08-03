# 03 — The logo band, and what belongs in it

**What to build:** the top strip stops being a search bar with a logo on it and becomes a brand band
carrying application-level settings, separated from the frame below by a rule.

Design: `docs/Chen/plans/2026-08-03-browser-shell-d2-design.md` §4.

**Blocked by:** 01

**Status:** done

**Files:** `src/styles/browser/_shell.css` (top-bar section), `src/components/browser/BrowserTopBar.jsx`.
Shares `_shell.css` with 02 — file-level edge only.

- [ ] The logo renders at **36px**, up from 22.
- [ ] The band's height follows the logo — `logo + 28px`, floor 56px — rather than the logo being
      dropped into a fixed band. At 36px in the old 52px bar the mark sits 8px from the rule and
      reads as jammed against it.
- [ ] The band is separated from the frame by `box-shadow: inset 0 -1px var(--line-2)`, **not** by
      `border-bottom: 1px solid hsl(var(--border))`. An inset shadow adds no layout height and the
      alpha composites over whatever is behind it; the opaque `#e5e5e5` it replaces is one of the 22
      heavy lines §6 counts.
- [ ] **The search field is removed from this band.** It moves to the toolbar — 04 owns that end, and
      the two tickets must not both be in flight without agreeing who deletes it. This one deletes.
- [ ] In its place, a settings cluster: theme switch, settings, help, then a hairline `vsep`, then
      the account chip. The theme switch is the control the page already owns (`useSurfaceTheme`);
      the other two are placeholders and should be marked as such in the source rather than wired to
      anything invented.
- [ ] The avatar becomes a **soft tint** — `--wash-2` ground, `--brand` glyph — instead of a solid
      brand fill. Gap 8 of §5. The page is allowed exactly one brand-filled element and it is the
      primary button; a solid avatar is a second one, competing at the opposite corner.
- [ ] The theme switch's icon states what the click will do, and carries no `aria-pressed` — a
      control that both renames itself and reports a pressed state announces the same fact twice in
      opposite directions. This is the same rule the preview toggle already follows.

## Acceptance

- [ ] The logo is legible at 36px in both themes, including the `invert(1) hue-rotate(180deg)` dark
      treatment that keeps Impart's teal teal.
- [ ] The rule under the band is visible but not heavy — compare against the old `#e5e5e5` by
      toggling the rule off; it should read as one step quieter, not as missing.
- [ ] Tab order through the band: logo (not focusable) → theme → settings → help → account.
- [ ] At 720px the account name still collapses as it does today.

`npm run build` and `npm run typecheck` clean.

## Comments

**2026-08-03 — done, committed together with 04.** The two tickets are one atomic change: 03 deletes
the search field from the band and 04 re-creates it in the toolbar, so a commit boundary between
them is a commit with no search on the page. The tracker keeps them separate; git does not.

Measured on the live page:

| | value |
|---|---|
| band height | **64px** = logo 36 + 28, floor 56 |
| logo | **36px**, up from 22 |
| rule | `rgba(0,0,0,.1) 0 -1px inset` — `--line-2`, not the opaque `#e5e5e5` |
| avatar | ground `rgba(92,92,214,.14)` = `--wash-2`, glyph `rgb(92,92,214)` = `--brand` |
| search in the band | **false** |
| focusable, in order | Switch to dark theme → account chip |

The logo is not focusable and the two placeholders are `disabled`, so the tab order is exactly the
two live controls.

### The placeholders

Settings and Help are rendered `disabled`, with a title saying so. The ticket said to mark them as
placeholders in the source rather than wire them to anything invented — there is no settings page
and no help content in this application. Rendering them live and inert would be the worse of the
two, since a control that does nothing on click is a bug report waiting to happen. When either gets
a destination, drop the `disabled` and add a handler.
