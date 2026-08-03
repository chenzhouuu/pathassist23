# 07 — Eight radii become four

**What to build:** every corner on the page comes from the token scale, and the one that cannot be
fixed globally gets a scoped answer rather than a global one.

Design: `docs/Chen/plans/2026-08-03-browser-shell-d2-design.md` §6.

**Blocked by:** 02, 03, 04, 05 — this is a sweep and it should run over the finished shape, not
against a moving one.

**Status:** done

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

## Comments

**2026-08-03 — done.**

### The acceptance grep

```
$ grep -rnE 'border-?[Rr]adius' src/styles/browser/ src/components/browser/ \
    | grep -vE 'var\(--(radius|card-r|dialog-r)|999px|50%|inherit'
(nothing)
```

Every remaining declaration is a token reference, a pill or a circle.

### What actually renders, counted off the live page

Walking every element under `.browser-shell` plus an open Radix menu and collecting distinct
computed `border-radius` values:

```
["4px", "6px", "8px", "12px", "12px 0 0 12px", "0 12px 12px 0", "999px"]
```

Four scale values, the frame's two corner pairs, and the pill. Down from **2 / 4 / 6 / 7 / 8 / 12 /
50% / 999px**. The 2px (`rounded-sm` on the vendored checkbox, `calc(var(--radius) - 4px)`) and the
7px (`SharePatientModal`'s literal, gone in 08) were the two that belonged to no scale at all.

### The Tailwind DEFAULT trap, answered without touching the config

`git diff --stat -- tailwind.config.js` is empty, which is the criterion. `borderRadius` there
overrides `lg`/`md`/`sm` and leaves `DEFAULT`, so the bare `rounded` on `ui/button.tsx` and every
`ui/dropdown-menu.tsx` surface is Tailwind's own 4px — and that config is global, so editing it
would repaint the Viewer's buttons too.

Each control is corrected in the partial that owns it, which is three rules:

| control | partial | measured |
|---|---|---|
| "Open slide" / "Open folder" | `_preview.css` | **6px**, matching the "Status" button beside it — the pair the ticket named |
| NewEntryDialog's two buttons | `_dialogs.css` | 6px |
| "Clear filters" | `_table.css` | 6px |

The chrome with no partial of its own is in `_shell.css`: menu `8px`, menu item `4px`, checkbox
`4px`. Matched on `role` rather than by descendant, because Radix portals `DropdownMenuContent` onto
`document.body` — outside `.browser-shell` — and `[role='menu']` at (0,2,0) is also what beats
Tailwind's `.rounded` at (0,1,0), which otherwise wins every tie on source order.

`DropdownMenuSeparator` is `h-px` on `bg-muted` — a *fill* token, the same colour as the menu's own
hover, so at 1px it read as a thin slab rather than a rule. Now `--line-2`: measured
`rgba(0,0,0,0.1)`.

### Coordination with 08

`SharePatientModal`'s five internal radii were done in **08**, not here — they sat on lines that
ticket was already rewriting, `borderRadius: 7` among them. `ImportModal`'s six literals
(`borderRadius: 4` ×4, `borderRadius: 2` ×2) were left for this ticket and are done.

`src/components/share/PatientViewer.jsx` and `SingleImageViewer.jsx` still carry `rounded-lg` and
`rounded-xl`. They are **not this surface** — the patient portal renders outside `data-surface`, has
its own palette and was not part of this round. Left alone deliberately.
