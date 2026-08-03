# Browser landing page — the Graphite redesign · Plan

> **Date:** 2026-08-02
> **Author:** Chen (with Claude)
> **Status:** Plan — awaiting sign-off. **No code written.**
> **Evaluation surface:** `docs/Chen/plans/2026-08-02-browser-redesign-demo.html` — three
> directions on real Girder data. Direction **A · Graphite** was chosen from it on 2026-08-02.
> **Ask (verbatim):** 我现在需要重新design main page的界面，需要对整个UI风格，字体，颜色，
> 框框等所有的UI/UX进行重新design。用subagent调研目前可以借鉴的project，然后汇总一个适合整个
> project （path-viwer），要求界面清晰简洁，但是符合当代界面设计的审美 （审美特别重要），在
> 和我交互结束后需要生成一个可视化的live demo让我直观的评估。利用subagent, 去搜索necessary的
> 适合这个project的前端素材
> **Selection (verbatim):** 现在选定A Graphite

---

## 0. What this is

The landing page — `src/components/browser/`, the page `App.jsx` returns for
`currentPage === 'browse'` — gets a new visual system and a reconsidered information
architecture. Three things travel together:

1. **A token layer that is new, and scoped.** The Graphite palette replaces the OHIF
   reading-room palette *for this page only*. The Viewer, the panels and the sidebar keep the
   palette they have.
2. **An information architecture that gains a left tree, a grid view and a resizable preview.**
   The navigation model — breadcrumb, one table, double-click, Backspace — survives; what the
   page is made of does not.
3. **Typography that actually loads.** The app has never rendered its own typeface on an
   air-gapped deployment (§3.4). Self-hosting is not a nicety attached to the redesign; it is
   the precondition for any typographic decision being real.

These are one increment because the token layer has no visible surface without the page, and
re-cutting the page against the palette it already has would mean doing the same work twice.

---

## 1. Decision ledger (grilled with Chen, 2026-08-02)

Eighteen decisions, taken in interview before any pixel was drawn. #8–#18 were then evaluated
against a live demo built on real Girder data; the selection of A · Graphite is the nineteenth.

| # | Decision | Choice | Why |
|---|---|---|---|
| **D1** | Scope | **Token layer + `browser/` + `ui/*.tsx` re-theme.** Viewer, panels, sidebar, projects, cases, share untouched | The landing page is where the aesthetic is judged and it is the smallest surface that can carry a complete system. A whole-app sweep is 122 files and ~852 legacy call sites (§3.2); it is a separate increment, not a bigger version of this one. |
| **D2** | Themes | **Light and dark both ship** | Chen's call, taken against the recommendation to ship one well first. The token layer is structured so the second theme is a variable block, not a second design (§4). |
| **D3** | Canonical | **Light is designed first; dark derives from it** | Light cannot hide a broken hierarchy behind glow and transparency, so it is the harder one and the one whose structural discipline the derived theme inherits. |
| **D4** | Depth | **Information architecture is reconsidered, not skinned** | "框框等所有的 UI/UX" is not a repaint. A 13px table in new colours is the same table. |
| **D5** | Purpose | **The landing page is a navigator** — "where are my slides" | Rejected: a worklist (needs `meta.assignee`, which does not exist — §3.5), a summary strip (the Dashboard was deliberately deleted for being a second, drifting source of truth — `BrowserPage.jsx:4-7`), and an AI-coverage axis (needs a per-row artifact query). **Zero new data required.** |
| **D6** | Brand | **Neutral UI plus one `--brand` token** | The product is white-labelled: `APP_NAME` and `LOGO_SRC` are `VITE_*` env vars and three brands ship in `public/` — Impart DX (navy + teal), Algopath (purple + magenta), MDA. A design whose character depends on "the blue" breaks on the second deployment. Semantic colours (read / in-review / flagged) are independent of brand. |
| **D7** | Density | **14px body · 56px row · 40×40 thumbnail · 4px spacing base** | The survey range is 30.4px (DSA) → 36.5px (OHIF) → 44px (Radix), and **not one of those tables carries a thumbnail** — which is exactly why they do not transfer. Today's 40px thumbnail inside a 44px row leaves 2px of air, which is the actual source of the crowding, not the font size. |
| **D8** | Direction count | **Three, evaluated side by side** | Aesthetics are judged comparatively. One direction iterated gives no reference frame. |
| **D9** | Demo form | **One self-contained HTML with a real data snapshot** | Real 89-character filenames and real 0.62–4.33 aspect ratios expose layout faults that `Case 001` hides. Rejected publishing to a shareable URL: the snapshot contains MDA and Penn Pathology imagery. |
| **D10–11** | The three directions | **A · Graphite / B · Warm / C · Instrument**, differing in colour temperature, structure *and* type voice | B was moved off a serif at Chen's request; that left it separated from A by colour temperature alone, so it additionally took separated card rows and a different sans. |
| **D12** | Tree | **A real expandable tree to folder level**, no slides in it | Chosen knowing the data is shallow (§3.5). It is the schema's shape, not today's data, that the component has to survive. |
| **D13** | Type set | **Inter / Albert Sans / Geist**, all OFL, all self-hosted | Graphite takes **Inter Variable at 440 / 510 / 590** with `cv01`/`ss03` and `opsz auto`, and **JetBrains Mono** for identifiers and measurements. |
| **D14** | Preview pane | **Resident, draggable, 320px default, collapsible**, clamped 15–50%, state persisted | OHIF's own recipe (`platform/app/src/routes/WorkList`, MIT): 325px default, viewport-percentage clamp, `sessionStorage`. |
| **D15** | Thumbnails | **Uniform frame, `object-fit: contain`, centred** | Real aspect ratios run **0.62 : 1 to 4.33 : 1** (§3.5). Today's `cover` crops a 4.33 : 1 strip to its middle square and destroys the macro shape, which is the first thing a pathologist reads. |
| **D16** | Deliverable boundary | **Demo only; implementation is a separate decision** | Held. This document is that separate decision being taken. |
| **D17** | Columns | ☐ · thumbnail · Name · Status · **Scan** · Size · Updated | `Scan` carries real `magnification` and `mm_x` from the `tiles` endpoint. It is the column that distinguishes a pathology tool from a file manager, and it needs no new API. Numeric columns are mono with `tabular-nums`. Status is a **soft-tint chip**, never a saturated solid (§2.3). |
| **D18** | Dark depth in the demo | **Only A's dark was designed**; B and C inverted mechanically and said so | Now moot for B and C — A won, and its dark is the one that was already tuned. |
| **D19** | Direction | **A · Graphite** | Selected 2026-08-02 from the live demo. |

**Determined by fact, not chosen:**

- **`browser.css` needs no call-site sweep.** It is already 100% on the shadcn contract: 56
  `hsl(var(--x))` references across exactly nine tokens, and **zero** legacy `var(--*-hex)` names
  (§3.2). Re-theming the page is redefining nine triplets in a scope.
- **The palette must be scoped, and can be.** Those nine tokens are global. `App.jsx` returns
  *either* `BrowserPage` *or* `ViewerApp` — never both — so a root-level attribute is sufficient
  and survives Radix portals (§4.2).
- **`name` already opens on click.** `browserColumns.jsx:72` wraps the thumbnail and the label in
  a `<button onClick={() => onOpen(r)}>`. The redesign preserves this; it does not introduce it.
- **Folders must lead the sort in both directions.** `foldersFirst` in `browseUtils.js` already
  does this and is covered by the 37 existing test cases.

---

## 2. Open-source survey (per the standing harvest rule)

Token values below were read out of shipped production CSS, not recalled. Pathology references
were captured from live pages. Cytomine and caMicroscope were unreachable and contributed nothing.

### 2.1 The table — Radix Themes 3.2.1 (MIT)

The mechanism worth taking verbatim is **the divider**:

```css
--table-row-box-shadow: inset 0 -1px var(--gray-a5);
.rt-TableCell { box-shadow: var(--table-row-box-shadow); }
tbody tr:last-child { --table-row-box-shadow: none; }
```

A divider drawn as an inset shadow on the cell adds no layout height, does not fight
`border-collapse`, survives a sticky header, and switches off for the last row by flipping one
variable. `border-bottom` on the row does none of these. Radix ships **no row hover state at all**
— that is left to the consuming app, which is where our own hover and selection rules belong.

Also taken: the 12-step scale discipline (a component is written against step *numbers*, so it
works across hues and both themes) and the space scale `4 · 8 · 12 · 16 · 24 · 32 · 40 · 48 · 64`,
which deliberately skips 20 and 28.

### 2.2 The header — Vercel Geist (measured live on `vercel.com/geist/table`)

`th` is **36px tall, `text-transform: none`, `letter-spacing: normal`, weight 500, 14px** — the
same size as the body, differentiated by weight and colour alone.

Our current header is `32px / 11px / uppercase / letter-spacing: .04em` (`browser.css:167-175`).
That combination is the single fastest way to date a table, and we have it.

### 2.3 Status encoding — PathAI AISight, as a counter-example

One screenshot carries both the right answer and the wrong one: a soft-tint amber chip
(`#FFEFB7` fill, `#AB7E26` text) reads calmly, while a solid saturated purple (`#5D22A1`, white
text) in the same row shouts and flattens the hierarchy. Their **vertical grid rules** are the most
dated artifact in the entire survey.

Our chips are the soft-tint form: ~12% of the semantic hue mixed onto whichever surface the theme
uses, with the full-strength hue as the text, no border.

### 2.4 Layout and behaviour — OHIF Viewer v3 (MIT, already vendored here)

Its StudyList is architecturally the same page: toolbar, dense table, resizable right preview,
TanStack Table underneath, shadcn/Radix components. Two things are worth taking literally:

- **The filter row is a real `<tr>` directly under the header**, not a floating bar — filters sit
  under the column they filter (`platform/ui-next/src/components/StudyList/`).
- **`meta.priority` + `useResponsiveColumns`** — an integer per column, and columns drop by
  priority as width shrinks. We have seven columns and a 1280px laptop case (§4.4).

The preview-pane recipe in D14 is also theirs.

**One thing to avoid, learned from upstream:** OHIF's `.dark` block leaves `--success-bg`,
`--warning-bg` and `--error-text` at their *light* values — the semantic pairs were never
re-derived. A light-canonical design with a derived dark must derive the semantic pairs too, not
only the neutrals.

### 2.5 Typography and elevation — Linear, Attio, Stripe

- **Linear** ships weights **300 / 400 / 510 / 590 / 680** — deliberately off the 100-step grid —
  with Inter's `cv01`/`ss03` and `opsz auto`. Its light ink is `#282a30`, a desaturated slate, and
  its neutrals carry a faint mauve. Nothing is pure grey and nothing is pure black.
- **Attio's shadow ladder** is the copyable maths: y and blur double per step, spread is always
  −½ blur, alpha climbs 1% per step, **ceiling 7%**.
- **Stripe** tints every neutral toward the brand blue *including the alpha overlays*, so the UI
  never has a "grey part". Graphite takes the opposite, equally committed position: strictly
  achromatic (§4.1). The rule both obey is *commit* — grey in some places and blue-grey in others
  reads as unfinished.

### 2.6 Not adopted, and why

| Candidate | Verdict |
|---|---|
| Radix **Themes** (the component library) | **Do not mix.** 88 KB gzip CSS, and its rules are `.rt-Button:where(...)` at specificity (0,1,0) — the same as a Tailwind utility. Ties are broken by bundle order, which changes with the import graph. `twMerge` does not help; it only reconciles Tailwind classes with each other. |
| `radix-ui` unified package | **No.** shadcn's v3-compatible tree (`styles/new-york`) imports the *split* packages; only `new-york-v4` uses the unified one. Installing both is the one combination that genuinely duplicates primitives. |
| `vaul` | **No.** README: *"This repo is unmaintained."* Open issues #497 and #482 hit desktop usage and portal composition directly. |
| Proscia's warm `#F5F1EF` canvas | **Not in Graphite** — it is direction B, which was not selected. Recorded because the claim circulating with it, that a cool canvas gives H&E thumbnails a green cast, is **not sound**: green is magenta's complement, so a magenta surround induces green in a neutral, not the reverse. The warm canvas is a taste position with a real precedent, not a colour-science result. |

---

## 3. What exists today (measured, 2026-08-02)

### 3.1 Files in scope

| | Files | Lines |
|---|---|---|
| `src/components/browser/` | 10 | 1586 |
| `src/components/ui/*.tsx` | 8 | 632 |
| `src/styles/browser.css` | 1 | 344 |
| `src/styles/index.css` | 1 | 2123 |

Largest in `browser/`: `ImportModal` 362, `BrowserPage` 328, `browseUtils.test.js` 252,
`browseUtils` 156, `browserColumns` 119, `NewEntryDialog` 90, `PreviewPane` 86, `BrowserToolbar`
74, `BrowserTopBar` 70, `SlideThumb` 49.

### 3.2 The colour contract, counted

`browser.css` uses exactly **nine** tokens across **56** call sites, and no legacy names:

```
15  hsl(var(--muted-foreground))     4  hsl(var(--card))
11  hsl(var(--border))               4  hsl(var(--accent))
10  hsl(var(--foreground))           2  hsl(var(--ring))
 6  hsl(var(--background))           2  hsl(var(--primary))
                                     1  hsl(var(--primary-foreground))
```

Elsewhere in `src/`, the legacy hex names still carry ~852 references —
`--muted-hex` 296, `--border-hex` 224, `--text` 103, `--accent-hex` 77, `--bg-panel` 53, `--bg` 44,
`--highlight-hex` 30, `--bg-toolbar` 8, `--danger` 8, `--bg-sidebar` 5, `--success` 4. **None of
them are in `browser/`.** This is what makes D1's boundary cheap rather than aspirational.

**Two dead mechanisms, found on the way:**

- **The `dsa.*` palette** in `tailwind.config.js` — 15 lines defining `dsa.bg`, `dsa.panel`,
  `dsa.accent` and nine more — has **zero references** anywhere in `src/` or `index.html`.
- **`data-theme`** is written to `document.documentElement` on every page load
  (`index.html:9-13`, defaulting to `'he'`) and is **read by nothing** — no CSS selector, no JS.
  Its name must not be reused for the surface scope in §4.2, or a dead attribute becomes a
  confusing live one.

### 3.3 Current density, measured

```
topbar 52px · toolbar 42px · search 30px
thead th  32px / 11px / UPPERCASE / letter-spacing .04em
tbody td  44px · body 12.5px
thumbnail 40×40 · radius 3px · object-fit: cover     ← 40 inside 44 leaves 2px
divider   1px solid hsl(var(--border) / .4)
preview   260px fixed · padding 14px
status    7px dot + text
```

### 3.4 Typography does not currently load on a hospital deployment

The Google Fonts CDN is requested **twice**:

```
index.html:15-17          preconnect ×2 + <link rel=stylesheet>
src/styles/index.css:1    @import url(...)          ← the same IBM Plex families
```

On an air-gapped deployment both fail silently and every surface falls back to `system-ui`. The
tuned typography has, in that environment, never rendered.

### 3.5 The data, as it actually is

Read from the live Girder at `localhost:9080`:

- **6 collections, 391 GB.** BRCA-DEMO 17 GB · MDA 96.9 GB · TCGA-BRCA 248 GB · TCGA-NSCLC 28.6 GB
  · Penn Pathology (40 empty case folders, `PENN-2026-0001…0040`) · Tasks.
- **The tree is shallow.** Most collections hold one folder. D12 is a bet on the schema, not on
  today's contents.
- **Aspect ratios run 0.62 : 1 to 4.33 : 1**, median 1.66. The thumbnail endpoint preserves the
  native ratio — `?width=256` returns `256×59` for a 4.33 : 1 slide, and adding `&height=256` does
  not pad it.
- **Magnification is 20× and 40×; `mm_x` ≈ 0.00025** (0.25 µm/px). Not every slide has it: the
  14 MDA `.tiff` files are slides with `largeImage` and a thumbnail but **no recorded
  magnification**. An empty `Scan` cell must say `not recorded`, not `not a slide`.
- **Every one of the 82 sampled slides has `meta.status` absent.** The triage vocabulary
  (`New / In Review / Read / Flagged`, `browseUtils.js:15`) exists and is unused. There is no
  assignment concept on slides at all; `assignee` exists only on Projects, as free text.
- **Folders report `nItems: null`** — Girder has not computed counts. `—` is the true rendering.

### 3.6 Three defects the redesign will sit on top of

Not caused by it, not fixed by it, and each cheap to state:

| | |
|---|---|
| Truncation | `getItems(folder._id, 0, 500)` (`BrowserPage.jsx:96`) is a hard cap. TCGA-BRCA holds 942 slides; from the 501st on they do not exist as far as the UI is concerned. |
| Virtualisation | None anywhere. `@tanstack/react-virtual` is not installed. A 56px row makes this *more* pressing than a 44px one. |
| Dialogs | The hand-written modals carry `role="dialog"` and `aria-modal` but have no focus trap, no focus restore, no portal and no scroll lock. |

---

## 4. The token layer

### 4.1 Graphite, both themes

Light is authored; dark is derived from it and then tuned — including the semantic pairs, per the
warning in §2.4.

| Role | Light | Dark |
|---|---|---|
| `--canvas` | `#FAFAFA` | `#0B0B0C` |
| `--surface` | `#FFFFFF` | `#141416` |
| `--surface-2` (rails) | `#FAFAFA` | `#0F0F11` |
| `--sunken` (thumbnail bed, inputs) | `#F4F4F5` | `#1B1B1E` |
| `--line` (dividers) | `rgba(0,0,0,.06)` | `rgba(255,255,255,.07)` |
| `--line-2` (containers) | `rgba(0,0,0,.10)` | `rgba(255,255,255,.12)` |
| `--ink` | `#18181B` | `#ECECEE` |
| `--ink-2` | `#6B6E76` | `#9B9BA3` |
| `--ink-3` | `#9D9DA6` | `#6A6A73` |
| `--brand` (default; deploy-overridable) | `#5B5BD6` | `#8A8AF5` |
| `--hover` | `rgba(0,0,0,.03)` | `rgba(255,255,255,.035)` |
| `--wash` (selected) | `brand @ 9%` | `brand @ 14%` |

Semantic hues are one set, mixed onto whichever surface is current so they never need a per-theme
fill value:

```css
--sem-read: #15803d;  --sem-review: #b45309;  --sem-flag: #be123c;
.chip[data-s="Read"] { background: color-mix(in oklab, var(--sem-read) 13%, var(--surface)); }
```

Dark raises the mix to ~22% and lifts the text to the light counterpart of the hue.

Scales: radius `4 / 6 / 8 / 12`; spacing `4 · 8 · 12 · 16 · 24 · 32 · 40 · 48`; elevation two
steps, each opening with a `0 0 0 1px` ring, ceiling 7%; motion 120ms for hover and press, 240ms
for layout.

### 4.2 Scoping — the one structural decision

`browser.css` and the vendored `ui/*.tsx` read the shadcn names (`--background`, `--foreground`,
`--border`, …). Graphite must supply *those names* — otherwise every vendored component needs
editing, which defeats the point of vendoring.

**Proposal.** `BrowserPage` sets a surface attribute on `document.documentElement` on mount and
clears it on unmount; the Graphite block is defined under that attribute and maps the shadcn names
onto the Graphite roles.

```css
:root[data-surface="browser"] {
  --background: 0 0% 98%;      /* → --canvas  */
  --card:       0 0% 100%;     /* → --surface */
  --border:     0 0% 0% / …    /* etc.        */
}
:root[data-surface="browser"][data-mode="dark"] { … }
```

Three reasons this is the right shape rather than a class on `.browser-shell`:

1. **Radix portals escape a component-scoped class.** `DropdownMenuContent` renders into
   `document.body`; a variable defined on `.browser-shell` does not reach it. Defined on
   `:root`, it does.
2. **The pages are mutually exclusive.** `App.jsx:80-86` returns `BrowserPage` *or* `ViewerApp`,
   never both, so a document-level attribute cannot collide with a Viewer that is on screen.
3. **It leaves the Viewer's palette literally untouched** — the base `:root` block is not edited,
   so D1's promise is enforced by construction rather than by care.

**Naming constraint:** not `data-theme`. That attribute is already written on every page load and
read by nothing (§3.2); reusing the name would turn a harmless corpse into a live ambiguity.
`data-surface` and `data-mode` are proposed; the mode attribute is what the light/dark switch
writes.

**Open question for sign-off:** whether the dead `data-theme` bootstrap and the dead `dsa.*`
palette get deleted in this increment or in a separate tidy-up. They are 15 lines and 6 lines
respectively and nothing reads either. Recommendation: delete them here, in their own commit,
because leaving two dead colour mechanisms next to a new one is how the third gets written.

### 4.3 Typography

Self-hosted, latin subset, variable where available, **no CDN**:

| Role | Family | Licence | Weights |
|---|---|---|---|
| UI | **Inter Variable** | OFL-1.1 | 440 / 510 / 590, `cv01` `ss03`, `opsz auto` |
| Identifiers, measurements, counts | **JetBrains Mono Variable** | OFL-1.1 | 400 / 500, `tabular-nums` |

Both `index.html:15-17` and `src/styles/index.css:1` lose their Google Fonts requests. IBM Plex
stays reachable for the surfaces this increment does not touch — it is the incumbent for the
Viewer and panels and they are out of scope — so the self-hosted set is **Inter + JetBrains Mono +
IBM Plex Sans + IBM Plex Mono**, **151 KB** total as latin-subset woff2 (48.3 + 30.7 + 44.6 + 28.9,
measured).

Ship via `@fontsource-variable/*` or as files under `public/fonts/` with hand-written
`@font-face`. **Either way the `@font-face` block and the consuming CSS land in the same commit.**
A partial execution on 2026-08-02 downloaded five woff2 files into `public/fonts/` and wired
none of them, leaving orphans while both CDN requests stayed in place; those files were removed
and the tree restored to `aa7a5c7`.

### 4.4 Density and the column set

```
topbar 56px · toolbar 48px
thead th  48px / 13px / sentence case / weight 510 / --ink-2
tbody td  56px · body 14px / 20px / tracking −.011em
thumbnail 40×40 · radius 4px · object-fit: contain · on --sunken
divider   box-shadow: inset 0 -1px var(--line)      ← not border-bottom
preview   320px default · draggable · clamp 15–50% · collapsible · persisted
status    soft-tint chip, 22px, radius 4px
```

Columns: `☐ · thumbnail+Name · Status · Scan · Size · Updated`, with `Diagnosis`, `Folder` and
`Collection` staying available and hidden by default, as now. `Scan` renders `40× · 0.25 µm`;
its empty states are `` (folder), `not recorded` (slide without magnification) and `not a slide`
(a non-slide item — three exist in the snapshot: `cellpose_test.anot` in TCGA-NSCLC/slides, an
extensionless `TCGA-A1-A0SI-…` sibling in TCGA-BRCA/slides, and `cellpose_nuclei` in Tasks).

At 1280px the tree (240) plus preview (320) leave 720px for the table. OHIF's `priority` integer
(§2.4) is the mechanism for deciding what drops first; assigning the integers is a ticket-level
decision, not a design one.

---

## 5. Component structure after the change

```
src/components/browser/
  BrowserPage.jsx        ← wires the tree, the view switch and the resizable preview
  BrowserTopBar.jsx      ← unchanged in structure; re-themed
  BrowserToolbar.jsx     ← gains the table/grid segmented control
  browserColumns.jsx     ← Scan column; status dot → chip; thumbnail cover → contain
  PreviewPane.jsx        ← Scan/Resolution/Dimensions/Aspect/Levels; actions unchanged
  SlideThumb.jsx         ← contain, --sunken bed
  browseUtils.js         ← unchanged. 37 tests must stay green untouched.
  ImportModal.jsx        ← re-themed only
  NewEntryDialog.jsx     ← re-themed only
+ CollectionTree.jsx     ← new · expandable to folder level, lazy children
+ SlideGrid.jsx          ← new · contain cards, 4:3 frame
+ usePreviewResize.js    ← new · pointer drag, clamp, persistence
```

`browseUtils.js` not changing is deliberate: it holds the row model, the filters and
`foldersFirst`, all of which the redesign keeps. The 37 existing cases are the regression net for
everything the visual layer sits on.

---

## 6. Phases

Each phase is independently reviewable and leaves the app working.

| | Phase | Content |
|---|---|---|
| **6a** | Fonts | Self-host Inter + JetBrains Mono + IBM Plex; delete both CDN requests. `@font-face` and consumers in one commit. No visual change intended — this is the precondition, and its own commit so a regression here is unambiguous. |
| **6b** | Token layer | `data-surface` / `data-mode` scoping, the Graphite blocks, the semantic `color-mix` chips, the light/dark switch. Optionally the deletion of the two dead mechanisms (§4.2). Landing page changes colour; nothing else does. |
| **6c** | The table | `browser.css` against the new tokens; row 56px; header sentence-case; inset-shadow dividers; `contain` thumbnails; status chip; `Scan` column. |
| **6d** | The new structure | `CollectionTree`, `SlideGrid`, `usePreviewResize`, and the `BrowserPage` / `BrowserToolbar` wiring that hosts them. |
| **6e** | Verification | §7. |

---

## 7. Verification

- `npm test` — 37 `browseUtils` cases green **without edits**. A test that needs changing means
  the row model moved, which this increment says it does not.
- `npm run build` and `npm run typecheck` clean.
- A real browser pass on the **DEMO slide's collection** and on **TCGA-BRCA/slides**, the latter
  because it carries the 4.33 : 1 strips that justify D15 and the 942-row truncation of §3.6.
- Both themes, at 1440px and 1280px.
- **Air-gapped font check** — load with the network throttled to offline after first paint, or
  with `fonts.googleapis.com` blocked, and confirm Inter still renders. This is the one check that
  would have caught §3.4 at any point in the last year and never ran.
- The white-label check: override `--brand` and confirm nothing outside it changes hue.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| The scoping attribute leaks — a Viewer surface renders while `data-surface="browser"` is set | Set on mount, cleared on unmount, and asserted in the browser pass by navigating browse → viewer → browse. `App.jsx`'s either/or return makes the leak a lifecycle bug rather than a design flaw. |
| 56px rows make the missing virtualisation hurt sooner | Out of scope but stated (§3.6). If it bites during 6c, `@tanstack/react-virtual` is 7.2 KB gzip and additive. |
| Vendored `ui/*.tsx` drift from upstream OHIF | The token names are unchanged; only their values move. A re-sync stays a diff. |
| Two colour contracts become three | §4.2's recommendation to delete the dead `dsa.*` scale and the dead `data-theme` bootstrap in this increment. |
| Dark ships underdesigned | D2 was taken against advice. Mitigation is D3: light is authored, dark derives from a structure that already works, and the semantic pairs are re-derived rather than inherited (§2.4). |

---

## 9. Out of scope

- **The Viewer, the panels, the sidebar, Projects, Second Opinion, the share and portal pages.**
  They keep the OHIF palette. The ~852 legacy call sites are untouched.
- **The 500-item cap, row virtualisation, and the modal focus-trap gap** (§3.6). Each is a real
  defect with an independent fix; folding them in would make this increment unbounded.
- **`lucide-react` `^0.400.0` → `1.28.0`.** A major version bump belongs in its own change.
- **Directions B and C.** Retained in the demo file as the record of what was compared.
- **Any worklist, assignment or AI-coverage surface** (D5).

---

## 10. Status

Plan only. No code written. The tree is at `aa7a5c7` with `git diff` empty; the sole untracked
addition is the demo file this document refers to.

Sign-off needed on: §4.2's attribute naming and whether the two dead mechanisms die here, and
§6's phase boundaries. Tickets get cut from §6 after sign-off, one file per phase under
`.scratch/browser-redesign-graphite/issues/`, per `docs/agents/issue-tracker.md`.
