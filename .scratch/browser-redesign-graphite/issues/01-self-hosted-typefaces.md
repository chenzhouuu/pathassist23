# 01 — Self-hosted typefaces, both CDN requests gone

**What to build:** with the network unavailable — an air-gapped hospital deployment, or DevTools
set to offline — the application still renders its own typefaces on every surface. Today it does
not: the Google Fonts CDN is requested twice and both requests fail silently, so the tuned
typography has, in that environment, never rendered at all.

This ticket moves where the fonts come from, not which fonts are used. Nothing is meant to look
different on a machine that has internet.

Inter and JetBrains Mono are pulled in here even though nothing consumes them yet — they are what
05 onward are specified against, and a later ticket that has to add a font *and* use it cannot
tell a loading regression from a design one.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Inter (variable), JetBrains Mono (variable), IBM Plex Sans (variable) and IBM Plex Mono
      400/500 ship inside the repo as latin-subset `woff2`, ≈151 KB in total. All four are SIL OFL.
- [ ] Both Google Fonts requests are gone: the `preconnect` pair and the stylesheet `<link>` in
      `index.html`, and the `@import url(...)` on the first line of `src/styles/index.css`.
- [ ] The `@font-face` block and every rule that consumes it land in the same commit. No commit
      exists in which font files are present but unreferenced, or referenced but absent.
- [ ] With the network blocked after a hard reload, the computed `font-family` on the landing page
      and on a Viewer panel resolves to a self-hosted family, not to a system fallback.
- [ ] `npm run build` succeeds and the font files are emitted into the build output.
- [ ] No visual change is intended anywhere. Screenshots of the landing page and the Viewer before
      and after differ only by antialiasing.

## Notes

A partial execution on 2026-08-02 left five orphan `woff2` files under `public/fonts/` with both
CDN requests still in place and nothing referencing them. Those were deleted and the tree restored
to `aa7a5c7`. Whichever delivery mechanism this ticket picks — `@fontsource-variable/*` packages or
hand-written `@font-face` over files in `public/` — the third acceptance criterion is what stops
that state from recurring.
