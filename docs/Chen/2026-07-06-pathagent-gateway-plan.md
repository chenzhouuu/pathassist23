# PathAgent Gateway (M0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the PathAgent Agent Gateway — a FastAPI service with a Redis/RQ job queue, Girder-token auth passthrough, a case/job registry, a stable preprocess/status API contract, and streaming stubs — with a *fake* in-process preprocessor so the whole enqueue→status→ready cycle runs and is fully testable without GPUs or WSIs.

**Architecture:** A new Python project `services/pathagent/` with three packages: `common/` (config, wire schemas, cache-key + path layout, Redis registry), `gateway/` (FastAPI app, auth, routes, queue), and `worker/` (the RQ job — an M0 fake that simulates Trident stages and writes a stub manifest). The fake job is swapped for the real Trident pipeline in Plan 2 (M1); nothing else changes.

**Tech Stack:** Python 3.11, `uv`, FastAPI + uvicorn, Pydantic v2 + pydantic-settings (camelCase wire aliases), Redis + RQ, httpx (Girder calls), pytest + pytest-asyncio + respx + fakeredis.

---

## Plan series (context)

This is **Plan 1 of 5**, tracking the design doc `docs/Chen/2026-07-06-wsi-agents-integration-plan.md`:
- **Plan 1 — M0 Agent Gateway (this doc):** API contract + scaffolding + fake preprocessor.
- Plan 2 — M1 Trident preprocessing worker (replace the fake job with real Trident).
- Plan 3 — M2a perception (SlideChat + CONCH concept-similarity + KB).
- Plan 4 — M3 LangGraph orchestrator (Diagnosis loop + verification).
- Plan 5 — M4 frontend PathAgent panel.

Each ships working, testable software on its own.

## File structure (locked before tasks)

```
services/pathagent/
├── pyproject.toml                    # uv project + deps + pytest config
├── Dockerfile
├── docker-compose.yml                # redis + gateway + rq worker
├── README.md
├── src/pathagent/
│   ├── __init__.py
│   ├── common/
│   │   ├── __init__.py
│   │   ├── config.py                 # Settings (pydantic-settings)
│   │   ├── schemas.py                # wire models (camelCase aliases)
│   │   ├── cache_keys.py             # params-hash key + cache path layout
│   │   ├── connection.py             # get_job_redis() for worker-side Redis
│   │   └── registry.py               # Redis-backed status registry
│   ├── gateway/
│   │   ├── __init__.py
│   │   ├── auth.py                   # require_user (Girder /user/me passthrough)
│   │   ├── queue.py                  # PreprocessQueue (RQ enqueue)
│   │   ├── deps.py                   # FastAPI deps → app.state
│   │   ├── routes.py                 # /preprocess + /status
│   │   └── app.py                    # create_app() + SSE/heatmap stubs
│   └── worker/
│       ├── __init__.py
│       └── fake_preprocess.py        # M0 fake job (Plan 2 replaces this)
└── tests/
    ├── conftest.py
    ├── common/{test_config,test_schemas,test_cache_keys,test_registry}.py
    ├── gateway/{test_auth,test_queue,test_routes,test_app_stubs}.py
    ├── worker/test_fake_preprocess.py
    └── test_end_to_end.py
```

One responsibility per file; all files stay well under 200 lines.

---

## Task 0: Project scaffolding

**Files:**
- Create: `services/pathagent/pyproject.toml`
- Create: `services/pathagent/src/pathagent/__init__.py` (and `common/`, `gateway/`, `worker/` `__init__.py`)
- Create: `services/pathagent/tests/conftest.py`

- [ ] **Step 1: Create the project layout and `pyproject.toml`**

```toml
# services/pathagent/pyproject.toml
[project]
name = "pathagent"
version = "0.1.0"
description = "PathAgent Gateway — WSI-agent copilot backend for PathAssist"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.111",
    "uvicorn[standard]>=0.30",
    "pydantic>=2.7",
    "pydantic-settings>=2.3",
    "redis>=5.0",
    "rq>=1.16",
    "httpx>=0.27",
]

[dependency-groups]
dev = [
    "pytest>=8.2",
    "pytest-asyncio>=0.23",
    "respx>=0.21",
    "fakeredis>=2.23",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]
asyncio_mode = "auto"
```

- [ ] **Step 2: Create the package `__init__.py` files**

Create empty files: `src/pathagent/__init__.py`, `src/pathagent/common/__init__.py`, `src/pathagent/gateway/__init__.py`, `src/pathagent/worker/__init__.py`, and `tests/__init__.py`, `tests/common/__init__.py`, `tests/gateway/__init__.py`, `tests/worker/__init__.py`.

- [ ] **Step 3: Write the shared test fixtures**

```python
# services/pathagent/tests/conftest.py
import fakeredis
import pytest


@pytest.fixture
def redis_conn():
    """An isolated in-memory Redis for each test."""
    return fakeredis.FakeStrictRedis(decode_responses=False)


@pytest.fixture
def tmp_cache(monkeypatch, tmp_path):
    """Point the cache dir at a temp path and reset the settings cache."""
    from pathagent.common.config import get_settings

    monkeypatch.setenv("PATHAGENT_CACHE_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


@pytest.fixture
def job_redis(redis_conn, monkeypatch):
    """Make the worker-side get_job_redis() return the test's fakeredis."""
    from pathagent.common import connection

    connection.get_job_redis.cache_clear()
    monkeypatch.setattr(connection, "get_job_redis", lambda: redis_conn)
    return redis_conn
```

- [ ] **Step 4: Install and verify the environment**

Run: `cd services/pathagent && uv sync`
Expected: resolves and installs FastAPI, RQ, pytest, etc. Then `uv run pytest -q` prints "no tests ran" (exit 5) — that's fine; the toolchain works.

- [ ] **Step 5: Commit**

```bash
cd services/pathagent
git add pyproject.toml src tests
git commit -m "chore(pathagent): scaffold gateway project (uv, pytest, fixtures)"
```

---

## Task 1: Settings (`common/config.py`)

**Files:**
- Create: `services/pathagent/src/pathagent/common/config.py`
- Test: `services/pathagent/tests/common/test_config.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/common/test_config.py
from pathlib import Path


def test_defaults():
    from pathagent.common.config import Settings

    s = Settings()
    assert s.redis_url.startswith("redis://")
    assert s.default_patch_encoder == "conch_v1"
    assert s.default_mag == 20


def test_env_override(monkeypatch):
    from pathagent.common.config import get_settings

    monkeypatch.setenv("PATHAGENT_REDIS_URL", "redis://example:6379/2")
    monkeypatch.setenv("PATHAGENT_CACHE_DIR", "/tmp/pa-cache")
    get_settings.cache_clear()
    s = get_settings()
    assert s.redis_url == "redis://example:6379/2"
    assert s.cache_dir == Path("/tmp/pa-cache")
    get_settings.cache_clear()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/common/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'pathagent.common.config'`

- [ ] **Step 3: Write the implementation**

```python
# src/pathagent/common/config.py
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, overridable via PATHAGENT_* env vars."""

    model_config = SettingsConfigDict(env_prefix="PATHAGENT_", env_file=".env", extra="ignore")

    girder_base: str = "https://lymphoma.dev.pathassist.health/api/v1"
    redis_url: str = "redis://localhost:6379/0"
    cache_dir: Path = Path("/data/pathagent-cache")
    default_patch_encoder: str = "conch_v1"
    default_mag: int = 20
    default_patch_size: int = 256


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/common/test_config.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add src/pathagent/common/config.py tests/common/test_config.py
git commit -m "feat(pathagent): add Settings config with env overrides"
```

---

## Task 2: Wire schemas (`common/schemas.py`)

**Files:**
- Create: `services/pathagent/src/pathagent/common/schemas.py`
- Test: `services/pathagent/tests/common/test_schemas.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/common/test_schemas.py
def test_preprocess_request_parses_camelcase():
    from pathagent.common.schemas import PreprocessRequest

    req = PreprocessRequest.model_validate(
        {
            "backbone": {"patchEncoder": "conch_v1", "mag": 20, "patchSize": 256},
            "consensus": {"patchEncoder": "conch_v1.5", "mag": 20, "patchSize": 512},
            "slidechat": True,
        }
    )
    assert req.backbone.patch_encoder == "conch_v1"
    assert req.consensus.patch_size == 512
    # dumps back to camelCase for the JS client
    assert req.model_dump(by_alias=True)["backbone"]["patchEncoder"] == "conch_v1"


def test_feature_spec_defaults():
    from pathagent.common.schemas import FeatureSpec

    spec = FeatureSpec(patchEncoder="conch_v1")
    assert spec.mag == 20 and spec.patch_size == 256


def test_status_response_defaults():
    from pathagent.common.schemas import JobStatus, StatusResponse

    st = StatusResponse(status=JobStatus.queued)
    dumped = st.model_dump(by_alias=True)
    assert dumped["status"] == "queued"
    assert dumped["ready"] == {"features": False, "slidechat": False, "classifiers": False}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/common/test_schemas.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'pathagent.common.schemas'`

- [ ] **Step 3: Write the implementation**

```python
# src/pathagent/common/schemas.py
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """Base model: accepts + emits camelCase (the JS wire format), also accepts snake_case."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    ready = "ready"
    error = "error"


class FeatureSpec(CamelModel):
    patch_encoder: str
    mag: int = 20
    patch_size: int = 256


class PreprocessRequest(CamelModel):
    backbone: FeatureSpec
    consensus: FeatureSpec | None = None
    slidechat: bool = True


class PreprocessResponse(CamelModel):
    job_id: str
    cache_key: str
    status: JobStatus


class ReadyFlags(CamelModel):
    features: bool = False
    slidechat: bool = False
    classifiers: bool = False


class StatusResponse(CamelModel):
    status: JobStatus
    stage: str | None = None
    progress: float = 0.0
    ready: ReadyFlags = Field(default_factory=ReadyFlags)
    error: str | None = None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/common/test_schemas.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/pathagent/common/schemas.py tests/common/test_schemas.py
git commit -m "feat(pathagent): add camelCase wire schemas"
```

---

## Task 3: Cache keys + path layout (`common/cache_keys.py`)

**Files:**
- Create: `services/pathagent/src/pathagent/common/cache_keys.py`
- Test: `services/pathagent/tests/common/test_cache_keys.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/common/test_cache_keys.py
def _req(mag=20):
    from pathagent.common.schemas import FeatureSpec, PreprocessRequest

    return PreprocessRequest(backbone=FeatureSpec(patchEncoder="conch_v1", mag=mag))


def test_cache_key_is_deterministic():
    from pathagent.common.cache_keys import compute_cache_key

    k1 = compute_cache_key("item123", _req())
    k2 = compute_cache_key("item123", _req())
    assert k1 == k2
    assert k1.startswith("item123-")


def test_cache_key_varies_with_params():
    from pathagent.common.cache_keys import compute_cache_key

    assert compute_cache_key("item123", _req(mag=20)) != compute_cache_key("item123", _req(mag=40))


def test_cache_paths(tmp_cache):
    from pathagent.common.cache_keys import cache_paths

    paths = cache_paths("item123-abc")
    assert paths.root == tmp_cache / "item123-abc"
    assert paths.manifest.name == "manifest.json"
    assert paths.features("conch_v1").name == "features_conch_v1.h5"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/common/test_cache_keys.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'pathagent.common.cache_keys'`

- [ ] **Step 3: Write the implementation**

```python
# src/pathagent/common/cache_keys.py
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from .config import get_settings
from .schemas import PreprocessRequest

# Bump when the preprocessing pipeline changes in a way that invalidates cached artifacts.
PIPELINE_VERSION = "1"


def compute_cache_key(item_id: str, request: PreprocessRequest) -> str:
    payload = {
        "v": PIPELINE_VERSION,
        "item": item_id,
        "backbone": request.backbone.model_dump(),
        "consensus": request.consensus.model_dump() if request.consensus else None,
        "slidechat": request.slidechat,
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(blob.encode()).hexdigest()[:12]
    return f"{item_id}-{digest}"


@dataclass(frozen=True)
class CachePaths:
    root: Path
    manifest: Path
    coords: Path
    thumbnail: Path

    def features(self, encoder: str) -> Path:
        return self.root / f"features_{encoder}.h5"


def cache_paths(cache_key: str) -> CachePaths:
    root = get_settings().cache_dir / cache_key
    return CachePaths(
        root=root,
        manifest=root / "manifest.json",
        coords=root / "coords.h5",
        thumbnail=root / "thumbnail.jpg",
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/common/test_cache_keys.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/pathagent/common/cache_keys.py tests/common/test_cache_keys.py
git commit -m "feat(pathagent): add deterministic cache keys and path layout"
```

---

## Task 4: Redis registry + connection (`common/registry.py`, `common/connection.py`)

**Files:**
- Create: `services/pathagent/src/pathagent/common/connection.py`
- Create: `services/pathagent/src/pathagent/common/registry.py`
- Test: `services/pathagent/tests/common/test_registry.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/common/test_registry.py
def test_create_then_get(redis_conn):
    from pathagent.common.registry import Registry
    from pathagent.common.schemas import JobStatus

    reg = Registry(redis_conn)
    assert reg.get_status("k1") is None
    reg.create("k1")
    st = reg.get_status("k1")
    assert st is not None and st.status == JobStatus.queued


def test_set_status_roundtrip(redis_conn):
    from pathagent.common.registry import Registry
    from pathagent.common.schemas import JobStatus, ReadyFlags, StatusResponse

    reg = Registry(redis_conn)
    reg.set_status("k2", StatusResponse(status=JobStatus.ready, stage="done", progress=1.0,
                                        ready=ReadyFlags(features=True)))
    st = reg.get_status("k2")
    assert st.status == JobStatus.ready
    assert st.ready.features is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/common/test_registry.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'pathagent.common.registry'`

- [ ] **Step 3: Write the implementations**

```python
# src/pathagent/common/connection.py
from functools import lru_cache

from redis import Redis

from .config import get_settings


@lru_cache
def get_job_redis() -> Redis:
    """Redis connection used by RQ jobs (built from settings). Tests monkeypatch this."""
    return Redis.from_url(get_settings().redis_url)
```

```python
# src/pathagent/common/registry.py
from redis import Redis

from .schemas import JobStatus, StatusResponse


def _key(cache_key: str) -> str:
    return f"pathagent:case:{cache_key}"


class Registry:
    """Stores per-cache-key job status as JSON in Redis."""

    def __init__(self, conn: Redis) -> None:
        self.conn = conn

    def set_status(self, cache_key: str, status: StatusResponse) -> None:
        self.conn.set(_key(cache_key), status.model_dump_json(by_alias=True))

    def get_status(self, cache_key: str) -> StatusResponse | None:
        raw = self.conn.get(_key(cache_key))
        if raw is None:
            return None
        return StatusResponse.model_validate_json(raw)

    def create(self, cache_key: str) -> StatusResponse:
        status = StatusResponse(status=JobStatus.queued, stage="queued", progress=0.0)
        self.set_status(cache_key, status)
        return status
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/common/test_registry.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add src/pathagent/common/connection.py src/pathagent/common/registry.py tests/common/test_registry.py
git commit -m "feat(pathagent): add Redis status registry and job connection"
```

---

## Task 5: Fake preprocessor job (`worker/fake_preprocess.py`)

**Files:**
- Create: `services/pathagent/src/pathagent/worker/fake_preprocess.py`
- Test: `services/pathagent/tests/worker/test_fake_preprocess.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/worker/test_fake_preprocess.py
import json


def test_fake_preprocess_sets_ready_and_writes_manifest(job_redis, tmp_cache):
    from pathagent.common.cache_keys import cache_paths
    from pathagent.common.registry import Registry
    from pathagent.common.schemas import JobStatus
    from pathagent.worker.fake_preprocess import run_fake_preprocess

    payload = {"backbone": {"patchEncoder": "conch_v1", "mag": 20, "patchSize": 256}, "slidechat": True}
    run_fake_preprocess("item9-abc", "item9", payload)

    st = Registry(job_redis).get_status("item9-abc")
    assert st.status == JobStatus.ready
    assert st.ready.features is True

    manifest = cache_paths("item9-abc").manifest
    assert manifest.exists()
    assert json.loads(manifest.read_text())["itemId"] == "item9"


def test_fake_preprocess_records_error(job_redis, tmp_cache, monkeypatch):
    from pathagent.common.registry import Registry
    from pathagent.common.schemas import JobStatus
    from pathagent.worker import fake_preprocess

    # Force the manifest write to blow up.
    def boom(*_a, **_k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(fake_preprocess, "_write_stub_manifest", boom)
    try:
        fake_preprocess.run_fake_preprocess("item9-err", "item9", {})
    except RuntimeError:
        pass
    st = Registry(job_redis).get_status("item9-err")
    assert st.status == JobStatus.error
    assert "disk full" in (st.error or "")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/worker/test_fake_preprocess.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'pathagent.worker.fake_preprocess'`

- [ ] **Step 3: Write the implementation**

```python
# src/pathagent/worker/fake_preprocess.py
import json
import logging

from ..common.cache_keys import cache_paths
from ..common.connection import get_job_redis
from ..common.registry import Registry
from ..common.schemas import JobStatus, ReadyFlags, StatusResponse

logger = logging.getLogger(__name__)


def run_fake_preprocess(cache_key: str, item_id: str, request_payload: dict) -> None:
    """M0 stand-in for the Trident worker: simulate stages, write a stub manifest, mark ready.

    Plan 2 (M1) replaces this with the real seg -> coords -> CONCH feature pipeline.
    """
    registry = Registry(get_job_redis())
    try:
        registry.set_status(
            cache_key,
            StatusResponse(status=JobStatus.running, stage="segmentation", progress=0.1),
        )
        paths = cache_paths(cache_key)
        paths.root.mkdir(parents=True, exist_ok=True)
        _write_stub_manifest(paths.manifest, cache_key, item_id, request_payload)
        registry.set_status(
            cache_key,
            StatusResponse(
                status=JobStatus.ready,
                stage="done",
                progress=1.0,
                ready=ReadyFlags(features=True, slidechat=False, classifiers=False),
            ),
        )
        logger.info("fake preprocess complete: %s", cache_key)
    except Exception as exc:  # noqa: BLE001 - any failure becomes a visible job error
        logger.exception("fake preprocess failed: %s", cache_key)
        registry.set_status(
            cache_key,
            StatusResponse(status=JobStatus.error, stage="error", error=str(exc)),
        )
        raise


def _write_stub_manifest(path, cache_key: str, item_id: str, request_payload: dict) -> None:
    path.write_text(
        json.dumps(
            {"cacheKey": cache_key, "itemId": item_id, "request": request_payload, "stub": True},
            indent=2,
        )
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/worker/test_fake_preprocess.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add src/pathagent/worker/fake_preprocess.py tests/worker/test_fake_preprocess.py
git commit -m "feat(pathagent): add M0 fake preprocessor job"
```

---

## Task 6: Auth passthrough (`gateway/auth.py`)

**Files:**
- Create: `services/pathagent/src/pathagent/gateway/auth.py`
- Test: `services/pathagent/tests/gateway/test_auth.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/gateway/test_auth.py
import httpx
import pytest
import respx
from fastapi import HTTPException


@respx.mock
async def test_require_user_ok(monkeypatch):
    from pathagent.common.config import get_settings
    from pathagent.gateway.auth import require_user

    monkeypatch.setenv("PATHAGENT_GIRDER_BASE", "https://girder.test/api/v1")
    get_settings.cache_clear()
    respx.get("https://girder.test/api/v1/user/me").mock(
        return_value=httpx.Response(200, json={"_id": "u1", "login": "doc"})
    )
    user = await require_user(girder_token="tok")
    assert user["_id"] == "u1"
    get_settings.cache_clear()


@respx.mock
async def test_require_user_rejects_bad_token(monkeypatch):
    from pathagent.common.config import get_settings
    from pathagent.gateway.auth import require_user

    monkeypatch.setenv("PATHAGENT_GIRDER_BASE", "https://girder.test/api/v1")
    get_settings.cache_clear()
    respx.get("https://girder.test/api/v1/user/me").mock(return_value=httpx.Response(401, json={}))
    with pytest.raises(HTTPException) as exc:
        await require_user(girder_token="bad")
    assert exc.value.status_code == 401
    get_settings.cache_clear()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/gateway/test_auth.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'pathagent.gateway.auth'`

- [ ] **Step 3: Write the implementation**

```python
# src/pathagent/gateway/auth.py
import httpx
from fastapi import Header, HTTPException, status

from ..common.config import get_settings


async def require_user(girder_token: str = Header(..., alias="Girder-Token")) -> dict:
    """Validate the caller's Girder token by calling Girder's /user/me."""
    settings = get_settings()
    async with httpx.AsyncClient(base_url=settings.girder_base, timeout=10) as client:
        resp = await client.get("/user/me", headers={"Girder-Token": girder_token})
    if resp.status_code != 200 or not resp.json():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Girder token")
    return resp.json()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/gateway/test_auth.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add src/pathagent/gateway/auth.py tests/gateway/test_auth.py
git commit -m "feat(pathagent): add Girder token auth passthrough"
```

---

## Task 7: Preprocess queue (`gateway/queue.py`)

**Files:**
- Create: `services/pathagent/src/pathagent/gateway/queue.py`
- Test: `services/pathagent/tests/gateway/test_queue.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/gateway/test_queue.py
def test_enqueue_runs_job_inline(redis_conn, monkeypatch):
    from pathagent.common.schemas import FeatureSpec, PreprocessRequest
    from pathagent.gateway.queue import PreprocessQueue
    from pathagent.worker import fake_preprocess

    calls = []
    monkeypatch.setattr(
        fake_preprocess, "run_fake_preprocess", lambda *a: calls.append(a)
    )

    q = PreprocessQueue(redis_conn, is_async=False)  # is_async=False runs the job inline
    req = PreprocessRequest(backbone=FeatureSpec(patchEncoder="conch_v1"))
    job_id = q.enqueue_preprocess("item1-abc", "item1", req)

    assert isinstance(job_id, str) and job_id
    assert len(calls) == 1
    cache_key, item_id, payload = calls[0]
    assert cache_key == "item1-abc"
    assert item_id == "item1"
    assert payload["backbone"]["patchEncoder"] == "conch_v1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/gateway/test_queue.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'pathagent.gateway.queue'`

- [ ] **Step 3: Write the implementation**

```python
# src/pathagent/gateway/queue.py
from redis import Redis
from rq import Queue

from ..common.schemas import PreprocessRequest
from ..worker.fake_preprocess import run_fake_preprocess

QUEUE_NAME = "pathagent"


class PreprocessQueue:
    """Thin wrapper around an RQ queue for preprocessing jobs."""

    def __init__(self, conn: Redis, is_async: bool = True) -> None:
        self.queue = Queue(QUEUE_NAME, connection=conn, is_async=is_async)

    def enqueue_preprocess(self, cache_key: str, item_id: str, request: PreprocessRequest) -> str:
        job = self.queue.enqueue(
            run_fake_preprocess, cache_key, item_id, request.model_dump(by_alias=True)
        )
        return job.id
```

> Note: RQ resolves the job by its import path `pathagent.worker.fake_preprocess.run_fake_preprocess`, so the test's `monkeypatch.setattr(fake_preprocess, "run_fake_preprocess", ...)` is picked up when `is_async=False`. In Plan 2 you swap `run_fake_preprocess` for the real Trident job here.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/gateway/test_queue.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add src/pathagent/gateway/queue.py tests/gateway/test_queue.py
git commit -m "feat(pathagent): add RQ preprocess queue"
```

---

## Task 8: Routes (`gateway/deps.py`, `gateway/routes.py`)

**Files:**
- Create: `services/pathagent/src/pathagent/gateway/deps.py`
- Create: `services/pathagent/src/pathagent/gateway/routes.py`
- Test: `services/pathagent/tests/gateway/test_routes.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/gateway/test_routes.py
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(redis_conn, monkeypatch):
    from pathagent.common.registry import Registry
    from pathagent.gateway.app import create_app
    from pathagent.gateway.auth import require_user
    from pathagent.gateway.queue import PreprocessQueue
    from pathagent.worker import fake_preprocess

    # Don't run the real job body during route tests.
    monkeypatch.setattr(fake_preprocess, "run_fake_preprocess", lambda *a: None)
    app = create_app(redis_conn=redis_conn, queue=PreprocessQueue(redis_conn, is_async=False))
    app.dependency_overrides[require_user] = lambda: {"_id": "u1"}
    c = TestClient(app)
    c.registry = Registry(redis_conn)  # handle for assertions
    return c


def _body():
    return {"backbone": {"patchEncoder": "conch_v1", "mag": 20, "patchSize": 256}, "slidechat": True}


def test_preprocess_enqueues_and_returns_cache_key(client):
    resp = client.post("/api/agent/cases/item42/preprocess", json=_body())
    assert resp.status_code == 202
    data = resp.json()
    assert data["cacheKey"].startswith("item42-")
    assert data["status"] == "queued"


def test_status_reflects_registry(client):
    resp = client.post("/api/agent/cases/item42/preprocess", json=_body())
    cache_key = resp.json()["cacheKey"]
    st = client.get(f"/api/agent/cases/item42/status", params={"cacheKey": cache_key})
    assert st.status_code == 200
    assert st.json()["status"] in ("queued", "running", "ready")


def test_status_unknown_key(client):
    st = client.get("/api/agent/cases/item42/status", params={"cacheKey": "nope"})
    assert st.status_code == 200
    assert st.json()["status"] == "error"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/gateway/test_routes.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'pathagent.gateway.routes'` (or `...app`)

- [ ] **Step 3: Write the implementations**

```python
# src/pathagent/gateway/deps.py
from fastapi import Request

from ..common.registry import Registry
from .queue import PreprocessQueue


def get_registry(request: Request) -> Registry:
    return request.app.state.registry


def get_queue(request: Request) -> PreprocessQueue:
    return request.app.state.queue
```

```python
# src/pathagent/gateway/routes.py
from fastapi import APIRouter, Depends

from ..common.cache_keys import compute_cache_key
from ..common.registry import Registry
from ..common.schemas import JobStatus, PreprocessRequest, PreprocessResponse, StatusResponse
from .auth import require_user
from .deps import get_queue, get_registry
from .queue import PreprocessQueue

router = APIRouter(prefix="/api/agent")


@router.post("/cases/{item_id}/preprocess", response_model=PreprocessResponse, status_code=202)
async def preprocess(
    item_id: str,
    request: PreprocessRequest,
    user: dict = Depends(require_user),
    registry: Registry = Depends(get_registry),
    queue: PreprocessQueue = Depends(get_queue),
) -> PreprocessResponse:
    cache_key = compute_cache_key(item_id, request)
    existing = registry.get_status(cache_key)
    if existing and existing.status == JobStatus.ready:
        return PreprocessResponse(job_id="cached", cache_key=cache_key, status=JobStatus.ready)
    registry.create(cache_key)
    job_id = queue.enqueue_preprocess(cache_key, item_id, request)
    return PreprocessResponse(job_id=job_id, cache_key=cache_key, status=JobStatus.queued)


@router.get("/cases/{item_id}/status", response_model=StatusResponse)
async def get_status(
    item_id: str,
    cacheKey: str,  # noqa: N803 - camelCase query param matches the wire contract
    user: dict = Depends(require_user),
    registry: Registry = Depends(get_registry),
) -> StatusResponse:
    found = registry.get_status(cacheKey)
    if found is None:
        return StatusResponse(status=JobStatus.error, stage="unknown", error="no such cacheKey")
    return found
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/gateway/test_routes.py -v` (this needs `app.py` from Task 9; if you are doing tasks strictly in order, run after Task 9 — or add a minimal `create_app` now.)
Expected: after Task 9, PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/pathagent/gateway/deps.py src/pathagent/gateway/routes.py tests/gateway/test_routes.py
git commit -m "feat(pathagent): add preprocess and status routes"
```

---

## Task 9: App factory + stream/heatmap stubs (`gateway/app.py`)

**Files:**
- Create: `services/pathagent/src/pathagent/gateway/app.py`
- Test: `services/pathagent/tests/gateway/test_app_stubs.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/gateway/test_app_stubs.py
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(redis_conn):
    from pathagent.gateway.app import create_app
    from pathagent.gateway.queue import PreprocessQueue

    app = create_app(redis_conn=redis_conn, queue=PreprocessQueue(redis_conn, is_async=False))
    return TestClient(app)


def test_query_stub_streams_events(client):
    resp = client.post("/api/agent/query", json={"itemId": "x", "question": "?"})
    assert resp.status_code == 200
    body = resp.text
    assert "route" in body and "navigate" in body and "final" in body


def test_heatmap_stub(client):
    resp = client.get("/api/agent/cases/x/heatmap/t1")
    assert resp.status_code == 200
    assert resp.json()["taskId"] == "t1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/gateway/test_app_stubs.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'pathagent.gateway.app'`

- [ ] **Step 3: Write the implementation**

```python
# src/pathagent/gateway/app.py
import json

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from redis import Redis

from ..common.config import get_settings
from ..common.registry import Registry
from .queue import PreprocessQueue
from .routes import router


def create_app(redis_conn: Redis | None = None, queue: PreprocessQueue | None = None) -> FastAPI:
    settings = get_settings()
    conn = redis_conn or Redis.from_url(settings.redis_url)

    app = FastAPI(title="PathAgent Gateway", version="0.1.0")
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )
    app.state.settings = settings
    app.state.redis = conn
    app.state.registry = Registry(conn)
    app.state.queue = queue or PreprocessQueue(conn)
    app.include_router(router)
    _add_stubs(app)
    return app


def _add_stubs(app: FastAPI) -> None:
    """M0 placeholders so the frontend (Plan 5) can integrate early.

    Plan 4 (M3) replaces /query with the LangGraph orchestrator and adds the real heatmap tiles.
    """

    @app.post("/api/agent/query")
    async def query_stub(payload: dict) -> StreamingResponse:
        events = [
            {"type": "route", "task": "Diagnosis", "tools": ["navigate", "verify"]},
            {"type": "triage", "risk": "unknown", "depth": 3},
            {"type": "navigate", "region": {"x": 0, "y": 0, "width": 1024, "height": 1024},
             "zoom": 20, "rationale": "stub region"},
            {"type": "final", "answer": "stub answer", "confidence": 0.0,
             "heatmapTaskId": "stub", "trail": [], "annotations": []},
        ]

        def gen():
            for event in events:
                yield f"data: {json.dumps(event)}\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    @app.get("/api/agent/cases/{item_id}/heatmap/{task_id}")
    async def heatmap_stub(item_id: str, task_id: str) -> dict:
        return {"stub": True, "itemId": item_id, "taskId": task_id}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/gateway/test_app_stubs.py tests/gateway/test_routes.py -v`
Expected: PASS (test_app_stubs: 2 passed; test_routes: 3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/pathagent/gateway/app.py tests/gateway/test_app_stubs.py
git commit -m "feat(pathagent): add app factory with stream/heatmap stubs"
```

---

## Task 10: End-to-end cycle test

**Files:**
- Test: `services/pathagent/tests/test_end_to_end.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_end_to_end.py
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(redis_conn, job_redis, tmp_cache):
    # job_redis makes the inline fake job write status to the SAME fakeredis the app reads.
    from pathagent.gateway.app import create_app
    from pathagent.gateway.auth import require_user
    from pathagent.gateway.queue import PreprocessQueue

    app = create_app(redis_conn=redis_conn, queue=PreprocessQueue(redis_conn, is_async=False))
    app.dependency_overrides[require_user] = lambda: {"_id": "u1"}
    return TestClient(app)


def test_preprocess_to_ready(client, tmp_cache):
    from pathagent.common.cache_keys import cache_paths

    body = {"backbone": {"patchEncoder": "conch_v1", "mag": 20, "patchSize": 256}, "slidechat": True}
    resp = client.post("/api/agent/cases/item77/preprocess", json=body)
    cache_key = resp.json()["cacheKey"]

    # is_async=False ran the fake job inline during enqueue, so status is already ready.
    st = client.get("/api/agent/cases/item77/status", params={"cacheKey": cache_key})
    assert st.json()["status"] == "ready"
    assert st.json()["ready"]["features"] is True
    assert cache_paths(cache_key).manifest.exists()
```

> Wiring note: this test uses **both** `redis_conn` (the app's registry) and `job_redis` (the worker's `get_job_redis`). Because the `job_redis` fixture points `get_job_redis()` at the same `redis_conn` instance, the inline job and the app share one store.

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `uv run pytest tests/test_end_to_end.py -v`
Expected: If all prior tasks are implemented, PASS (1 passed). If not, it fails on the missing module — implement the referenced module and re-run.

- [ ] **Step 3: Run the full suite**

Run: `uv run pytest -q`
Expected: all tests pass (roughly 15 passed).

- [ ] **Step 4: Commit**

```bash
git add tests/test_end_to_end.py
git commit -m "test(pathagent): end-to-end preprocess→ready cycle"
```

---

## Task 11: Containerization + README

**Files:**
- Create: `services/pathagent/Dockerfile`
- Create: `services/pathagent/docker-compose.yml`
- Create: `services/pathagent/README.md`

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# services/pathagent/Dockerfile
FROM python:3.11-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN uv sync --no-dev
ENV PATHAGENT_REDIS_URL=redis://redis:6379/0
EXPOSE 8000
CMD ["uv", "run", "uvicorn", "pathagent.gateway.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 2: Write docker-compose.yml**

```yaml
# services/pathagent/docker-compose.yml
services:
  redis:
    image: redis:7
    ports: ["6379:6379"]
  gateway:
    build: .
    ports: ["8000:8000"]
    environment:
      PATHAGENT_REDIS_URL: redis://redis:6379/0
    depends_on: [redis]
  worker:
    build: .
    command: uv run rq worker pathagent --url redis://redis:6379/0
    environment:
      PATHAGENT_REDIS_URL: redis://redis:6379/0
    volumes:
      - pathagent-cache:/data/pathagent-cache
    depends_on: [redis]
volumes:
  pathagent-cache:
```

- [ ] **Step 3: Write the README**

```markdown
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
```

- [ ] **Step 4: Verify the container builds and serves**

Run: `docker compose up --build -d && sleep 5 && curl -s localhost:8000/openapi.json | head -c 200 && docker compose down`
Expected: prints the start of the OpenAPI JSON (the service is up).

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml README.md
git commit -m "chore(pathagent): add Dockerfile, compose, and README"
```

---

## Self-review (completed by plan author)

**Spec coverage (M0 slice of the design doc):**
- Gateway FastAPI skeleton, auth passthrough, case registry, job queue, cache layout → Tasks 1–9. ✓
- API contract `preprocess` / `status` → Tasks 8. ✓ (bodies/fields match design §6, camelCase.)
- "Stubbed endpoints return well-formed (incl. mock `navigate`) events" (design M0 done-criterion) → Task 9 SSE stub emits `route`/`triage`/`navigate`/`final`. ✓
- Params-hash cache keys, idempotent (ready short-circuit) → Task 3 + Task 8 (`ready` → returns cached). ✓
- Deferred by design to later plans: real Trident (M1/Plan 2), SlideChat/KB (M2a/Plan 3), orchestrator (M3/Plan 4), frontend (M4/Plan 5), eval (M5). ✓ noted.

**Placeholder scan:** no "TBD"/"handle edge cases"/"write tests for the above" — every step has concrete code or an exact command. ✓

**Type consistency:** `PreprocessRequest`/`FeatureSpec`/`StatusResponse`/`ReadyFlags`/`JobStatus` used identically across schemas, registry, job, queue, routes; `compute_cache_key(item_id, request)`, `cache_paths(cache_key).manifest/.features(encoder)`, `Registry.get_status/set_status/create`, `PreprocessQueue.enqueue_preprocess(cache_key, item_id, request)`, `run_fake_preprocess(cache_key, item_id, payload)`, `get_job_redis()` — signatures match every call site. ✓
