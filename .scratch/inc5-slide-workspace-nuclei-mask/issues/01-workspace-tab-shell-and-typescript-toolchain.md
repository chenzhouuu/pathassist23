# 01 — Workspace tab shell and the TypeScript toolchain

**What to build:** A new **Workspace** tab in the viewer's right panel (ai-users), which opens onto an
empty-state panel drawn with UI primitives vendored from OHIF as real TypeScript components. Nothing
is listed yet and no backend changes. The deliverable is that a `.tsx` component from another project
renders inside this app, in the tab it will live in, without breaking anything that already works.

This is the increment's risk isolation point (plan R1): TypeScript, Radix and i18next enter a repo
that has none of them. It lands alone so it can be reverted alone.

**Blocked by:** None — can start immediately. (Plan Phase 0 landed in `5d218a4`.)

**Status:** ready-for-agent

- [ ] The right panel shows a Workspace tab; opening it renders an empty-state panel built from
      vendored OHIF primitives, not from hand-written equivalents.
- [ ] Vendored files stay TypeScript and keep OHIF's structure (decision D6); each carries a header
      naming its origin file, the OHIF commit and the MIT notice.
- [ ] `npm run build` succeeds and the existing vitest suite passes.
- [ ] All ten existing tabs render and behave exactly as before; the shadcn CSS variables added for
      the vendored components change no existing panel's appearance (spot-check Preprocess, Tissue,
      Markers side by side with `main`).
- [ ] Reverting this ticket alone leaves a working repo — it touches no service and no store slice.
