# 07 — Eight radii become four

**What to build:** every corner on the page comes from the token scale, and the one that cannot be
fixed globally gets a scoped answer rather than a global one.

Design: `docs/Chen/plans/2026-08-03-browser-shell-d2-design.md` §6.

**Blocked by:** 02, 03, 04, 05 — this is a sweep and it should run over the finished shape, not
against a moving one.

**Status:** ready-for-agent

**Files:** all of `src/styles/browser/`, `src/components/browser/ImportModal.jsx`. Do **not** edit
`tailwind.config.js` — see below.

Eight distinct radii render on the page today: **2 / 4 / 6 / 7 / 8 / 12 / 50% / 999px**. Only 4, 6
and 8 come from the scale.

- [ ] Every hard-coded literal is replaced by its token. The audit found: `border-radius: 4px` in
      `_toolbar.css` (04 may already have taken this one), `borderRadius: 4` ×5 and `borderRadius: 2`
      ×2 in `ImportModal.jsx`, and `borderRadius: 7` in `SharePatientModal.jsx` — a value on no scale
      in the system. `999px` and `50%` are pills and circles and stay as they are.
- [ ] **`--radius-4` is in use.** 02 gives it the frame; confirm nothing else in the round has
      quietly re-created 12px as a literal.
- [ ] **The Tailwind `DEFAULT` trap.** `tailwind.config.js` overrides only `lg`/`md`/`sm`, so a bare
      `rounded` is Tailwind's own 4px. That is why `<Button>` renders at 4px everywhere
      `.browser-quiet` is absent — including **"Open slide"**, the page's one primary action, and both
      `NewEntryDialog` buttons. **Editing `DEFAULT` in the config would repaint the Viewer as well**,
      because the config is global and the Viewer's buttons are the same component. Answer it inside
      the `data-surface="browser"` scope instead, in the partial that owns the control.
- [ ] `rounded-xl` in `SharePatientModal.jsx` (3 sites) is also Tailwind's un-overridden default. It
      happens to equal `--radius-4`, which makes it correct by coincidence and unmaintainable by
      construction. 08 owns that file; either coordinate or leave the three to 08 and say so here.
- [ ] `DropdownMenuSeparator` is `h-px` on `bg-muted` — a 1px filled bar with square ends. It is
      vendored, so the fix is a scoped rule, not an edit.

## Acceptance

- [ ] `grep -rnE 'border-?[Rr]adius' src/styles/browser/ src/components/browser/` returns only token
      references, `999px`, `50%`, and `inherit`. Paste the output into the ticket when you close it.
- [ ] Every `<Button>` on the landing page has the same corner as the pill beside it. Check "Open
      slide" against the "Status" button next to it specifically — that pair is the one that is
      currently mismatched, 4px against 6px, in the most visible place on the page.
- [ ] The Viewer is unchanged. Open a slide, look at its buttons, come back. If `tailwind.config.js`
      appears in `git diff`, this criterion has already failed.

`npm run build` and `npm run typecheck` clean.
