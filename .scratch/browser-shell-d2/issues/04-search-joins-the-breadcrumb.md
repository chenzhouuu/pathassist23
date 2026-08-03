# 04 — Search joins the breadcrumb, and the toolbar stops mixing control systems

**What to build:** search lands in the toolbar beside the status filter, and every control in that
row finally looks like it came from the same place.

Design: `docs/Chen/plans/2026-08-03-browser-shell-d2-design.md` §4, §5 gaps 7 · 9 · 10.

**Blocked by:** 01, 03 (03 deletes the field from the top bar; this one re-creates it)

**Status:** ready-for-agent

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
