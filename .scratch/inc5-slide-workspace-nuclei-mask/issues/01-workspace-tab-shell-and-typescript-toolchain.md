# 01 — Workspace tab shell and the TypeScript toolchain

**What to build:** A new **Workspace** tab in the viewer's right panel (ai-users), which opens onto an
empty-state panel drawn with UI primitives vendored from OHIF as real TypeScript components. Nothing
is listed yet and no backend changes. The deliverable is that a `.tsx` component from another project
renders inside this app, in the tab it will live in, without breaking anything that already works.

This is the increment's risk isolation point (plan R1): TypeScript, Radix and i18next enter a repo
that has none of them. It lands alone so it can be reverted alone.

**Blocked by:** None — can start immediately. (Plan Phase 0 landed in `5d218a4`.)

**Status:** done

- [x] The right panel shows a Workspace tab; opening it renders an empty-state panel built from
      vendored OHIF primitives, not from hand-written equivalents.
- [x] Vendored files stay TypeScript and keep OHIF's structure (decision D6); each carries a header
      naming its origin file, the OHIF commit and the MIT notice.
- [x] `npm run build` succeeds and the existing vitest suite passes.
- [x] All ten existing tabs render and behave exactly as before; the shadcn CSS variables added for
      the vendored components change no existing panel's appearance (spot-check Preprocess, Tissue,
      Markers side by side with `main`).
- [x] Reverting this ticket alone leaves a working repo — it touches no service and no store slice.

## Comments

The premise was stale by the time the ticket was worked. TypeScript, Radix, the `@` alias, the
`typecheck` script and four shadcn `.tsx` primitives all arrived with the slide browser
(`5d218a4`), and `src/styles/index.css` had already adopted OHIF's palette wholesale — explicitly
so vendored OHIF components need no translation layer. R1 was mostly retired before this ticket
started; what remained was making one real OHIF composite render.

Two OHIF theme names were missing rather than two colours: `secondary-dark` is `#041c4a`, which the
palette already holds as `--popover`, and `aqua-pale` is `#7bb2ce`, already `--muted-foreground`.
They are declared as aliases in `tailwind.config.js` so the vendored files keep upstream's class
strings unedited. Ticket 02's larger file set should extend that table rather than edit classes.

Verified: 208 tests green (6 new), `typecheck` and `build` clean, the four utilities present in the
built CSS resolving to the palette, and the tab clicked through in the running app by Chen.
