# The landing page, round two — a framed shell and the details Graphite missed

**Date:** 2026-08-03 · **Branch:** `feature/frontend-redesign` · **Base:** `dc92167`
**Predecessor:** `2026-08-02-browser-redesign-graphite-design.md` (nineteen decisions, ten tickets,
all shipped)
**Evaluation surface:** `2026-08-03-browser-shell-demo.html` — real Girder data, D1 vs D2 vs today

The Graphite redesign changed the landing page's colour. This one changes its *shape*: the page
stops being four square regions divided by opaque grey lines and becomes a logo band over a single
rounded frame. It also closes fifteen details the evaluated prototype specified and the
implementation never got, and it cleans up the eight competing corner radii that accumulated
underneath all of it.

---

## 1. What was decided, and by whom

Selected from the live demo on 2026-08-03, in this order:

| | |
|---|---|
| **Framing** | **D2** — a full-width logo band with a rule under it; below the rule, **one** rounded frame containing the rail, the table and the preview. The rail is separated from the table by a hairline, not a gutter. |
| **Radius** | 12px |
| **Canvas** | Pushed down off white so the frame can sit above it |
| **Logo** | 36px, in a band whose height follows it |
| **Top band** | No search. Application-level settings: theme switch, settings, help, account |
| **Scope** | Everything — the shell, the square frames, the fifteen gaps, the modern-practice items |
| **Dialogs** | Full depth, including `SharePatientModal`'s internals |

The brief that produced D2, verbatim: *"不要有很明显的直角的框 · 有些 section 可以没有框 · logo 那个
column 需要横线和下面的 card 分开 · 不要放 search 栏而应该放其他设置 · logo 可以大一点 · logo 横线之后
一个大的框"*.

The one ambiguity — whether "one big frame" encloses the rail — was resolved by building both and
looking. D1 (rail outside, Linear's own arrangement) was rejected in favour of D2.

---

## 2. The evidence

Gathered on 2026-08-03 by three parallel surveys. Everything below was **read out of shipped code or
measured**; where a number is estimated it says so.

### 2.1 Linear ships exactly this, and its numbers are readable

From the shell CSS inlined at `linear.app/login` — the real SPA shell, not the marketing site:

```css
#appBorders{
  border: 1px solid var(--bg-border-color);
  background-color: var(--bg-base-color);
  margin: 8px;  margin-left: var(--sidebar-width);   /* 244px */
  border-radius: 12px;
}
@media (min-device-pixel-ratio:2){ #appBorders{ border-width:.5px } }
@media screen and (max-width:1023px){ #appBorders{ margin:-1px } }
```

Corroborated by the shipped constants module `pageSizes.stylex.js`:
`{mainPageMargin: 8, mainContentBorderRadius: 12, …}`. Computed styles at 1440×900: card `#f9f9fa`,
canvas `#efeff0`, border `#e2e2e2`, and **`box-shadow: none`**.

Three properties are worth naming because each is a decision we are copying:

1. **The card is lighter than the canvas.** Canvas 6.14% down from white, card 2.22%. Neither is
   pure white. That headroom is what lets a frameless region read as a region.
2. **Border plus colour step plus gutter, and no shadow.** Linear spends three separation cues and
   skips the fourth. Dub, at a 10.2% canvas, ships neither border nor shadow. The rule across
   everyone who does this: *the darker the canvas, the less border you need.*
3. **`0.5px` on retina.** Linear's `#e2e2e2` is nominally *heavier* than our `#e5e5e5` (11.4% vs
   10.2%) and reads as a whisper because it is halved on every modern display. Campsite reaches the
   same lever independently (`borderWidth.DEFAULT: '0.5px'`).

`grep 'border-right'` across Linear's 440 KB app stylesheet returns **zero matches** — the sidebar
genuinely has no frame.

### 2.2 The honest counter-evidence

A framed content region is a **minority** pattern.

| Framed, floating | Flush, edge to edge |
|---|---|
| Linear, shadcn `dashboard-01`, Dub, Catalyst | Notion, Stripe, Figma, Cursor, Campsite, **Attio**, Supabase, Cal.com, PostHog |

Attio is the sharpest counter-example and was measured too: frameless sidebar (like Linear), but
content **flush, square, no gutter, no rounding anywhere**. Sidebar `#fbfbfb` / content `#ffffff` /
divider `#eeeff1` — matching its shipped tokens `--x184v5i4` and `--x1ir7zyd` literally.

Raycast turned out to be native-only (`manual.raycast.com/llms.txt` states it) and contributed
nothing. Height shut down on 2025-09-24 and its domain no longer completes a TLS handshake.

This is recorded so the choice reads as a choice.

### 2.3 The sticky-header trap, browser-verified

`overflow: hidden` on a rounded ancestor makes that ancestor a **scroll container**, and
`position: sticky` then sticks to a box that never scrolls — the header silently slides away. Six
variants were rendered in Chrome to establish this:

| | Setup | Result |
|---|---|---|
| A | `border-radius` + `overflow-y:auto` on the **same** element | ✅ works, corners clipped |
| B | rounded `overflow:hidden` wrapper › inner scroller **with height** | ✅ |
| C | rounded `overflow:hidden` wrapper › inner `overflow-x:auto`, no height | ❌ **header scrolls away** |
| D | rounded `overflow:clip` wrapper › inner scroller | ✅ |
| E | divider as `border-bottom` on a sticky `th` | ⚠️ **border vanishes entirely** |
| F | sticky `th` with a transparent background | ⚠️ rows show through |

C is stock shadcn's shape — its `Table` hardcodes `<div className="relative w-full overflow-x-auto">`
with no className passthrough ([shadcn-ui/ui#3965](https://github.com/shadcn-ui/ui/issues/3965)).
Radix Themes has the same problem from the other direction: its `<table>` is itself the scroll
container, which is why [radix-ui/themes#767](https://github.com/radix-ui/themes/issues/767) is open.

E is not a Chrome quirk — [csswg-drafts#3136](https://github.com/w3c/csswg-drafts/issues/3136) is
still open, and Chrome's own TablesNG announcement warns about it. **The existing implementation
already draws every divider as `box-shadow: inset 0 -1px`**, so that decision, taken for other
reasons, is what keeps this from biting.

**Consequence for the build:** radius and scrolling go on the same element. Never wrap the table in
a rounded `overflow: hidden` div.

### 2.4 The row-hover reasoning was wrong

`_table.css` currently states: *"The row is not a click target for opening — it selects on click and
opens on double click — so it carries no hover fill."*

VS Code ships `workbench.list.openMode` with `enum: ['singleClick','doubleClick']` and **the hover
colour is identical in both modes**. The no-hover camp is entirely native-desktop lineage: AppKit's
`NSTableView.h` has zero occurrences of `hover`, and GTK4 Adwaita's `columnview.view` defines
`:selected` but no `:hover`. No shipped web product was found that suppresses row hover because of
double-click semantics.

Shipped hover values on white run #FAFAFA → #E8E8E8, median ≈ #F2F2F2 (VS Code Light Modern, on a
#F8F8F8 sidebar — a Δ6/255). Note that shadcn's own `hover:bg-muted/50` computes to #FAFAFA, which
on anything but pure white is invisible; do not copy it literally.

### 2.5 Selection is fill-versus-ring, not bar-versus-tint

A row can be checkbox-selected *and* the active preview row at once, and two background tints cannot
coexist. What ~15 codebases actually do: **a neutral fill for multi-select, an edge mark for
active**.

- **VS Code**: `list.activeSelectionBackground #E8E8E8` + `outline: 1px solid; outline-offset: -1px`
  for the focus ring. Microsoft moved *away* from a saturated blue fill to neutral grey plus a ring.
- **Thunderbird**: identical `outline-offset: -1px` conclusion, reached independently. Plus a detail
  worth stealing — `this.table.classList.toggle("multi-selected", selectedCount > 1)`: the active
  ring only renders when more than one row is selected, because with a single selection the two
  states coincide.
- **Roundcube** is the one shipped *table* with a left bar: `border-left: 2px` on the first cell,
  with `2px solid transparent` reserved on every row so nothing shifts. Its own source warns this
  breaks under `border-collapse: collapse`.
- **Primer ActionList** refuses the premise: `active` gets a 4px `::after` bar and semibold label,
  `selected` gets *only a checkmark* — different mechanisms, not different tints.

Widths actually shipped for an edge indicator: **2px and 4px. Nothing wider.**

### 2.6 Numeric alignment: quantitative vs categorical

Right-alignment is not dead, and `tabular-nums` did not replace it — current practice is both
together. Sentry's `usageTable.tsx` is the cleanest artifact: `CellStat` is
`font-variant-numeric: tabular-nums; justify-content: right`, and `CellProject` overrides it back to
left.

The rule that predicts real behaviour is AWS Cloudscape's: *right-align **quantitative** data;
left-align **categorical** numeric data (dates, postcodes, phone numbers)*. Applied here:

| Column | Alignment | Why |
|---|---|---|
| **Size** | right, tabular | quantitative — you scan the column to find the big slide |
| **Scan** (`40× · 0.25 µm`) | left, tabular | categorical — a handful of discrete values, nobody compares magnitudes |
| **Updated** | left, tabular | categorical — a date is a label |

This **diverges from the 2026-08-02 prototype**, which right-aligned Size and Updated together.

### 2.7 Empty cells: an em dash, and the systems disagree

Adobe Spectrum says en dash; Primer says leave it blank; Microsoft says use a word. There is no
convention to defer to. What **shipped code** does is an em dash (U+2014) at a muted token —
PostHog (`const EMPTY = '—'`), Documenso (`?? '—'`), Dub, Sentry. PostHog additionally distinguishes
"we don't know" (the word *Unknown*) from "not applicable" (the dash), which is the distinction that
actually matters and which the Scan column already makes.

The widely-repeated claim that screen readers announce "empty" for a blank cell **could not be
sourced** to W3C, WebAIM, Deque or TPGi, and a grep of 13 repos for a dash placeholder paired with
`sr-only`/`aria-hidden` returned zero matches. It is not being asserted here.

### 2.8 Loading: skeletons, and gate the animation

Carbon: *"If extra load time is expected … use skeleton states instead of spinners … on
container-based components … or data-based components like data tables."* MUI encodes the nuance —
`linear-progress` when rows are present, `skeleton` when the grid is empty.

Two recipes, opposite on accessibility: **shadcn's `Skeleton` is one line of `animate-pulse` and
does not respect `prefers-reduced-motion`** (Tailwind requires you to write `motion-safe:` yourself);
**Carbon ships the gate**. Primer varies its placeholder widths on a five-step cycle —
85 / 67.5 / 80 / 60 / 75% — so the block does not look stamped.

---

## 3. The palette

The canvas moves down and the card stops being white. The lightness ladder inverts relative to
today: the frame is now *above* the canvas rather than the canvas being nearly white already.

| | today | **new** | Linear |
|---|---|---|---|
| canvas, % down from white | 1.96% | **6.08%** | 6.14% |
| card, % down from white | 0.00% | **2.16%** | 2.22% |
| step between them | 1.96% | **3.92%** | 3.92% |

### Graphite roles

| Role | Light | Dark | Note |
|---|---|---|---|
| canvas | `#efeff0` | `#09090a` | |
| surface (the frame) | `#f9f9fa` | `#121213` | no longer pure white / no longer `#141416` |
| surface-2 | `#efeff0` | `#09090a` | = canvas; the rail is *inside* the frame now, so this name loses its old job |
| sunken | `#e6e6e8` | `#1b1b1e` | thumbnail bed, search well, view switch |
| line | `rgba(0,0,0,.055)` | `rgba(255,255,255,.065)` | row dividers, rail seam |
| line-2 | `rgba(0,0,0,.10)` | `rgba(255,255,255,.12)` | the frame's edge, container rings |
| ink | `#18181b` | `#ececee` | unchanged |
| ink-2 | `#65686f` | `#9b9ba3` | |
| ink-3 | `#94949d` | `#6a6a73` | |
| hover | `rgba(0,0,0,.035)` | `rgba(255,255,255,.04)` | Δ≈9/255 light — calibrated to the frame, not to white |
| sel (multi-select fill) | `rgba(0,0,0,.055)` | `rgba(255,255,255,.06)` | **new role** |
| brand | `#5b5bd6` | `#8a8af5` | unchanged |

Semantic hues, mix percentage and elevation steps are unchanged from 2026-08-02.

### The shadcn contract, restated

These are the roles above flattened, and they are what the vendored `ui/*.tsx` read. Computed, not
estimated:

| Token | Light | Dark |
|---|---|---|
| `--background` ← canvas | `240 3% 94%` | `240 5% 3.7%` |
| `--card` / `--popover` ← surface | `240 9% 98%` | `240 3% 7.3%` |
| `--secondary` / `--muted` ← sunken | `240 4% 91%` | `240 5% 11%` |
| `--muted-foreground` / `--neutral` ← ink-2 | `222 5% 42%` | `240 4% 62%` |
| `--border` / `--input` ← line-2 over surface | `240 2% 88%` | `240 1% 18%` |
| `--foreground` etc. ← ink | `240 6% 10%` | `240 6% 93%` |

**The alpha-free rule still holds**: Tailwind compiles `bg-primary/30` to `hsl(var(--primary) / .3)`,
so a triplet carrying its own alpha would produce invalid CSS and be dropped in silence.

---

## 4. The shell

```
┌────────────────────────────────────────────────────────────┐
│  ◈ LOGO 36px                    ☾   ⚙   ?  │  ◐ chen      │  band: logo + 28px, min 56
├────────────────────────────────────────────────────────────┤  ← inset 0 -1px line-2
│                                                            │
│   ╭──────────┬───────────────────────────┬──────────────╮  │  ← one frame, r12, 8px inset
│   │ rail     │ breadcrumb  [搜索] ⊞ ⚙ 新建 │              │  │
│   │          ├───────────────────────────┤   preview     │  │
│   │  BRCA    │ ▤ Name   Status  Scan  Size│               │  │
│   │  TCGA    │ ▤ …                        │               │  │
│   ╰──────────┴───────────────────────────┴──────────────╯  │
│      ↑ hairline seam            ↑ hairline + 9px grab       │
└────────────────────────────────────────────────────────────┘
```

**Geometry:** frame radius 12px · inset 8px on all four sides · edge `1px solid var(--line-2)`,
halving to `.5px` at `min-resolution: 192dpi` · **no shadow** · rail 236px · preview 320px default.

**Structure.** One flat CSS grid of five items plus a backing plate — nothing nests, so the frame is
a single element behind transparent regions rather than a wrapper that would create the
`overflow: hidden` scroll container of §2.3.

```
grid-template-columns: 236px minmax(0,1fr) 9px 320px;
grid-template-rows:    auto minmax(0,1fr);
grid-template-areas:   "top  top  top top"
                       "rail main rsz prev";
.plate  { grid-row: 2; grid-column: 1/5; margin: 8px }   /* the frame */
```

**Corner clipping.** The plate is behind; the regions over it are transparent, so only three things
can bleed past the radius, and each is handled on the element that scrolls: the rail takes
`border-radius: 12px 0 0 12px` (it has `overflow-y: auto` and no sticky child, so radius + scroll on
one element is safe), the preview takes `0 12px 12px 0`, and the table's sticky header shares the
frame's own background so its overflow is invisible.

**The seams inside the frame are hairlines, not gutters** — that is what makes it one frame rather
than three touching ones. The rail carries `inset -1px 0 var(--line)`; the resizer is a 9px grab
column painting a 1px line down its middle, widening to 2px in brand on hover and for the whole
drag.

**Below 1024px**, Linear's trick: the frame goes full-bleed by pushing its border and radius
off-screen with a negative margin, rather than maintaining a second layout.

**The logo band** is the only region outside the frame. It holds the brand at 36px and the settings
that belong to the application rather than to the level — theme switch, settings, help, account —
separated by a `vsep` hairline. Its height follows the logo (logo + 28px, floor 56px) so a larger
mark is never jammed against the rule.

**Search moved to the toolbar**, beside the status filter, because it searches the level the
breadcrumb names. It is a `--sunken` well with no border, widening 190 → 240px on focus.

---

## 5. The fifteen gaps

Everything the 2026-08-02 prototype specified that the implementation does not have. All fifteen are
in scope.

**Table**

| | Gap | Today |
|---|---|---|
| 1 | Sort direction glyph | Header text darkens only — **no direction is shown at all** |
| 2 | Numeric alignment | Everything left-aligned; `tabular-nums` wasted |
| 3 | Empty-value dash | Blank cell — "no value" and "no such column" look identical |
| 4 | Selected row's brand edge | Wash only |
| 5 | Row hover fill | Deliberately removed; §2.4 says the reason was wrong |
| 6 | `title` on truncated names | Absent in the table (the grid card has it) |

**Chrome**

| | Gap | Today |
|---|---|---|
| 7 | Search as a well | 30px, 1px border, canvas ground |
| 8 | Avatar as a soft tint | Solid brand fill — a second brand-filled element |
| 9 | Batch bar: brand wash, brand count, slide-down | Neutral grey, no emphasis, no motion |
| 10 | Status filter as a pill | Native `<select>` with a system border and arrow |
| 11 | Band heights 56 / 48 | 52 / 42 |
| 12 | Alpha hairlines | `border-bottom: 1px solid hsl(var(--border))` — opaque `#e5e5e5` |

**States**

| | Gap | Today |
|---|---|---|
| 13 | Table inset from its container | `.browser-table-wrap` has zero padding; the grid has it |
| 14 | Empty state icon | Two lines of text |
| 15 | Row/card entry motion | None — `browser/` has zero `@keyframes` and no `prefers-reduced-motion` |

Sort glyph, alignment, dash, selection and loading are built to §2.5–2.8 rather than to the
prototype where the two differ; those divergences are named in the tickets.

---

## 6. The square frames, inventoried

Full audit on 2026-08-03. **Twenty-two places draw the flat opaque `#e5e5e5` / `#2f2f31` line**: 7 in
the CSS partials, 1 vendored (`DropdownMenuContent`, at half alpha), 14 inline across the two legacy
dialogs.

**Seventeen elements have a visible boundary and no radius** — the top bar, toolbar and batch bar
(all three bordered and square), the rail, the preview's left edge, the sticky header band, the
selected row's two ends, all three dialog scrims, and `DropdownMenuSeparator`.

**Eight distinct radii render on the page**: 2 / 4 / 6 / 7 / 8 / 12 / 50% / 999px. Only 4, 6 and 8
come from the token scale. Two findings underneath that:

- **`--radius-4` (12px) is defined and referenced nowhere.** The largest step has never been used —
  and it is exactly the frame radius this redesign needs.
- **Tailwind's `borderRadius` config overrides only `lg`/`md`/`sm`, leaving `DEFAULT` at 4px.** So
  every `<Button>` without `.browser-quiet` renders at 4px, including "Open slide" — the page's one
  primary action — and both dialog buttons. **Editing `DEFAULT` in `tailwind.config.js` would repaint
  the Viewer too**, so this has to be answered inside the `data-surface` scope.

### The three dialogs disagree on everything

Only `NewEntryDialog` reads `_dialogs.css`. The other two are entirely inline.

| | scrim | z-index | panel radius | shadow |
|---|---|---|---|---|
| NewEntryDialog | `rgb(0 0 0 /.7)` | 60 | 6px | `--elev-2` |
| ImportModal | `rgba(0,0,0,.55)` + blur(4px) | **1000** | **4px literal** | hard-coded 64px plume |
| SharePatientModal | `rgba(0,0,0,.65)` | 50 | `rounded-xl` 12px | hard-coded 60px plume |

Four properties, three answers. They agree on exactly one thing: the heavy flat border.

Two further findings, both verified:

- **`.input-field` and `.btn-secondary` have zero definitions anywhere in the repo** and are used on
  8 lines of `ImportModal.jsx`. Every `<select>`, `<input>` and secondary button in the import
  dialog currently renders as **raw user-agent control chrome**. This is the single most literal
  instance of "an obvious square box" on the page, and the design system never authored it.
- **`SharePatientModal` carries 15 lines of pre-Graphite colour** — `#4da6ff`, `#4caf82`, `#e94560`,
  plus `text-gray-700` — all drawn for the Viewer's black ground and now sitting on a white panel.
  It has **exactly one importer** (`BrowserPage.jsx:34`); it is not a dual-surface component, so
  re-theming it carries no Viewer risk.
- **`src/components/share/ShareImageModal.jsx` (5.9 KB) has zero importers.** Dead.

---

## 7. Deliberately not in scope

Each is a real defect with an independent fix. Folding any in would make this unbounded.

- The 500-item query cap. TCGA-BRCA holds 942 slides.
- Row virtualisation — none exists anywhere, and a 56px row makes it more pressing, not less.
- Focus trap, focus restore, portal and scroll lock in the three dialogs. **Explicitly deferred**:
  the dialogs get a new skin, not new behaviour.
- The rail putting every node in the tab order (no roving tabindex) — ~168 tabs to cross Penn
  Pathology expanded.
- Row selection being mouse-only in both views.
- The preview staying mounted and fetching below the 1100px media query.
- `lucide-react` at `^0.400.0` against upstream `1.28.0`.
- The Viewer, panels, sidebar, Projects, Second Opinion and portal pages.
