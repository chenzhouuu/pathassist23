# Browser landing page — the Graphite redesign

Ten tickets cut from `docs/Chen/plans/2026-08-02-browser-redesign-graphite-design.md`, which holds
the nineteen decisions, the open-source survey and the measurements these are built on. The tickets
link back to it rather than restating it.

Direction **A · Graphite** was selected on 2026-08-02 from the live demo at
`docs/Chen/plans/2026-08-02-browser-redesign-demo.html`, which compared three directions on real
Girder data.

## Dependency graph

```
01 fonts ───────────► 02 dead colour ─────┐
                                          ├──► 05 Graphite surface ──┬──► 06 table ──────┐
04 stylesheet split ──────────────────────┘                          │                   │
                                                                     ├──► 09 grid ───────┤
03 navigation hook ──┬───────────────────────────────────────────────┴──► 07 tree ───┬───┤
                     │                                                               │   │
                     └───────────────────────────────────────────────────────────────┴──► 08 preview
                                                                                         │
                                                                     10 responsive + pass ┘
```

| # | Ticket | Blocked by |
|---|---|---|
| 01 | Self-hosted typefaces, both CDN requests gone | — |
| 02 | Delete the two dead colour mechanisms | 01 |
| 03 | Extract the browse navigation into a hook | — |
| 04 | Split the landing page stylesheet by region | — |
| 05 | The Graphite surface, scoped to the landing page | 02, 04 |
| 06 | The table becomes a Graphite table | 05 |
| 07 | The collection tree | 03, 05 |
| 08 | The preview pane becomes resizable | 03, 07 |
| 09 | The grid view | 05 |
| 10 | Responsive column priority, and the cross-surface pass | 06, 07, 08, 09 |

Two of these edges are **file-level, not logical**, and are marked as such in the tickets:

- **02 ← 01** — unrelated changes that both edit `index.html`.
- **08 ← 07** — both restructure the same layout row.

They exist because this is being run by several agents at once. On a single-threaded run they could
be dropped.

## Running it with several agents

Four tickets are prefactors — 01, 02, 03 and 04 change nothing a user can see. Three of them start
immediately and touch disjoint files.

| Wave | Run in parallel | Why they don't collide |
|---|---|---|
| 1 | **01, 03, 04** | `index.html` + `index.css` / `BrowserPage` + new hook / `browser.css` |
| 2 | **02** | waits on 01 only because of `index.html` |
| 3 | **05** | the tracer bullet — the page changes colour with no rule edited |
| 4 | **06, 07** | `browserColumns` + table partial / new tree component + tree partial |
| 5 | **09**, then **08** | see the collision below |
| 6 | **10** | the integration gate |

**One residual collision, stated rather than papered over.** 07 (tree) and 09 (grid) are logically
independent — both only need 05 — but both add state to `BrowserPage`. Running them together means
a small manual merge there. Either run 06 ∥ 07 and take 09 afterwards, as the table above does, or
run all three and accept the merge. There is no honest edge that removes the choice.

## What is deliberately not in here

Each is a real defect with an independent fix; folding any of them in would make this unbounded.

- The 500-item query cap. TCGA-BRCA holds 942 slides.
- Row virtualisation — none exists anywhere.
- Focus trap, focus restore, portal and scroll lock in the hand-written dialogs.
- `lucide-react` at `^0.400.0` against upstream `1.28.0`.
- The Viewer, panels, sidebar, Projects, Second Opinion, share and portal pages, and the ~852
  legacy colour call sites they carry.

10 records the first three as known limits so its pass does not read as a clean bill of health.

## State

The tree is at `aa7a5c7`. No code has been written for any of these.
