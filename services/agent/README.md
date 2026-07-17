# services/agent — PathAgent v2 Copilot gateway

Greenfield conversational-copilot backend for PathAssist. Built incrementally behind
stable seams (see `docs/Chen/2026-07-17-pathagent-v2-incremental-build-ladder.md`).
Nothing here imports from `services/pathagent`; reusable pieces (Girder auth, SSE) are
ported, not shared.

**Base path:** `/api/copilot` (distinct from the older pathagent gateway at `/api/agent`).

## Increment 0 — walking skeleton

- `GET  /api/copilot/health` — unauthenticated liveness probe.
- `POST /api/copilot/echo` — requires a valid `Girder-Token`; streams the message back
  word-by-word as SSE `data:` frames (`start` → `token`… → `done`). DB-free smoke path.

## Increment 1 — conversations persist (Postgres)

Conversations + turns are stored in Postgres, scoped to `(Girder user, slide item)`.
All endpoints require a valid `Girder-Token`.

- `POST /api/copilot/conversations` — `{item_id?, title?}` → create a conversation.
- `GET  /api/copilot/conversations?item_id=<id>` — list the user's conversations for a slide.
- `GET  /api/copilot/conversations/{id}` — the conversation plus its `turns`.
- `POST /api/copilot/conversations/{id}/messages` — `{text}`; persists the user turn,
  streams the (echo) reply, persists the assistant turn. Same SSE contract as `/echo`.

The store sits behind a `ConversationStore` ABC (`src/agent/store/`); `PgStore` is the
Postgres impl, and tests inject an in-memory fake — so route tests need no database.

## Run it (container)

```bash
cd services/agent
docker compose up -d --build       # gateway :8010 + Postgres (adds asyncpg → rebuild)
```

The compose stack now includes a `db` (Postgres 16) service with a persistent
`copilot_pgdata` volume; the gateway waits for it via a healthcheck. The schema is
created on startup (`CREATE TABLE IF NOT EXISTS`).

The `./src` bind-mount + `--reload` means edits reload live.

**Important — `AGENT_GIRDER_BASE` must match the Girder your viewer is signed into**
(frontend `.env.local` → `VITE_GIRDER_BASE`); otherwise the token in the browser is
rejected here with a 401. Set it in a gitignored `services/agent/.env`:

```
AGENT_GIRDER_BASE=http://<your-girder-host>:<port>/api/v1
```

If that Girder runs on your host, the container reaches it via the host's LAN IP or
`host.docker.internal` (host-gateway is mapped in the compose file). After editing
`.env`, recreate the container: `docker compose up -d --force-recreate`.

## Run it (local, no Docker)

Needs a reachable Postgres — point `AGENT_DATABASE_URL` at it (e.g. one started with
`docker compose up -d db`, exposed on `localhost:5433` via the commented `ports:`):

```bash
cd services/agent
uv sync
AGENT_DATABASE_URL=postgresql://copilot:copilot@localhost:5433/copilot \
  uv run uvicorn agent.gateway.app:create_app --factory --port 8010 --reload
```

## Test

```bash
cd services/agent
uv run pytest -q
```

## Smoke-test by hand

```bash
curl -s localhost:8010/api/copilot/health
curl -sN -X POST localhost:8010/api/copilot/echo \
  -H 'Content-Type: application/json' -H "Girder-Token: $TOKEN" \
  -d '{"text":"hello from the copilot"}'
```

## Frontend

The viewer talks to this service from the **Copilot** tab (`src/components/panels/CopilotPanel.jsx`)
via `src/api/copilotApi.js`. In dev, Vite proxies `/api/copilot` → `http://localhost:8010`
(see `vite.config.js`); override with `VITE_COPILOT_PROXY_TARGET`.
