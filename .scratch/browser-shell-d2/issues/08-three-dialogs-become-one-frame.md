# 08 — Three dialogs become one frame

**What to build:** the three modal dialogs stop disagreeing about what a dialog looks like, the two
undefined classes get defined, and the share dialog stops wearing the reading room's colours.

Design: `docs/Chen/plans/2026-08-03-browser-shell-d2-design.md` §6.

**Blocked by:** 01

**Status:** ready-for-agent

**Files:** `src/styles/browser/_dialogs.css`, `NewEntryDialog.jsx`, `ImportModal.jsx`,
`src/components/share/SharePatientModal.jsx`.

Only `NewEntryDialog` reads `_dialogs.css`. The other two are entirely inline, and the three agree on
exactly one thing — the heavy flat border.

| | scrim | z-index | panel radius | shadow |
|---|---|---|---|---|
| NewEntryDialog | `rgb(0 0 0 /.7)` | 60 | 6px | `--elev-2` |
| ImportModal | `rgba(0,0,0,.55)` + blur(4px) | **1000** | **4px literal** | hard-coded 64px plume |
| SharePatientModal | `rgba(0,0,0,.65)` | 50 | 12px | hard-coded 60px plume |

## The frame

- [ ] One set of tokens — scrim, z-index, panel radius, panel edge, panel shadow — and all three read
      them. Four properties currently have three answers each.
- [ ] Panel radius `var(--radius-4)`. 6px around a 400px panel reads as a right angle, and 4px more
      so.
- [ ] The panel's edge becomes `0 0 0 1px var(--line)` inside `--elev-2` rather than
      `border: 1px solid hsl(var(--border))`. Today `.browser-modal` carries **both** — a flat opaque
      line and, 1px outside it, `--elev-2`'s own hairline. Two concentric edges.
- [ ] The scrim comes down. `rgb(0 0 0 / .7)` is inherited from the Viewer's black room; over a
      near-white page it reads as a blackout. Land it around 40% and add a small backdrop blur —
      `ImportModal` already blurs and is the closest of the three to right.
- [ ] The two hard-coded black plumes go. They were drawn for a dark ground; `--elev-2` is the
      page's answer and it is theme-aware.
- [ ] Inputs become wells, matching the search field 04 builds: `--sunken` ground, no border,
      brand ring on focus.

## The two classes that do not exist

- [ ] **`.input-field` and `.btn-secondary` have zero definitions anywhere in the repo** and are used
      on 8 lines of `ImportModal.jsx`. Every `<select>`, `<input>` and secondary button in the import
      dialog currently renders as raw user-agent control chrome — square, grey, platform-drawn. This
      is the most literal "obvious square box" on the page and the reason the dialogs are in scope at
      all. Define both in `_dialogs.css` against the same wells and pills the rest of the page uses.
      Verify with `grep -rn 'input-field\|btn-secondary' src/ --include=*.css` before and after.

## SharePatientModal

- [ ] Its **15 lines of pre-Graphite colour** — `#4da6ff`, `#4caf82`, `#e94560`, `text-gray-700`,
      `hover:bg-gray-700/50` — move onto `--brand`, `--sem-*` and `--ink-*`. All of them were drawn
      for the Viewer's black ground and now sit on a white panel.
- [ ] This carries **no dual-surface risk**: the file has exactly one importer, `BrowserPage.jsx:34`.
      It is not opened from the Viewer. (An earlier note in this effort claimed otherwise; it was
      wrong and was corrected.)
- [ ] Its five internal radii collapse onto the scale, including `borderRadius: 7`.
- [ ] `ImportModal`'s hard-coded `fontFamily: "'IBM Plex Sans', …"` goes — it is the one element on
      the landing page not following `--font-ui`.
- [ ] `ImportModal`'s progress track is filled with `var(--border-hex)` — the border token used as a
      fill. Give it `--sunken` and `--brand`.

## Explicitly not in this ticket

**Behaviour does not change.** No focus trap, no focus restore, no portal, no scroll lock, no Radix
`Dialog`. The dialogs get a new skin. This was decided explicitly, not overlooked, and §7 records it.

## Also

- [ ] `src/components/share/ShareImageModal.jsx` (5.9 KB) has **zero importers**. Delete it, in its
      own commit, so the deletion is separable from the re-skin.

## Acceptance

- [ ] Open all three dialogs. Same scrim, same corner, same edge, same shadow.
- [ ] In the import dialog, every control is the page's — no platform select arrows, no grey system
      buttons. Screenshot it; this is the ticket's whole point.
- [ ] The share dialog in both themes: no blue, no green, no red that did not come from a token.
- [ ] Escape and the close button still work in all three; Tab still escapes the dialog, because that
      is a known limit and not this ticket's job.

`npm test` green, `npm run build` and `npm run typecheck` clean.
