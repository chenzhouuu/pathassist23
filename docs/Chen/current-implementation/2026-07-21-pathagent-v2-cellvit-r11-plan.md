# R11 CellViT — Service Framework + Gateway Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a real HTTP **CellViT inference microservice** (running a stub model) and wire the gateway's `run_segmentation` tool to call it, so the copilot segments a region end-to-end behind the existing `ArtifactHandle` → overlay contract — with **zero GPU** and full test coverage.

**Architecture:** A new `services/cellvit` FastAPI app owns *region-read → infer → coordinate re-offset*; the model is a deterministic stub here (real CellViT-SAM-H swaps in behind the `infer.segment_array` seam in the GPU follow-up). The gateway's `run_server_tool` calls the service over a tiny region-scoped HTTP contract when `AGENT_CELLVIT_SERVICE_URL` is set, else keeps the canned stub. The Girder token rides `ToolContext` server-side (D3) — never a model argument. Every bbox in / centroid out is **level-0 slide pixels** (D8).

**Tech Stack:** Python 3.11, FastAPI, `uv`, httpx, numpy, Pillow, pytest, sse-starlette (gateway). Spec: `docs/Chen/2026-07-21-pathagent-v2-cellvit-r11-deployment-design.md`.

## Global Constraints

- **TDD, Iron Law:** no production code without a failing test first (except the pure-scaffold `pyproject.toml`/`__init__.py` in Task 1).
- **English** for all code, comments, docstrings, commit messages. Talk to Chen in Chinese.
- **`uv`** for Python deps and running tests (`uv run pytest`). Line length **≤ 100** (ruff).
- **Coordinate frame:** every bbox and centroid crossing a boundary is **level-0 slide pixels** (D8). bbox shape: `{x, y, width, height}` (may also carry `kind`/`unit`, ignored).
- **D3:** the Girder token is passed server-to-server (gateway → CellViT service); it is NEVER a model-visible tool argument.
- **Commit only when Chen explicitly asks.** The per-task "Commit" steps mark the intended boundaries; the executor stages them but batches the actual `git commit` for Chen's go-ahead. End messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Never commit** `.env`/secrets or unrelated WIP.

---

## File Structure

**New service — `services/cellvit/`:**
- `pyproject.toml` — deps: fastapi, uvicorn, httpx, numpy, pillow, pytest. (torch + `cellvit` are GPU-only, added in the follow-up Dockerfile; imported lazily in `infer.py`.)
- `src/cellvit_service/__init__.py`
- `src/cellvit_service/config.py` — `Settings` (girder_base, device); env prefix `CELLVIT_`.
- `src/cellvit_service/geometry.py` — `offset_points()` pure coordinate re-offset.
- `src/cellvit_service/region.py` — `fetch_region()` Girder `large_image` region reader → `RegionImage`.
- `src/cellvit_service/infer.py` — `segment_array()` region-local centroids (STUB here; real CellViT in the follow-up).
- `src/cellvit_service/app.py` — FastAPI: `GET /health`, `POST /segment`; injectable `read_region`/`segment` via `app.state`.
- `tests/conftest.py`, `tests/test_geometry.py`, `tests/test_region.py`, `tests/test_segment_route.py`

**Gateway — `services/agent/` (modify):**
- `src/agent/common/config.py` — add `cellvit_service_url`.
- `src/agent/loop/tools.py` — `ToolContext` gains `girder_token` + `cellvit_url`; `run_server_tool` gains the real segmentation path.
- `src/agent/loop/segmenter.py` — **new** — `segment_region()` HTTP client to the service.
- `src/agent/loop/sdk_tools.py` — `run_segmentation` schema gains optional `bbox`.
- `src/agent/gateway/routes.py` — `get_girder_token` dep; thread token + service URL into `ToolContext`.
- `tests/test_segmenter.py` **new**; extend `tests/test_loop_tools.py`.

---

## Task 1: CellViT service scaffold + `/health`

**Files:**
- Create: `services/cellvit/pyproject.toml`
- Create: `services/cellvit/src/cellvit_service/__init__.py`
- Create: `services/cellvit/src/cellvit_service/config.py`
- Create: `services/cellvit/src/cellvit_service/app.py`
- Create: `services/cellvit/tests/test_segment_route.py` (health test only for now)

**Interfaces:**
- Produces: `create_app() -> FastAPI` with `GET /health → {"status","service","device"}`.

- [ ] **Step 1: Scaffold the package (no test — pure config)**

`services/cellvit/pyproject.toml`:
```toml
[project]
name = "cellvit-service"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.111",
    "uvicorn>=0.30",
    "httpx>=0.27",
    "numpy>=1.26",
    "pillow>=10.0",
]

[dependency-groups]
dev = ["pytest>=8.0"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/cellvit_service"]

[tool.pytest.ini_options]
pythonpath = ["src"]
```

`services/cellvit/src/cellvit_service/__init__.py`: (empty)

`services/cellvit/src/cellvit_service/config.py`:
```python
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """CellViT service config, overridable via CELLVIT_* env vars."""

    model_config = SettingsConfigDict(env_prefix="CELLVIT_", env_file=".env", extra="ignore")

    # The Girder whose large_image region endpoint we read WSI pixels from.
    girder_base: str = "https://lymphoma.dev.pathassist.health/api/v1"
    device: str = "cuda"  # the real model needs a GPU; the stub ignores this


@lru_cache
def get_settings() -> Settings:
    return Settings()
```
Add `pydantic-settings>=2.0` to `dependencies` in `pyproject.toml`.

- [ ] **Step 2: Write the failing health test**

`services/cellvit/tests/test_segment_route.py`:
```python
from starlette.testclient import TestClient

from cellvit_service.app import create_app


def test_health_ok():
    client = TestClient(create_app())
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "cellvit"
```

- [ ] **Step 3: Run it — expect failure**

Run: `cd services/cellvit && uv run pytest tests/test_segment_route.py -v`
Expected: FAIL (`ModuleNotFoundError: cellvit_service.app`).

- [ ] **Step 4: Implement `app.py` with `/health`**

`services/cellvit/src/cellvit_service/app.py`:
```python
from fastapi import FastAPI

from .config import get_settings


def create_app() -> FastAPI:
    """The CellViT inference service. Region-read → infer → re-offset, over HTTP."""
    app = FastAPI(title="CellViT Inference Service", version="0.1.0")

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok", "service": "cellvit", "device": get_settings().device}

    return app
```

- [ ] **Step 5: Run — expect pass**

Run: `cd services/cellvit && uv run pytest tests/test_segment_route.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/cellvit/pyproject.toml services/cellvit/src services/cellvit/tests
git commit  # feat(cellvit): service scaffold + health  (on Chen's go-ahead)
```

---

## Task 2: Coordinate re-offset (the riskiest math)

**Files:**
- Create: `services/cellvit/src/cellvit_service/geometry.py`
- Create: `services/cellvit/tests/test_geometry.py`

**Interfaces:**
- Produces: `offset_points(points: list[list[float]], origin_x: float, origin_y: float, scale: float = 1.0) -> list[list[float]]` — maps region-local `[x, y]` centroids to level-0 slide pixels via `level0 = local * scale + origin`.

- [ ] **Step 1: Write the failing test**

`services/cellvit/tests/test_geometry.py`:
```python
from cellvit_service.geometry import offset_points


def test_offset_adds_region_origin_at_native_scale():
    # native magnification: scale=1, just add the bbox origin
    pts = [[0.0, 0.0], [10.0, 20.0]]
    assert offset_points(pts, 100.0, 200.0) == [[100.0, 200.0], [110.0, 220.0]]


def test_offset_applies_scale_before_origin():
    # region requested at 2x upsample: local coords are 2x the level-0 region scale
    pts = [[10.0, 10.0]]
    assert offset_points(pts, 100.0, 100.0, scale=0.5) == [[105.0, 105.0]]


def test_offset_empty_is_empty():
    assert offset_points([], 5.0, 5.0) == []
```

- [ ] **Step 2: Run — expect fail**

Run: `cd services/cellvit && uv run pytest tests/test_geometry.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Implement**

`services/cellvit/src/cellvit_service/geometry.py`:
```python
"""Coordinate re-offset: region-local centroids → level-0 slide pixels (D8).

CellViT sees only the extracted region and returns coordinates local to it. This maps
them back to the slide's level-0 frame: ``level0 = local * scale + origin``. ``scale`` is
1.0 when the region was read at native magnification (the v1 path).
"""


def offset_points(
    points: list[list[float]], origin_x: float, origin_y: float, scale: float = 1.0
) -> list[list[float]]:
    """Map region-local ``[x, y]`` centroids to level-0 slide pixels."""
    return [[x * scale + origin_x, y * scale + origin_y] for x, y in points]
```

- [ ] **Step 4: Run — expect pass**

Run: `cd services/cellvit && uv run pytest tests/test_geometry.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add services/cellvit/src/cellvit_service/geometry.py services/cellvit/tests/test_geometry.py
git commit  # feat(cellvit): level-0 coordinate re-offset  (on Chen's go-ahead)
```

---

## Task 3: Girder region reader

**Files:**
- Create: `services/cellvit/src/cellvit_service/region.py`
- Create: `services/cellvit/tests/test_region.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `@dataclass(frozen=True) RegionImage: pixels: numpy.ndarray; mpp: float | None; scale: float`
  - `async def fetch_region(*, girder_base: str, slide_ref: str, bbox: dict, token: str | None, client: httpx.AsyncClient | None = None) -> RegionImage` — GETs the region PNG from `large_image` and decodes it to an RGB ndarray. v1 reads at native magnification, so `scale = 1.0`.

- [ ] **Step 1: Write the failing test (httpx MockTransport — no network)**

`services/cellvit/tests/test_region.py`:
```python
import io

import httpx
import numpy as np
import pytest
from PIL import Image

from cellvit_service.region import fetch_region


def _png_bytes(w: int, h: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (128, 64, 200)).save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_fetch_region_requests_bbox_and_decodes_pixels():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["token"] = request.headers.get("Girder-Token")
        return httpx.Response(200, content=_png_bytes(64, 48),
                              headers={"Content-Type": "image/png"})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport, base_url="http://g") as client:
        region = await fetch_region(
            girder_base="http://g", slide_ref="item1",
            bbox={"x": 100, "y": 200, "width": 64, "height": 48},
            token="tok", client=client,
        )

    assert region.pixels.shape == (48, 64, 3)  # (H, W, C)
    assert region.scale == 1.0
    assert seen["token"] == "tok"
    assert "/item/item1/tiles/region" in seen["url"]
    assert "left=100" in seen["url"] and "top=200" in seen["url"]
    assert "right=164" in seen["url"] and "bottom=248" in seen["url"]
```

Add `pytest-asyncio>=0.23` to the dev group in `pyproject.toml`, and under `[tool.pytest.ini_options]` add `asyncio_mode = "auto"`.

- [ ] **Step 2: Run — expect fail**

Run: `cd services/cellvit && uv run pytest tests/test_region.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Implement**

`services/cellvit/src/cellvit_service/region.py`:
```python
"""Read a slide region's pixels from Girder's large_image ``region`` endpoint.

CellViT has no region API — it is WSI-centric. We extract the ROI ourselves at the
slide's native magnification (so 1 region pixel = 1 level-0 pixel, ``scale = 1.0``) and
hand the array to the model. The Girder token authenticates the read; it never reaches the
model (D3).
"""

import io
from dataclasses import dataclass

import httpx
import numpy as np
from PIL import Image


@dataclass(frozen=True)
class RegionImage:
    """An extracted slide region: RGB pixels + the level-0→region scale used to read it."""

    pixels: np.ndarray  # (H, W, 3), uint8
    mpp: float | None
    scale: float


async def fetch_region(
    *,
    girder_base: str,
    slide_ref: str,
    bbox: dict,
    token: str | None,
    client: httpx.AsyncClient | None = None,
) -> RegionImage:
    """GET the ROI as a PNG from large_image and decode it to an RGB ndarray."""
    left = int(bbox["x"])
    top = int(bbox["y"])
    right = left + int(bbox["width"])
    bottom = top + int(bbox["height"])
    params = {"left": left, "top": top, "right": right, "bottom": bottom, "encoding": "PNG"}
    headers = {"Girder-Token": token} if token else {}
    path = f"/item/{slide_ref}/tiles/region"

    owns = client is None
    client = client or httpx.AsyncClient(base_url=girder_base, timeout=60)
    try:
        resp = await client.get(path, params=params, headers=headers)
        resp.raise_for_status()
        image = Image.open(io.BytesIO(resp.content)).convert("RGB")
    finally:
        if owns:
            await client.aclose()
    return RegionImage(pixels=np.asarray(image), mpp=None, scale=1.0)
```

- [ ] **Step 4: Run — expect pass**

Run: `cd services/cellvit && uv run pytest tests/test_region.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/cellvit/src/cellvit_service/region.py services/cellvit/tests/test_region.py services/cellvit/pyproject.toml
git commit  # feat(cellvit): read a slide region from Girder large_image  (on Chen's go-ahead)
```

---

## Task 4: Stub inference + `/segment` route (end-to-end, no model)

**Files:**
- Create: `services/cellvit/src/cellvit_service/infer.py`
- Modify: `services/cellvit/src/cellvit_service/app.py`
- Modify: `services/cellvit/tests/test_segment_route.py`

**Interfaces:**
- Consumes: `fetch_region(...) -> RegionImage`, `offset_points(...)`.
- Produces:
  - `def segment_array(pixels: numpy.ndarray, mpp: float | None) -> list[list[float]]` — region-local `[x, y]` centroids. **STUB:** a deterministic 32-px grid over the region (the real CellViT-SAM-H swaps in behind this signature in the GPU follow-up).
  - `POST /segment` body `{slide_ref, bbox:{x,y,width,height}, girder_token, classes?}` → `{count, centroids, bbox}` where `centroids` are level-0 `[x, y]`.
  - `app.state.read_region` / `app.state.segment` — the injectable region-reader / model, overridable in tests.

- [ ] **Step 1: Write the failing route test (fakes injected via app.state)**

Append to `services/cellvit/tests/test_segment_route.py`:
```python
import numpy as np

from cellvit_service.region import RegionImage


def _client_with_fakes():
    from cellvit_service.app import create_app
    app = create_app()

    async def fake_read_region(*, girder_base, slide_ref, bbox, token, client=None):
        return RegionImage(pixels=np.zeros((48, 64, 3), dtype=np.uint8), mpp=None, scale=1.0)

    def fake_segment(pixels, mpp):
        return [[0.0, 0.0], [10.0, 20.0]]  # two region-local centroids

    app.state.read_region = fake_read_region
    app.state.segment = fake_segment
    return TestClient(app)


def test_segment_returns_level0_centroids_and_count():
    client = _client_with_fakes()
    r = client.post("/segment", json={
        "slide_ref": "item1",
        "bbox": {"x": 100, "y": 200, "width": 64, "height": 48},
        "girder_token": "tok",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    # region-local [0,0] and [10,20] re-offset by the bbox origin (scale 1)
    assert body["centroids"] == [[100.0, 200.0], [110.0, 220.0]]
```

- [ ] **Step 2: Run — expect fail**

Run: `cd services/cellvit && uv run pytest tests/test_segment_route.py -v`
Expected: FAIL (`test_segment_...` — `/segment` 404 / attribute errors).

- [ ] **Step 3: Implement the stub model**

`services/cellvit/src/cellvit_service/infer.py`:
```python
"""Nucleus segmentation on an extracted region → region-local centroids.

STUB implementation: a deterministic 32-px grid, so the whole service + gateway pipeline
is testable and demonstrable without a GPU. The real CellViT-SAM-H model swaps in behind
this exact signature in the GPU follow-up (see the R11 deployment design, §3.2) — it will
lazily import ``cellvit`` and run inference on ``pixels`` (using ``mpp`` to match its
0.25 µm/px training scale).
"""

import numpy as np

_STUB_STRIDE = 32


def segment_array(pixels: np.ndarray, mpp: float | None) -> list[list[float]]:
    """Return region-local ``[x, y]`` nucleus centroids for the region ``pixels``."""
    h, w = pixels.shape[:2]
    return [
        [float(x), float(y)]
        for y in range(0, h, _STUB_STRIDE)
        for x in range(0, w, _STUB_STRIDE)
    ]
```

- [ ] **Step 4: Wire the `/segment` route**

Replace `services/cellvit/src/cellvit_service/app.py` with:
```python
from fastapi import FastAPI, Request
from pydantic import BaseModel, Field

from .config import get_settings
from .geometry import offset_points
from .infer import segment_array
from .region import fetch_region


class Bbox(BaseModel):
    x: float
    y: float
    width: float
    height: float
    kind: str = "rect"
    unit: str = "px"


class SegmentRequest(BaseModel):
    slide_ref: str = Field(..., min_length=1)
    bbox: Bbox
    girder_token: str | None = None
    classes: list[str] | None = None


def create_app() -> FastAPI:
    """The CellViT inference service. Region-read → infer → re-offset, over HTTP."""
    app = FastAPI(title="CellViT Inference Service", version="0.1.0")
    app.state.read_region = fetch_region   # injectable seams (tests override these)
    app.state.segment = segment_array

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok", "service": "cellvit", "device": get_settings().device}

    @app.post("/segment")
    async def segment(body: SegmentRequest, request: Request) -> dict:
        settings = get_settings()
        bbox = body.bbox.model_dump()
        region = await request.app.state.read_region(
            girder_base=settings.girder_base, slide_ref=body.slide_ref,
            bbox=bbox, token=body.girder_token,
        )
        local = request.app.state.segment(region.pixels, region.mpp)
        centroids = offset_points(local, bbox["x"], bbox["y"], region.scale)
        return {"count": len(centroids), "centroids": centroids, "bbox": bbox}

    return app
```

- [ ] **Step 5: Run — expect pass**

Run: `cd services/cellvit && uv run pytest -v`
Expected: PASS (health + region + geometry + segment).

- [ ] **Step 6: Commit**

```bash
git add services/cellvit/src/cellvit_service services/cellvit/tests
git commit  # feat(cellvit): /segment pipeline on a stub model  (on Chen's go-ahead)
```

---

## Task 5: Thread the Girder token + service URL into `ToolContext`

**Files:**
- Modify: `services/agent/src/agent/common/config.py`
- Modify: `services/agent/src/agent/loop/tools.py` (`ToolContext`)
- Modify: `services/agent/src/agent/gateway/routes.py`
- Modify: `services/agent/tests/test_agent_turn_routes.py`

**Interfaces:**
- Produces: `ToolContext(owner, conversation_id, artifacts=None, girder_token=None, cellvit_url=None)`; `get_girder_token()` dep returning the request's `Girder-Token` (or None); `Settings.cellvit_service_url: str`.

- [ ] **Step 1: Write the failing test — the token + URL reach the loop's `ctx`**

Append to `services/agent/tests/test_agent_turn_routes.py`:
```python
def test_turn_threads_token_and_service_url_into_ctx(client: TestClient):
    """The Girder token + configured CellViT URL reach ToolContext (D3: server-side only)."""
    from agent.gateway.routes import get_agent, get_cellvit_url, get_girder_token
    from agent.loop.events import RunFinished

    seen: dict = {}

    class RecordingLoop:
        async def run(self, *, text, history, scope, viewer=None, ctx=None,
                      approved=False, abort=None):
            seen["token"] = ctx.girder_token
            seen["url"] = ctx.cellvit_url
            yield RunFinished(run_id="r", text="ok")

    client.app.dependency_overrides[get_agent] = lambda: RecordingLoop()
    client.app.dependency_overrides[get_girder_token] = lambda: "tok-123"
    client.app.dependency_overrides[get_cellvit_url] = lambda: "http://cellvit:8020"
    cid = _conv(client)
    client.post(f"/api/copilot/conversations/{cid}/turns", json={"text": "count here"})
    assert seen["token"] == "tok-123"
    assert seen["url"] == "http://cellvit:8020"
```

- [ ] **Step 2: Run — expect fail**

Run: `cd services/agent && uv run pytest tests/test_agent_turn_routes.py::test_turn_threads_token_and_service_url_into_ctx -v`
Expected: FAIL (`ImportError: get_girder_token`).

- [ ] **Step 3: Add the setting**

In `services/agent/src/agent/common/config.py`, after `anthropic_max_tokens`:
```python
    # CellViT inference service (R11). Empty ⇒ run_segmentation keeps the canned stub.
    cellvit_service_url: str = ""
```

- [ ] **Step 4: Extend `ToolContext`**

In `services/agent/src/agent/loop/tools.py`, replace the `ToolContext` dataclass with:
```python
@dataclass(frozen=True)
class ToolContext:
    """Per-turn execution context for server-side data tools: who owns the turn, which
    conversation it belongs to, where bulk output is written (D4), and the server-side
    Girder token + CellViT service URL for real segmentation (R11). The token never enters
    the model (D3)."""

    owner: str
    conversation_id: int
    artifacts: ArtifactStore | None = None
    girder_token: str | None = None
    cellvit_url: str | None = None
```

- [ ] **Step 5: Add the token dep + thread both into `ctx`**

In `services/agent/src/agent/gateway/routes.py`, add `Header` to the fastapi import and two deps after `get_artifacts`:
```python
def get_girder_token(
    girder_token: str | None = Header(default=None, alias="Girder-Token"),
) -> str | None:
    """The caller's raw Girder token, threaded server-side to data tools (never the model)."""
    return girder_token


def get_cellvit_url() -> str | None:
    """The configured CellViT service URL (None ⇒ run_segmentation keeps the canned stub)."""
    return get_settings().cellvit_service_url or None
```
Then in `post_turn`, add the params and populate `ctx`:
```python
    agent: AgentLoop = Depends(get_agent),
    artifacts: ArtifactStore = Depends(get_artifacts),
    token: str | None = Depends(get_girder_token),
    cellvit_url: str | None = Depends(get_cellvit_url),
) -> EventSourceResponse:
```
and:
```python
    ctx = ToolContext(
        owner=_uid(user), conversation_id=conversation_id, artifacts=artifacts,
        girder_token=token, cellvit_url=cellvit_url,
    )
```
(`get_settings` is already imported.) Update the `fastapi` import line to include `Header`.

- [ ] **Step 6: Run — expect pass (and the full gateway suite stays green)**

Run: `cd services/agent && uv run pytest -q`
Expected: PASS (all green; +1 new test, existing suite untouched).

- [ ] **Step 7: Commit**

```bash
git add services/agent/src/agent/common/config.py services/agent/src/agent/loop/tools.py services/agent/src/agent/gateway/routes.py services/agent/tests/test_agent_turn_routes.py
git commit  # feat(copilot): thread Girder token + CellViT URL into ToolContext  (on Chen's go-ahead)
```

---

## Task 6: Gateway → CellViT HTTP client (`segmenter.py`)

**Files:**
- Create: `services/agent/src/agent/loop/segmenter.py`
- Create: `services/agent/tests/test_segmenter.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) SegmentResult: count: int; points: list[list[float]]`
  - `async def segment_region(*, base_url: str, slide_ref: str, bbox: dict, token: str | None, timeout: float = 120.0, client: httpx.AsyncClient | None = None) -> SegmentResult` — POSTs `/segment`, maps `{count, centroids}` → `SegmentResult` (points = centroids as `[x, y]`).

- [ ] **Step 1: Write the failing test (httpx MockTransport)**

`services/agent/tests/test_segmenter.py`:
```python
import httpx
import pytest

from agent.loop.segmenter import segment_region


@pytest.mark.asyncio
async def test_segment_region_posts_and_maps_result():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["json"] = __import__("json").loads(request.content)
        return httpx.Response(200, json={
            "count": 2, "centroids": [[100.0, 200.0], [110.0, 220.0]],
            "bbox": {"x": 100, "y": 200, "width": 64, "height": 48},
        })

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport, base_url="http://cellvit") as client:
        res = await segment_region(
            base_url="http://cellvit", slide_ref="item1",
            bbox={"x": 100, "y": 200, "width": 64, "height": 48},
            token="tok", client=client,
        )

    assert res.count == 2
    assert res.points == [[100.0, 200.0], [110.0, 220.0]]
    assert seen["json"]["slide_ref"] == "item1"
    assert seen["json"]["girder_token"] == "tok"
    assert "/segment" in seen["url"]
```

Confirm `services/agent/pyproject.toml` dev deps include `pytest-asyncio` with `asyncio_mode = "auto"` (the existing SDK tests are async — it is already configured; if not, add it).

- [ ] **Step 2: Run — expect fail**

Run: `cd services/agent && uv run pytest tests/test_segmenter.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Implement**

`services/agent/src/agent/loop/segmenter.py`:
```python
"""Gateway → CellViT inference service HTTP client (R11).

The ``run_segmentation`` server tool calls this to segment a region. The dense geometry
returned here is written to the artifact store by the caller and only a handle rides the
event stream (D4). The Girder token is sent server-to-server and is never a model argument
(D3).
"""

from dataclasses import dataclass

import httpx


@dataclass(frozen=True)
class SegmentResult:
    """Segmentation outcome: a nucleus count + level-0 ``[x, y]`` centroids."""

    count: int
    points: list[list[float]]


async def segment_region(
    *,
    base_url: str,
    slide_ref: str,
    bbox: dict,
    token: str | None,
    timeout: float = 120.0,
    client: httpx.AsyncClient | None = None,
) -> SegmentResult:
    """POST the ROI to the CellViT service; return its count + level-0 centroids."""
    payload = {"slide_ref": slide_ref, "bbox": bbox, "girder_token": token}
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=timeout)
    try:
        resp = await client.post("/segment", json=payload)
        resp.raise_for_status()
        data = resp.json()
    finally:
        if owns:
            await client.aclose()
    centroids = [[float(p[0]), float(p[1])] for p in data.get("centroids", [])]
    return SegmentResult(count=int(data.get("count", len(centroids))), points=centroids)
```

- [ ] **Step 4: Run — expect pass**

Run: `cd services/agent && uv run pytest tests/test_segmenter.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/agent/loop/segmenter.py services/agent/tests/test_segmenter.py
git commit  # feat(copilot): CellViT service HTTP client  (on Chen's go-ahead)
```

---

## Task 7: Wire `run_segmentation` to the service + add the `bbox` arg

**Files:**
- Modify: `services/agent/src/agent/loop/tools.py` (`run_server_tool`)
- Modify: `services/agent/src/agent/loop/sdk_tools.py` (schema)
- Modify: `services/agent/tests/test_loop_tools.py`

**Interfaces:**
- Consumes: `segment_region(...) -> SegmentResult`, `ToolContext.cellvit_url` / `.girder_token`, `ArtifactStore.put(...)`.
- Produces: `run_server_tool` real path — when `ctx.cellvit_url` is set it calls the service for `region = args["bbox"] or scope["roi"]` (no region ⇒ `ok=False`, whole-slide deferred to R12); else the canned stub (now also honoring `args["bbox"]`). `run_segmentation` schema accepts optional `bbox` (level-0 px).

- [ ] **Step 1: Write the failing tests**

Append to `services/agent/tests/test_loop_tools.py`:
```python
import pytest

from agent.loop.artifacts import InMemoryArtifactStore
from agent.loop.tools import ToolContext, get_tool, run_server_tool


class _FakeSeg:
    def __init__(self):
        self.calls = []

    async def __call__(self, *, base_url, slide_ref, bbox, token, timeout=120.0, client=None):
        from agent.loop.segmenter import SegmentResult
        self.calls.append({"base_url": base_url, "slide_ref": slide_ref, "bbox": bbox,
                           "token": token})
        return SegmentResult(count=3, points=[[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]])


@pytest.mark.asyncio
async def test_run_segmentation_uses_service_when_configured(monkeypatch):
    fake = _FakeSeg()
    monkeypatch.setattr("agent.loop.tools.segment_region", fake)
    ctx = ToolContext(owner="u1", conversation_id=1, artifacts=InMemoryArtifactStore(),
                      girder_token="tok", cellvit_url="http://cellvit")
    scope = {"item_id": "item1", "roi": {"x": 10, "y": 20, "width": 30, "height": 40}}
    out = await run_server_tool(get_tool("run_segmentation"), {}, scope, ctx)
    assert out.ok and out.artifact.count == 3
    assert "3 nuclei" in out.summary
    assert fake.calls[0]["slide_ref"] == "item1"
    assert fake.calls[0]["bbox"]["width"] == 30  # fell back to scope.roi


@pytest.mark.asyncio
async def test_run_segmentation_prefers_bbox_arg(monkeypatch):
    fake = _FakeSeg()
    monkeypatch.setattr("agent.loop.tools.segment_region", fake)
    ctx = ToolContext(owner="u1", conversation_id=1, artifacts=InMemoryArtifactStore(),
                      girder_token="tok", cellvit_url="http://cellvit")
    scope = {"item_id": "item1", "roi": {"x": 10, "y": 20, "width": 30, "height": 40}}
    arg_bbox = {"x": 500, "y": 600, "width": 128, "height": 128}
    await run_server_tool(get_tool("run_segmentation"), {"bbox": arg_bbox}, scope, ctx)
    assert fake.calls[0]["bbox"] == arg_bbox  # explicit arg wins over scope.roi


@pytest.mark.asyncio
async def test_run_segmentation_service_no_region_is_error():
    ctx = ToolContext(owner="u1", conversation_id=1, artifacts=InMemoryArtifactStore(),
                      cellvit_url="http://cellvit")
    out = await run_server_tool(get_tool("run_segmentation"), {}, {"item_id": "item1"}, ctx)
    assert out.ok is False and "region" in out.summary.lower()
```

- [ ] **Step 2: Run — expect fail**

Run: `cd services/agent && uv run pytest tests/test_loop_tools.py -k run_segmentation -v`
Expected: FAIL (`segment_region` not imported in tools; region-arg logic absent).

- [ ] **Step 3: Implement the real path in `run_server_tool`**

In `services/agent/src/agent/loop/tools.py`, add the import near the top:
```python
from .segmenter import segment_region
```
Replace the body of `run_server_tool` (the `if tool.name == "run_segmentation":` block) with:
```python
    if tool.name == "run_segmentation":
        # region: explicit model-chosen bbox wins, else the drawn ROI (D8, gap ④).
        region = args.get("bbox") or (scope or {}).get("roi")

        # Real path: a CellViT service is configured for this turn.
        if ctx is not None and ctx.cellvit_url:
            if region is None:
                return ToolOutcome(
                    ok=False,
                    summary="Whole-slide segmentation isn't available yet — draw a region "
                            "on the slide (or pan to one) and ask again.",
                )
            try:
                res = await segment_region(
                    base_url=ctx.cellvit_url, slide_ref=(scope or {}).get("item_id"),
                    bbox=region, token=ctx.girder_token,
                )
            except Exception as exc:  # noqa: BLE001 — surface the failure as a tool result
                return ToolOutcome(ok=False, summary=f"segmentation failed ({type(exc).__name__})")
            if ctx.artifacts is None:
                return ToolOutcome(ok=True, summary=f"segmented {res.count:,} nuclei in the region")
            geometry = {"kind": "nuclei", "count": res.count, "points": res.points}
            handle = await ctx.artifacts.put(
                owner=ctx.owner, conversation_id=ctx.conversation_id, kind="nuclei",
                bbox=region, geometry=geometry, summary=f"{res.count:,} nuclei",
            )
            return ToolOutcome(
                ok=True, summary=f"segmented {res.count:,} nuclei in the region", artifact=handle
            )

        # Canned stub (no service configured / unit context) — honors the bbox arg too.
        where = "in the region" if region else "across the slide"
        if ctx is None or ctx.artifacts is None:
            return ToolOutcome(ok=True, summary=f"segmented {_STUB_NUCLEI:,} nuclei {where}")
        geometry = _stub_nuclei_geometry(region)
        handle = await ctx.artifacts.put(
            owner=ctx.owner, conversation_id=ctx.conversation_id, kind="nuclei",
            bbox=region, geometry=geometry, summary=f"{geometry['count']:,} nuclei",
        )
        return ToolOutcome(
            ok=True, summary=f"segmented {handle.count:,} nuclei {where}", artifact=handle
        )
    return ToolOutcome(ok=False, summary=f"no server executor for {tool.name}")
```

- [ ] **Step 4: Add the `bbox` arg to the schema**

In `services/agent/src/agent/loop/sdk_tools.py`, change the `run_segmentation` schema:
```python
    "run_segmentation": {
        "type": "object",
        "properties": {
            "bbox": {
                **_BBOX_SCHEMA,
                "description": "Optional region to segment, in level-0 pixels. Omit to use "
                               "the region already drawn on the slide.",
            },
        },
        "additionalProperties": False,
    },
```

- [ ] **Step 5: Run — expect pass (full suite green)**

Run: `cd services/agent && uv run pytest -q`
Expected: PASS (all green; +3 new run_segmentation tests, loop/turn/artifact suite untouched).

- [ ] **Step 6: Commit**

```bash
git add services/agent/src/agent/loop/tools.py services/agent/src/agent/loop/sdk_tools.py services/agent/tests/test_loop_tools.py
git commit  # feat(copilot): run_segmentation calls the CellViT service  (on Chen's go-ahead)
```

---

## Verification (end of plan)

- [ ] `cd services/cellvit && uv run pytest -q` — all green (geometry, region, segment route).
- [ ] `cd services/agent && uv run pytest -q` — all green (segmenter, run_segmentation service+stub paths, token threading, plus the untouched loop/turn/artifact suite).
- [ ] **Manual, no GPU:** run the CellViT service (`cd services/cellvit && uv run uvicorn cellvit_service.app:create_app --factory --port 8020`), set `AGENT_CELLVIT_SERVICE_URL=http://localhost:8020` for the gateway, and drive one copilot turn with a drawn ROI on a real slide → confirm the tool card shows a real (stub-grid) count and the overlay paints the grid at the right place. This proves the whole pipeline end-to-end; only the model is a stub.

## Deferred to the GPU follow-up plan (needs the ≥24GB box)

- **R11.0 spike:** direct-array `cellvit` inference on a region ndarray vs mini-pyramidal-TIFF `process_wsi`; confirm SAM-H latency. Fixes `infer.segment_array`'s real body.
- Real `infer.py` (lazy `cellvit` import), GPU `Dockerfile` (CUDA 12.1 + `pip install cellvit`, weight cache volume), `docker-compose` service with `--gpus`, `/health` GPU check.
- Real-slide visual smoke; max-ROI-area guard (large ROI → the R11 async path, deferred to R12).
