# PathAgent Gateway (M0)

Backend for the PathAssist "PathAgent" WSI-agent copilot. See the design at
`docs/Chen/2026-07-06-wsi-agents-integration-plan.md`. This milestone (M0) ships the API contract,
job queue, auth passthrough, and a **fake** preprocessor. Plan 2 (M1) replaces it with Trident.

## Run locally
```bash
uv sync
uv run uvicorn pathagent.gateway.app:create_app --factory --reload    # terminal 1
uv run rq worker pathagent                                            # terminal 2 (needs Redis)
```

## Or with Docker
```bash
docker compose up --build
```

## Endpoints (`/api/agent`)
- `POST /cases/{itemId}/preprocess` — enqueue background preprocessing; returns `{jobId, cacheKey, status}`.
- `GET  /cases/{itemId}/status?cacheKey=...` — job status + `ready` flags.
- `POST /query` — **stub** SSE stream (route/triage/navigate/final); real orchestrator in Plan 4.
- `GET  /cases/{itemId}/heatmap/{taskId}` — **stub**; real tiles in Plan 4.

All calls require a `Girder-Token` header, validated against Girder `/user/me`.

## Frontend / deployment wiring (later plans)
- nginx: proxy `/api/agent` → this service (mirrors the existing `/api/llm`, `/api/brca`).
- Frontend reads the base URL from `VITE_AGENT_API_URL` (Plan 5).

## Tests
```bash
uv run pytest -q
```
