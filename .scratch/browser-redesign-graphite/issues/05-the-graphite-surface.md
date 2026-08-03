# 05 — The Graphite surface, scoped to the landing page

**What to build:** the landing page changes colour wholesale. Navigating to it shows Graphite in
light; a control switches it to Graphite in dark; opening a slide shows a Viewer whose palette is
identical to the one it has today.

This is the thinnest complete path through the redesign, and it is thin for a measured reason: the
landing page's stylesheet is already entirely on the shadcn token contract — 56 references across
exactly nine tokens, and not one legacy `var(--*-hex)` name. Re-theming the page is redefining
those nine triplets inside a scope. **No stylesheet rule and no component needs editing to make the
colour change happen.**

**Blocked by:** 02 (the namespace the scoping attribute lands in), 04 (the stylesheet structure the
later tickets build on).

**Status:** ready-for-agent

- [ ] A surface attribute is set on the document element while the landing page is mounted and
      cleared when it unmounts. It is **not** named `data-theme` — that name was occupied by the
      dead bootstrap 02 removed, and reusing it would be actively confusing. A second attribute
      carries light vs dark.
- [ ] The Graphite blocks are defined under those attributes and map the shadcn token names onto
      the Graphite roles below. The base `:root` block is **not edited** — that is what makes the
      Viewer's palette untouched by construction rather than by care.
- [ ] Scoping at the document element, not on the page's own container: Radix renders dropdown and
      tooltip content into a portal on `document.body`, which a container-scoped variable would not
      reach. The page and the Viewer are never mounted together, so a document-level attribute has
      nothing to collide with.
- [ ] A control on the page switches light and dark, and the choice persists across a reload.
- [ ] Semantic colours are re-derived for dark, not inherited. Upstream OHIF leaves its
      `--success-bg` / `--warning-bg` / `--error-text` at their light values inside `.dark`; a
      light-canonical design that derives its dark theme must not repeat that.
- [ ] `--brand` is a single token that a deployment can override. Overriding it changes the primary
      button, the selection wash, the focus ring, the avatar and the tree's active row — and
      nothing else shifts hue. The semantic colours do not follow it.
- [ ] Navigate browse → viewer → browse and confirm the Viewer renders in its own palette both
      times, and the landing page in Graphite both times.

## Token values

From the evaluated prototype, which is where these were judged. Light is authored; dark derives
from it and is then tuned.

| Role | Light | Dark |
|---|---|---|
| canvas | `#FAFAFA` | `#0B0B0C` |
| surface | `#FFFFFF` | `#141416` |
| surface-2 (rails) | `#FAFAFA` | `#0F0F11` |
| sunken (thumbnail bed, inputs) | `#F4F4F5` | `#1B1B1E` |
| line (dividers) | `rgba(0,0,0,.06)` | `rgba(255,255,255,.07)` |
| line-2 (containers) | `rgba(0,0,0,.10)` | `rgba(255,255,255,.12)` |
| ink | `#18181B` | `#ECECEE` |
| ink-2 | `#6B6E76` | `#9B9BA3` |
| ink-3 | `#9D9DA6` | `#6A6A73` |
| brand (default) | `#5B5BD6` | `#8A8AF5` |
| hover | `rgba(0,0,0,.03)` | `rgba(255,255,255,.035)` |
| wash (selected) | brand @ 9% | brand @ 14% |

Semantic hues are one set, mixed onto whichever surface is current, so a fill value never has to be
authored twice:

```css
--sem-read: #15803d;  --sem-review: #b45309;  --sem-flag: #be123c;
background: color-mix(in oklab, var(--sem-read) 13%, var(--surface));  /* dark: ~22% */
```

Scales, shared by everything downstream: radius `4 / 6 / 8 / 12`; spacing
`4 · 8 · 12 · 16 · 24 · 32 · 40 · 48` (20 and 28 deliberately absent); two elevation steps, each
opening with a `0 0 0 1px` ring, alpha ceiling 7%; motion 120ms for hover and press, 240ms for
layout. Type is Inter at 440 / 510 / 590 with `cv01`, `ss03` and `opsz auto`, and JetBrains Mono
for identifiers and measurements.
