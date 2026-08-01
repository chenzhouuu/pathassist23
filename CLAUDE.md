# PathAssist — Project Instructions

> Main instruction file for this project. Keep it short; add as we go.

## What this is
PathAssist / Impart DX — a React WSI (whole-slide image) pathology viewer on top of
Girder 5 / Digital Slide Archive, with an embedded AI layer.

## Tech stack
- React 18 + Vite + Tailwind CSS
- Zustand (state) · TanStack Query (data) · Axios (HTTP)
- OpenSeadragon (slide viewer)

## Commands
```bash
npm install      # install deps
npm run dev      # dev server → http://localhost:3000
npm run build    # production build → dist/
npm run preview  # preview the build
```

## Where things live
```
src/
├── api/          # Girder + AI API calls
├── components/   # UI (viewer, panels, sidebar, layout)
├── config/       # server URL, branding
├── store/        # Zustand global state
└── styles/       # Tailwind + theme
```

## Conventions
- Functional components + hooks only.
- Global state in `src/store/`; server data via TanStack Query.
- Styling with Tailwind utility classes.
- Config/secrets via `VITE_*` env vars in `.env.local` — **never commit secrets**.

## Notes
- More background: `docs/` (architecture, feature plans, project overview).

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature-slug>/` in this repo — no external
tracker. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root, both created lazily when there is
something real to record. See `docs/agents/domain.md`.
<!-- Add project-specific rules below as the project grows. -->
