# Inc 2b-1 + 2b-3 — Preprocess backend + `find_regions` (TDD plan, stub-first)

> **Implements** `2026-07-23-pathagent-v2-inc2b-trident-preprocess-design.md` (reviewed + amended).
> **Scope (committable, on-page-E2E-able):** the `services/preprocess/` worker (stub Trident seam),
> the `slide_index` control plane + gateway proxy routes, and the `find_regions` server tool wired to
> the existing Copilot panel. **Deferred:** the Preprocess *tab* (2b-2) and the contour/region overlay
> — blocklist-bound (`RightPanel.jsx`, `ViewerPanel.jsx`), net-new UI.
> **Method:** TDD, Red→Green per task. Service tests run from each service dir:
> `cd services/<svc> && uv run pytest`. Stub-first: every task is exercised with **no GPU/Trident**;
> the real Trident+CONCH path lands behind the same seam as CellViT (R8→R11) / MedGemma (Inc 2a).

## Ground truth (from the code-grounded review)
- Trident recipe = **WSI-object methods**: `slide = load_wsi(...)` → `slide.segment_tissue` →
  `slide.extract_tissue_coords(target_mag, patch_size, save_coords)` → `slide.extract_patch_features(
  patch_encoder, coords_path, save_features)`. Coords h5 = int64 `(N,2)` **level-0**, attrs
  `patch_size_level0`, `target_magnification`. Features h5 holds `features` **and** index-aligned
  `coords`.
- Text search needs **`conch_v1` with `with_proj=True, normalize=True`** (or `musk`); `conch_v15` has
  **no** text tower. Text-encode via the **`conch` package** (`encode_text` + its tokenizer), not
  Trident. `conch`/`musk` are optional Trident extras.
- Recovered v1 `slide_resolver.resolve_slide` (git `75d5523^`): local-by-item_id → local-by-name+size
  → download `/file/{id}/download`. Girder file doc via `/item/{id}/files`.
- Gateway seams: `common/config.py` (`AGENT_*` env, empty ⇒ disabled), `store/pg.py` (`_SCHEMA` string,
  idempotent on connect, no alembic), `store/base.py` (ConversationStore ABC), `gateway/routes.py`
  (`APIRouter(prefix="/api/copilot")`, `get_*_url` deps, `ToolContext` built at the turn route),
  `loop/tools.py` (`ToolContext`, `_TOOLS`, `run_server_tool`, inline `ArtifactHandle`),
  `loop/sdk_tools.py` (`_SCHEMAS`, `sdk_tool_names` `mcp__pathagent__*`), `loop/sdk.py` (`_SYSTEM`).
- Service template = `services/pathvlm/` (Flask, `app.config` injectable seams, `use_model=bool(ckpt)`
  stub/real, `_stub_*` deterministic, `_load()` warm singleton).

---

## Part A — `services/preprocess/` (new Flask worker, stub-first)

### T1 — service skeleton + config
- **Red:** `tests/test_config.py` — `get_settings()` reads `PREPROCESS_*`; defaults: `girder_base ==
  "http://localhost:9080/api/v1"`, `slides_root is None`, `image_encoder == "conch_v15"`,
  `text_encoder == "conch_v1"`, `artifact_cache` set, `use_trident is False` (empty seam flag).
- **Green:** `src/preprocess_service/config.py` — frozen `Settings` + `@lru_cache get_settings()`,
  `os.getenv` (no pydantic), mirroring pathvlm. `use_trident` property = `bool(trident_enabled env)`.
  `pyproject.toml`, `.gitignore`, `__init__.py`.

### T2 — slide_resolver (re-port v1) + girder_download
- **Red:** `tests/test_slide_resolver.py` — (a) local-by-item_id hits a file under `slides_root`;
  (b) local-by-name+size uses a MockTransport `/item/{id}/files` doc then matches on disk by name+size;
  (c) size-mismatch falls through; (d) download tier streams `/file/{id}/download` (MockTransport) to
  `.part`→final; (e) glob/path-injection in item_id or name raises.
- **Green:** `slide_resolver.py` + `girder_download.py` (+ a small `_validate_segment`), ported from
  the recovered v1 code. Thread `girder_token` into every Girder call.

### T3 — params_hash + artifact cache
- **Red:** `tests/test_artifacts.py` — `params_hash(encoder, mag, patch_size, segmenter, version)` is
  deterministic + order-stable; `cache_paths(cache_root, item, params_hash)` → `{features, coords,
  contours}` under `{cache}/{item}/{hash}/`; a write→read round-trips a features+coords h5.
- **Green:** `artifacts.py` — hash (sha1 of a canonical param string), path builder, h5 write/read
  helpers (h5py), GeoJSON write.

### T4 — Trident pipeline seam (stub + real)
- **Red:** `tests/test_pipeline.py` — `run_pipeline(slide_path, params, sink, *, use_trident=False)`
  returns `PipelineResult(n_patches>0, features_ref, coords_ref, contours_ref, stage_log)`; the stub
  writes an index-aligned features h5 (`features` `[N,dim]` + level-0 `coords` `(N,2)` with attrs
  `patch_size_level0`, `target_magnification`) and a trivial contours GeoJSON; deterministic for a
  fixed synthetic slide.
- **Green:** `pipeline.py` — `_stub_pipeline` (synthetic tissue grid → deterministic feature vectors)
  and `_trident_pipeline` (WSI-object recipe; lazy `import trident`, GPU-only) behind `use_trident`.
  `run_pipeline` dispatches; stages reported via a callback (`on_stage`).

### T5 — single-consumer job queue
- **Red:** `tests/test_jobs.py` — `JobQueue.submit(fn) -> job_id`; `status(job_id)` transitions
  `queued→running(stage,progress)→ready|failed`; two submits run **serially**; a raising job → `failed`
  with the error message; unknown id → None.
- **Green:** `jobs.py` — a daemon worker thread draining a `queue.Queue`, an in-memory `dict[job_id]`
  status registry (thread-safe), stage/progress updates via the pipeline `on_stage` callback.

### T6 — app routes
- **Red:** `tests/test_routes.py` (Flask test client, pipeline + resolver injected via `app.config`) —
  `GET /health` → `{status:ok, service:preprocess, model: stub|trident}`; `POST /run {item, encoder,
  mag, patch_size, segmenter, token}` → 202 `{job_id, params_hash, status:"queued"}`; `GET
  /status?job_id=…` → the job status; bad body → 400.
- **Green:** `app.py` — `create_app()` with injectable `RESOLVE`/`PIPELINE`/`QUEUE` seams; wire the
  routes; enqueue resolve→pipeline→sink on `/run`. (`POST /find_regions` added in T11.)

---

## Part B — gateway control plane + routes

### T7 — gateway config
- **Red:** `tests/test_config.py` (extend) — `get_settings().preprocess_service_url == ""` default;
  env `AGENT_PREPROCESS_SERVICE_URL` overrides.
- **Green:** add `preprocess_service_url: str = ""` after `pathvlm_service_url` in `common/config.py`.

### T8 — `SlideIndexStore` (ABC + Memory + Pg) + `slide_index` DDL
- **Red:** `tests/test_slide_index_store.py` — against `MemorySlideIndexStore`: `upsert_index(item,
  params_hash, encoder, mag, patch_size, segmenter, status)` creates then updates in place (unique on
  item+params_hash); `set_status(item, params_hash, status, progress, n_patches, feature_ref, error)`;
  `get_index(item, params_hash)`; `list_indexes(item)`.
- **Green:** `store/slide_index.py` — `SlideIndexStore` ABC + `MemorySlideIndexStore`; `PgSlideIndexStore`
  sharing the asyncpg pool; append `CREATE TABLE IF NOT EXISTS slide_index (...)` (unique
  `(girder_item, params_hash)`) to `_SCHEMA` in `store/pg.py`. Keep the ConversationStore ABc untouched.

### T9 — gateway proxy routes
- **Red:** `tests/test_slide_routes.py` (FastAPI TestClient, `MemorySlideIndexStore` + MockTransport
  worker via a `get_preprocess_url` override) — `POST /api/copilot/slides/{item}/preprocess {encoder,…}`
  → creates a `queued` slide_index row + returns `{params_hash, status}`; `GET
  /api/copilot/slides/{item}/index` → the row(s); while `running`, the row's progress reflects the
  worker's `/status`; auth via `require_user`.
- **Green:** add both routes to `gateway/routes.py` (same `/api/copilot` router, `Depends(require_user)`
  + a `get_slide_index_store` dep). POST does a fast httpx `POST {preprocess_url}/run` then
  `upsert_index(...queued)`; GET reads the store and, for `running` rows, fetches worker `/status` and
  reconciles.

### T10 — `ToolContext.preprocess_url` + turn-route wiring
- **Red:** `tests/test_tools_findregions.py` (stub) asserts `ToolContext` accepts `preprocess_url`;
  a route smoke asserts the turn route passes it.
- **Green:** add `preprocess_url: str | None = None` to `ToolContext` (`loop/tools.py`), a
  `get_preprocess_url` dep + `post_turn` param + the `ToolContext(...)` call site in `gateway/routes.py`.

---

## Part C — `find_regions` server tool (Inc 2b-3)

### T11 — preprocess_client + retrieval endpoint
- **Red:** `services/preprocess/tests/test_find_regions.py` — `POST /find_regions {item, encoder,
  query, k, token}` on a ready **text-capable** stub index returns `{regions:[{x,y,width,height,score}],
  top_score}` (level-0, k items, scores desc); an image-only encoder → 409 `{detail:"…text search…"}`;
  no index → 404. Plus `services/agent/tests/test_preprocess_client.py` (httpx MockTransport) for the
  async client.
- **Green:** preprocess `/find_regions` (stub: deterministic cosine over the stub features + query
  hash → ordered level-0 boxes from coords; refuse image-only encoders); `loop/preprocess_client.py`
  async `find_regions(base_url, item, query, k, token, client=None)`.

### T12 — the `find_regions` LoopTool
- **Red:** `services/agent/tests/test_tools_findregions.py` — `run_server_tool(get_tool("find_regions"),
  {query:"tumor"}, scope, ctx)` with `preprocess_url` set → `ok`, summary mentions the query + top
  score, and an **inline** `artifact.kind == "regions"`, `artifact.meta["regions"]` a list of level-0
  boxes, `ref == ""`; not-indexed → `ok=False` with a clean "build an index" summary, no artifact;
  `"mcp__pathagent__find_regions" in sdk_tool_names()`.
- **Green:** register `find_regions` (server) in `_TOOLS` (`loop/tools.py`), add its `_SCHEMAS` entry
  (`{query: str, k?: int}`) in `loop/sdk_tools.py`, add the `run_server_tool` branch building the
  inline `kind="regions"` handle (like `describe_region`).

### T13 — `_SYSTEM` grounding
- **Red:** `services/agent/tests/test_prompt_grounding.py` (or extend) — `_SYSTEM` contains the
  find_regions grounding clause ("candidates by similarity, not verified findings; confirm with
  describe_region").
- **Green:** extend `_SYSTEM` in `loop/sdk.py`.

---

## Part D — infra + integration E2E

### T14 — Dockerfile / compose / live E2E
- `services/preprocess/Dockerfile` (Flask stub default — **no GPU needed for stub**; real path pins the
  cellvit/pathvlm driver-535 base + Trident/conch extras) + `pyproject.toml`/`uv.lock`.
- `services/agent/docker-compose.yml`: add the `preprocess` service (stub default) + gateway env
  `AGENT_PREPROCESS_SERVICE_URL=http://preprocess:<port>`.
- **Live E2E (stub):** bring up the stub `preprocess` service + recreate the gateway; against a **live
  public DSA item** (e.g. a BRCA-DEMO / TCGA-BRCA slide, `localhost:9080`) → `POST
  /api/copilot/slides/{item}/preprocess` → poll `GET …/index` to `ready`. Then **on page** (the Copilot
  panel): ask "find regions relevant to invasive tumor" → the copilot calls `find_regions` → a tool
  card + grounded summary render in the chat trace. **Find & fix user-facing bugs** (auth, empty
  states, error copy). Then unit suites green (`preprocess`, `agent`, `cellvit`, `pathvlm`, frontend
  vitest) + `npm run build` clean.

## Commit plan (respecting the blocklist; do NOT push)
1. `docs(copilot): review + amend Inc 2b Trident design` — the review doc + revised design + this plan.
2. `feat(preprocess): slide preprocess worker (stub Trident seam)` — Part A.
3. `feat(copilot): slide_index control plane + preprocess routes` — Part B.
4. `feat(copilot): find_regions region-search tool` — Part C.
5. `chore(preprocess): compose + gateway wiring` — Part D infra.
Never stage: `package*.json`, `src/components/dashboard/*`, `RightPanel.jsx`, `LeftSidebar.jsx`,
`ViewerPanel.jsx`, `src/styles/index.css`, `vite.config.js`, `src/test/`, `fix/`,
`services/agent/.claude/`, any `.env`/secrets.
