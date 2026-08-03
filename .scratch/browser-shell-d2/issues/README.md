# Browser landing page — the D2 shell, round two

Nine tickets cut from `docs/Chen/plans/2026-08-03-browser-shell-d2-design.md`, which holds the
decisions, the three surveys they rest on and the measured numbers. The tickets link back to it by
section rather than restating it.

Framing **D2** was selected on 2026-08-03 from the live demo at
`docs/Chen/plans/2026-08-03-browser-shell-demo.html`, which compared D1, D2 and today's page on real
Girder data, with the canvas shift and the table detail as separate controls so each cost could be
seen on its own.

## Dependency graph

```
01 palette ──┬──► 02 the frame ────────┬──────────────────────┐
             │                         │                      │
             ├──► 03 logo band ──► 04 search + controls ───────┤
             │                                                │
             ├──► 05 the row ──┬───────────────────────────────┤
             │                 │                              │
             │        02,05 ──►│ 06 empty + skeleton ──────────┤
             │                                                │
             └──► 08 dialogs ─────────────────────────────────┤
                                                              │
                        02,03,04,05 ──► 07 radii ─────────────┴──► 09 pass
```

| # | Ticket | Blocked by |
|---|---|---|
| 01 | The canvas goes down, and the card stops being white | — |
| 02 | One frame under the rule | 01 |
| 03 | The logo band, and what belongs in it | 01 |
| 04 | Search joins the breadcrumb | 01, 03 |
| 05 | The row tells you what it is doing | 01 |
| 06 | What the page shows when it has nothing yet | 02, 05 |
| 07 | Eight radii become four | 02, 03, 04, 05 |
| 08 | Three dialogs become one frame | 01 |
| 09 | The cross-surface pass | all |

Two edges are **file-level, not logical**, and are marked as such in the tickets:

- **03 ↔ 02** — both edit `_shell.css`, in different sections.
- **04 ← 03** — the search field has to be deleted from the top bar before it is re-created in the
  toolbar, or two agents both own it and neither deletes it.

## Running it with several agents

01 is a tracer bullet: the page changes colour with no rule and no component edited, and everything
else depends on it. Nothing should start before it lands.

| Wave | In parallel | Why they don't collide |
|---|---|---|
| 1 | **01** | `_tokens.css` alone |
| 2 | **02, 05, 08** | `_shell`+`_preview`+`BrowserPage` / `_table`+`browserColumns` / `_dialogs`+3 modals |
| 3 | **03** | `_shell.css`'s top-bar section — small manual merge with 02 if 02 is still open |
| 4 | **04, 06** | `_toolbar`+`BrowserToolbar` / `_table` empty state + `BrowserPage` |
| 5 | **07** | the sweep, over a settled shape |
| 6 | **09** | the gate |

**Two residual collisions, stated rather than papered over.** 02 and 03 share `_shell.css`; 05 and 06
share `_table.css` and 02 and 06 share `BrowserPage.jsx`. All three are small and in different
regions of their files. Either serialise the pairs as the table above does, or run them together and
accept the merges. There is no honest edge that removes the choice.

## The one that will break

**02's sticky header.** A rounded wrapper with `overflow: hidden` becomes a scroll container and
`position: sticky` then sticks to a box that never scrolls. It does not error — the header just
scrolls away, and it is easy to miss on a folder short enough not to scroll. Design §2.3 has the
six-variant browser test, and both shadcn and Radix Themes have open issues for exactly this. Radius
and scrolling go on the same element. 09 re-checks it because a late edit anywhere can reintroduce it.

## What is deliberately not in here

Design §7 has the full list with reasons. The three worth repeating:

- **The dialogs get a new skin, not new behaviour.** No focus trap, no focus restore, no portal, no
  scroll lock. Decided explicitly.
- **`tailwind.config.js` is not edited.** Its `borderRadius.DEFAULT` is the reason half the page's
  buttons are 4px, and changing it would repaint the Viewer. 07 answers it inside the scope.
- The 500-item cap, row virtualisation, the rail's tab order, mouse-only row selection, and the
  preview staying mounted below 1100px.

## State

Branched from `dc92167`.

| # | State |
|---|---|
| 01 | **done** — the palette shift, one file, verified against real Girder data in both themes |
| 02–09 | not started |

Wave 2 (**02**, **05**, **08**) is unblocked.
