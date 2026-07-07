# PathAgent — M0 Implementation & Verification Report

> **Date:** 2026-07-07 · **Branch:** `chen` · **Component:** `services/pathagent/`
> **Milestone:** M0 (Agent Gateway) — Plan 1 of 5 from the integration design.

---

## 1. Executive summary

The **PathAgent Agent Gateway (M0)** is implemented, tested, linted, containerized, and **verified
running end-to-end on real infrastructure**. A feed-forward of sample cases succeeds through both the
in-process path *and* the real **Redis + RQ-worker** path, producing the expected `ready` status and
cache manifests for every sample.

M0 is the service backbone: the API contract, auth passthrough, job queue, case registry, cache-key
layout, and streaming stubs — with a deliberately **fake preprocessor** so the whole
enqueue → run → ready cycle works without GPUs or slides. **Real pixel-level WSI processing
(Trident → CONCH features) is Plan 2 / M1** and is scoped in §8; its only hard prerequisites that are
*not* already available here are gated CONCH weights, sample slides, and a Girder endpoint (a
suitable GPU is present).

**Status: M0 complete and green.** All tests pass, lint clean, container builds and serves,
feed-forward 3/3 samples `ready`. An independent final holistic review returned
**ship-with-followups** (no critical issues); its two cheap fixes were applied and its remaining
items are captured as Plan-2 prerequisites (§8) and follow-ups (§9).

---

## 2. Scope: what "feed-forward WSI samples" means at M0

Being precise so nothing is over-claimed:

- The full system (design doc `2026-07-06-wsi-agents-integration-plan.md`) is a 5-milestone build
  (M0 gateway → M1 Trident → M2a SlideChat/KB → M3 orchestrator → M4 frontend → M5 eval).
- **M0 ships the service skeleton + a fake preprocessor by design.** The "samples" are Girder-style
  case IDs standing in for slides. They flow through the **true service lifecycle**: auth →
  deterministic cache-key → registry entry → enqueue → worker job → status + on-disk manifest.
- What M0 does **not** do yet: read a real `.svs`, run tissue segmentation, or compute CONCH
  features. That is the M1 worker, which replaces the one fake function (§8).

So the verification below exercises the *entire M0 machinery* against sample cases — it just doesn't
touch pixels, because pixel processing is the next milestone.

---

## 3. What was built (M0)

A new Python 3.11 project (`uv`, FastAPI, Pydantic v2, Redis/RQ, httpx) — **416 lines of source
across 11 focused modules** (all well under the 200-line/file guideline), **31 tests**.

```
services/pathagent/
├── pyproject.toml · uv.lock · Dockerfile · docker-compose.yml · README.md
├── src/pathagent/
│   ├── common/  config.py · schemas.py · cache_keys.py · connection.py · registry.py
│   ├── gateway/ auth.py · queue.py · deps.py · routes.py · app.py
│   └── worker/  fake_preprocess.py            ← the single swap-point for M1
├── scripts/feed_forward_demo.py               ← runnable sample harness
└── tests/  (common/ · gateway/ · worker/ · test_end_to_end.py · test_feed_forward_samples.py)
```

**Module responsibilities**

| Module | Responsibility |
|---|---|
| `common/config.py` | `Settings` (pydantic-settings, `PATHAGENT_*` env), `get_settings()` |
| `common/schemas.py` | camelCase wire models: `PreprocessRequest/Response`, `StatusResponse`, `JobStatus`, `ReadyFlags`, `FeatureSpec` |
| `common/cache_keys.py` | deterministic params-hash `compute_cache_key`, `cache_paths` layout, `_validate_segment` (path-traversal guard) |
| `common/connection.py` | `get_job_redis()` — worker-side Redis (the M1 job reuses this) |
| `common/registry.py` | `Registry` — per-case status JSON in Redis |
| `gateway/auth.py` | `require_user` — validates the `Girder-Token` via Girder `/user/me`; 401/503 on failure |
| `gateway/queue.py` | `PreprocessQueue.enqueue_preprocess` — **references `run_fake_preprocess`; this is the one line M1 changes** |
| `gateway/deps.py` | FastAPI deps reading `app.state` |
| `gateway/routes.py` | `POST /cases/{itemId}/preprocess` (202, idempotent), `GET /cases/{itemId}/status` |
| `gateway/app.py` | `create_app(redis_conn, queue)` factory + SSE `/query` and `/heatmap` stubs |
| `worker/fake_preprocess.py` | M0 stand-in: running → writes stub manifest → ready; records errors |

**Endpoints (`/api/agent`, all Girder-token gated):**
`POST /cases/{itemId}/preprocess` · `GET /cases/{itemId}/status` · `POST /query` (SSE stub emitting
`route`/`triage`/`navigate`/`final`) · `GET /cases/{itemId}/heatmap/{taskId}` (stub).

**Design choices worth noting:** camelCase wire aliases (frontend-native); `PIPELINE_VERSION`-salted
cache keys for future invalidation; a clean `create_app(redis_conn, queue)` DI seam that made both
in-process and real-worker testing trivial; server-side auth (no in-browser keys, unlike the legacy
AskPA path).

---

## 4. Verification results

### 4.1 Automated suite
```
uv run pytest -q   →  31 passed, 1 warning in ~0.8s
uv run ruff check .→  All checks passed!
uv run ruff format --check .  →  clean
```
(The one warning is an unrelated Starlette/httpx TestClient deprecation notice — see §9.)

### 4.2 Feed-forward — in-process (fakeredis, inline queue)
```
uv run python scripts/feed_forward_demo.py
✓ TCGA-BRCA-sample-01.svs  status=ready  elapsed=0.55s  manifest=yes  features=True
✓ TCGA-LUAD-sample-02.svs  status=ready  elapsed=0.51s  manifest=yes  features=True
✓ TCGA-PRAD-sample-03.svs  status=ready  elapsed=0.51s  manifest=yes  features=True
3/3 samples reached ready   (exit 0)
```

### 4.3 Feed-forward — **real async path** (Redis in Docker + a real RQ worker)
```
# redis:7 container + `rq worker pathagent` + demo --redis-url redis://localhost:6379/0
✓ TCGA-BRCA-sample-01.svs  status=ready  elapsed=0.53s  manifest=yes  features=True
✓ TCGA-LUAD-sample-02.svs  status=ready  elapsed=0.51s  manifest=yes  features=True
✓ TCGA-PRAD-sample-03.svs  status=ready  elapsed=0.51s  manifest=yes  features=True
3/3 samples reached ready   (exit 0)
```
Artifacts confirmed independently:
- **On disk:** three `…/manifest.json` files, each with the correct `itemId`, echoed request, `stub:true`.
- **In Redis:** three `pathagent:case:*` keys, each `{"status":"ready","progress":1.0,"ready":{"features":true,…}}` — camelCase serialization intact.

### 4.4 Container
```
docker build → pathagent:test (245 MB), build OK
docker run   → gateway serving in ~2.5s; OpenAPI exposes all 4 /api/agent paths
unauthenticated POST /preprocess → 422  (auth correctly enforced)
```

### 4.5 Sample results — expected vs. actual

| Sample (stand-in slide) | Expected | Actual (inline) | Actual (real worker) |
|---|---|---|---|
| TCGA-BRCA-sample-01 | `ready`, manifest, features=true | ✅ | ✅ |
| TCGA-LUAD-sample-02 | `ready`, manifest, features=true | ✅ | ✅ |
| TCGA-PRAD-sample-03 | `ready`, manifest, features=true | ✅ | ✅ |
| re-submit same case | short-circuits to `ready` (`jobId:"cached"`) | ✅ | ✅ |
| unsafe id (`bad..id`) | rejected `400` | ✅ | ✅ |

All results match expectations.

---

## 5. Issues found and fixed during review

Each build batch went through spec-compliance + code-quality review by independent agents; the notable
catches:

| Issue | Severity | Fix |
|---|---|---|
| Bare-name import of `get_job_redis` defeated the test monkeypatch (order-dependent failure) | Real bug | Import the module, call `connection.get_job_redis()` at call time |
| `item_id`/`cache_key` flowed unvalidated into filesystem `Path`s (path-traversal vector) | Security | `_validate_segment` guard rejecting `/`, `\`, `..`, empty; route returns `400` |
| Stub `/query` and `/heatmap` skipped `require_user` (auth bypass vs. the design's auth contract) | Critical | Added `Depends(require_user)` + no-token rejection tests |
| `require_user` turned Girder outages / non-JSON into raw 500s | Important | Catch `httpx.HTTPError`→503, guard JSON parse, parse once |
| Demo inline mode dialed real Redis via `get_job_redis` | Bug | Demo patches `get_job_redis` to its fakeredis in inline mode |
| Missing type hints / docstrings; magic status codes; untracked `uv.lock` | Minor | Types + docstrings added, `fastapi.status` constants, `uv.lock` committed, `ruff` added |
| Docker build re-resolved deps instead of the committed lock | Important (final review) | `COPY uv.lock` + `uv sync --no-dev --frozen` |
| `cache_paths.features(encoder)` built a path from an unvalidated encoder string (Plan 2 feeds it request data) | Important (final review) | `_validate_segment(encoder)` inside `.features()` + test |

---

## 6. How to run

```bash
cd services/pathagent
uv sync                                   # install (Python 3.11)

uv run pytest -q                          # 30 tests
uv run ruff check .                       # lint

# Feed-forward demo — in-process, zero external services:
uv run python scripts/feed_forward_demo.py

# Feed-forward demo — real async path:
docker run -d --name pa-redis -p 6379:6379 redis:7
PATHAGENT_REDIS_URL=redis://localhost:6379/0 PATHAGENT_CACHE_DIR=/tmp/pa-cache \
  uv run rq worker pathagent --url redis://localhost:6379/0 &
PATHAGENT_CACHE_DIR=/tmp/pa-cache \
  uv run python scripts/feed_forward_demo.py --redis-url redis://localhost:6379/0

# Full container stack:
docker compose up --build          # redis + gateway(:8000) + rq worker
```

---

## 7. Environment (this machine)

| Resource | Status | Note |
|---|---|---|
| GPU | **NVIDIA RTX A6000 (48 GB)** ✅ | Matches the design's recommended serving GPU class — **M1's GPU prerequisite is already met** |
| Docker | daemon OK ✅ | Used for Redis + image build/run |
| Outbound network | OK ✅ | `uv sync`, image pulls |
| Redis binary | not installed | Run via Docker (done) |
| System OpenSlide | not installed | Needed for M1 (Trident WSI reading) |

---

## 8. What's NOT done — the road to real WSI processing

M0 is the skeleton. Turning "sample case IDs" into "real slides analyzed" is the rest of the plan:

| Milestone | Delivers | Blocking prerequisites (beyond code) |
|---|---|---|
| **M1 — Trident worker** | Real seg → coords → CONCH features; replaces `worker/fake_preprocess.py` | **Gated CONCH weights** (HF token + license), **sample `.svs` slides**, a reachable **Girder/DSA** item store, OpenSlide, Trident install. *GPU already present.* |
| **M2a — Perception** | SlideChat slide-VQA + query-conditioned CONCH concept-similarity map + KB (Chroma over WHO/PathologyOutlines) | SlideChat weights (Apache-2.0, downloadable), KB source texts |
| **M3 — Orchestrator** | LangGraph Triage→Navigate→Describe→Diagnose + dual verification; replaces the `/query` stub | **GPT-4V API key** (server-side) |
| **M4 — Frontend** | The React `PathAgent` right-panel + live OSD co-navigation | wire `VITE_AGENT_API_URL`, nginx `/api/agent` proxy |
| **M5 — Eval** | Patho-Bench/SlideBench + CAMELYON16 navigation metric + ablation grid | benchmark datasets |

**The single swap-point for M1:** `gateway/queue.py` enqueues `run_fake_preprocess`. M1 implements a
real Trident job with the same `(cache_key, item_id, request_payload)` signature, writes real `coords`
/ `features_*.h5` into the existing `cache_paths` layout, flips the same registry status, and changes
that one reference. Nothing else in the gateway needs to move.

**Two security prerequisites for Plan 2 (from the final review):** (1) add **item-level
authorization** — `require_user` authenticates *identity* but doesn't check the caller can read the
*specific* slide; before M1 pulls real pixels, add a Girder item-permission check (e.g. `GET
/item/{itemId}` with the caller's token, expect 403 if unauthorized) alongside `require_user`.
(2) **Bump `PIPELINE_VERSION`** (`common/cache_keys.py`) when swapping in the real worker, so any
stale fake-`ready` cache entries can never be served as if they were real results.

---

## 9. Follow-ups / tech debt (non-blocking, tracked from reviews)

- `require_user` opens a new `httpx.AsyncClient` per request — build one in a FastAPI lifespan and
  inject it (connection reuse) before this fronts real traffic.
- CORS is `allow_origins=["*"]` (fine for dev) — make it a config-driven allow-list for deployment.
- The Starlette/httpx `TestClient` deprecation warning — cosmetic; revisit on the next httpx bump.
- `Registry` status keys have no TTL — add an expiry (e.g. 30 days) before continuous operation.
- The container runs as root — add a non-root `USER` for deployment hardening.
- `FeatureSpec` fields are unconstrained — constrain in Plan 2 (`mag: PositiveInt`,
  `patch_encoder: Literal["conch_v1", "conch_v1.5", …]`) so bad params are rejected at the edge.

---

## 10. Commit log (this effort, branch `chen`)

Design/plan: `bcd7357` (design v3), `e66d312` (M0 plan). **17 code commits** M0:
`ba7b94c` scaffold → `bf59098` config → `a8bbe50` schemas → `3b7bc30` cache-keys → `f94cb4b`
registry → `eafa944` fake job → `e6da337` harden inputs → `ecd6839` auth → `1c8447b` queue →
`ca668b8` routes → `23c8c03` app+stubs → `9141d08` auth/stub fixes → `4e19727` e2e test →
`26051d3` Docker → `263dafe` ruff → `dc22f78` feed-forward harness → `5563600` docker/encoder
hardening.

---

## 11. Recommendation / next step

M0 is a solid, verified backbone ready to build on. The highest-value next step is **Plan 2 (M1):
the real Trident worker**, which is unblocked here except for (a) a Hugging Face token with **CONCH**
access, (b) one or more sample `.svs` slides, and (c) a reachable Girder/DSA item to pull from. Provide
those and M1 can process a real slide end-to-end on the A6000; the gateway, queue, cache, and status
plumbing verified above are already in place.
