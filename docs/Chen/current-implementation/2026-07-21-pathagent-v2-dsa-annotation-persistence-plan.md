# DSA Annotation Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every copilot `run_segmentation` result as a durable DSA annotation on the slide item, so nuclei survive reload, appear in the existing Annotations panel, and render natively.

**Architecture:** Swap `InMemoryArtifactStore` for a new `GirderAnnotationStore` behind the existing `ArtifactStore` seam (D4). The store writes/reads a real DSA annotation (`point` elements) server-to-server with the caller's Girder token (D3). The agent loop, the `ArtifactHandle` shape, the SSE event contract, and the frontend `fetchTurnArtifact` path are all untouched — only where the bytes live changes. Real persistence is gated on `cellvit_service_url` (the same flag that turns on real segmentation), so all stub-mode tests keep using `InMemoryArtifactStore`.

**Tech Stack:** Python 3 · FastAPI · httpx (async, `MockTransport` in tests) · pytest (`asyncio_mode = "auto"`) · Girder 5 / DSA `/annotation` REST API.

## Global Constraints

- Communicate with Chen in **Chinese**; keep **all code, comments, docs, and commit messages in English**.
- **Do NOT push.** Local commits of validated milestones are fine; nothing is pushed this session.
- **Never** commit `.env`/secrets or the unrelated dashboard WIP (`package*.json`, `src/components/dashboard/*`, `RightPanel/LeftSidebar/ViewerPanel.jsx`, `index.css`, `vite.config.js`, `docs/superpowers/`, `.superpowers/`).
- **Conventional Commits**: `type(scope): subject`, subject ≤ 50 chars, no trailing period.
- End every commit message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Strict TDD**: write the failing test first, watch it fail, then minimal code.
- **DSA point element schema** (must match the repo's `makePoint`, `src/components/annotations/annotationUtils.js:57`): `{"type": "point", "center": [x, y, 0]}`.
- The Girder token rides **server-side only** (D3) — never a model/tool argument; it comes from `ToolContext.girder_token` and the `Girder-Token` request header.
- Run tests and ruff from `services/agent/`: `uv run pytest ...`, `uv run ruff check .`.

---

## File Structure

- `services/agent/src/agent/loop/girder_annotations.py` **(create)** — `GirderAnnotationStore(ArtifactStore)`: `put` writes a DSA `point` annotation and returns a handle whose `ref` is the annotation id; `get` reads it back to `{kind, count, points}`.
- `services/agent/src/agent/loop/artifacts.py` **(modify)** — widen the `ArtifactStore` ABC and `InMemoryArtifactStore` to carry optional `item_id`/`token` (ignored by the in-memory store) so the seam is uniform.
- `services/agent/src/agent/loop/tools.py` **(modify)** — `run_server_tool` passes `item_id`/`token` into `put`.
- `services/agent/src/agent/gateway/routes.py` **(modify)** — `get_turn_artifact` threads the caller's `Girder-Token` into `get`.
- `services/agent/src/agent/gateway/app.py` **(modify)** — `create_app` selects `GirderAnnotationStore` when `cellvit_service_url` is set, else `InMemoryArtifactStore`.
- `services/agent/src/agent/common/config.py` **(modify)** — replace the misleading dev-host default for `girder_base` with a neutral local default.
- Tests: `tests/test_girder_annotations.py` **(create)**, and additions to `tests/test_loop_artifacts.py`, `tests/test_loop_tools.py`, `tests/test_agent_turn_routes.py`, `tests/test_app.py` **(create if absent)**, `tests/test_config.py` **(create)**.

---

### Task 1: Uniform seam — `item_id`/`token` on the ArtifactStore contract

**Files:**
- Modify: `services/agent/src/agent/loop/artifacts.py`
- Test: `services/agent/tests/test_loop_artifacts.py`

**Interfaces:**
- Produces: `ArtifactStore.put(*, owner, conversation_id, kind, bbox, geometry, summary, item_id: str | None = None, token: str | None = None) -> ArtifactHandle` and `ArtifactStore.get(*, owner, ref, token: str | None = None) -> dict | None`. `InMemoryArtifactStore` accepts and ignores `item_id`/`token`.

- [ ] **Step 1: Write the failing test**

Add to `services/agent/tests/test_loop_artifacts.py`:

```python
async def test_put_and_get_accept_item_id_and_token_kwargs():
    # The seam is uniform: callers always pass item_id/token; the in-memory store ignores them.
    store = InMemoryArtifactStore()
    handle = await store.put(
        owner="u1", conversation_id=1, kind="nuclei", bbox=None,
        geometry={"kind": "nuclei", "points": [[1, 2]]}, summary="1 nucleus",
        item_id="item9", token="tok",
    )
    got = await store.get(owner="u1", ref=handle.ref, token="tok")
    assert got["points"] == [[1, 2]]
    assert await store.get(owner="intruder", ref=handle.ref, token="tok") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_loop_artifacts.py::test_put_and_get_accept_item_id_and_token_kwargs -v`
Expected: FAIL with `TypeError: put() got an unexpected keyword argument 'item_id'`.

- [ ] **Step 3: Write minimal implementation**

In `services/agent/src/agent/loop/artifacts.py`, widen the ABC signatures:

```python
    @abstractmethod
    async def put(
        self,
        *,
        owner: str,
        conversation_id: int,
        kind: str,
        bbox: dict | None,
        geometry: dict,
        summary: str,
        item_id: str | None = None,
        token: str | None = None,
    ) -> ArtifactHandle:
        """Store `geometry`, return a handle carrying only its metadata.

        `item_id`/`token` are the Girder item and caller token a durable store needs; the
        in-memory store ignores them (D3 — the token never enters the model).
        """

    @abstractmethod
    async def get(self, *, owner: str, ref: str, token: str | None = None) -> dict | None:
        """Return the stored geometry for the owner, or None if absent / not theirs."""
```

And update `InMemoryArtifactStore` to accept-and-ignore the new kwargs:

```python
    async def put(self, *, owner, conversation_id, kind, bbox, geometry, summary,
                  item_id=None, token=None):
        ref = uuid.uuid4().hex
        points = geometry.get("points", [])
        count = geometry.get("count", len(points))
        size = len(json.dumps(geometry, separators=(",", ":")))
        self._items[ref] = {"owner": owner, "conversation_id": conversation_id,
                            "geometry": geometry}
        return ArtifactHandle(
            kind=kind, ref=ref, count=count, summary=summary, bbox=bbox, size=size
        )

    async def get(self, *, owner, ref, token=None):
        rec = self._items.get(ref)
        if rec is None or rec["owner"] != owner:
            return None
        return rec["geometry"]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_loop_artifacts.py -v`
Expected: PASS (all four tests, including the three pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/agent/loop/artifacts.py services/agent/tests/test_loop_artifacts.py
git commit -m "refactor(agent): widen artifact seam with item_id/token"
```

---

### Task 2: `GirderAnnotationStore` — write/read nuclei as a DSA annotation

**Files:**
- Create: `services/agent/src/agent/loop/girder_annotations.py`
- Test: `services/agent/tests/test_girder_annotations.py`

**Interfaces:**
- Consumes: `ArtifactStore`, `ArtifactHandle` from `agent.loop.artifacts`; the widened `put`/`get` signatures from Task 1.
- Produces: `GirderAnnotationStore(girder_base: str, client: httpx.AsyncClient | None = None)`. `put(...)` POSTs `POST {girder_base}/annotation?itemId={item_id}` with `{name, description, elements:[{type:"point", center:[x,y,0]}, ...]}` and returns `ArtifactHandle(kind, ref=<annotation _id>, count, summary, bbox)`. `get(...)` GETs `GET {girder_base}/annotation/{ref}` and maps `point` elements back to `{"kind": "nuclei", "count": n, "points": [[x, y], ...]}`.

- [ ] **Step 1: Write the failing test**

Create `services/agent/tests/test_girder_annotations.py`:

```python
import json

import httpx
import pytest

from agent.loop.girder_annotations import GirderAnnotationStore


def _store(handler):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://g/api/v1")
    return GirderAnnotationStore("http://g/api/v1", client=client)


@pytest.mark.asyncio
async def test_put_posts_point_annotation_scoped_to_item_with_token():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["itemId"] = request.url.params.get("itemId")
        seen["token"] = request.headers.get("Girder-Token")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"_id": "ann123"})

    handle = await _store(handler).put(
        owner="u1", conversation_id=1, kind="nuclei",
        bbox={"x": 10, "y": 20, "width": 5, "height": 5},
        geometry={"kind": "nuclei", "count": 2, "points": [[10, 20], [11, 21]]},
        summary="2 nuclei", item_id="item9", token="tok",
    )

    assert handle.ref == "ann123"
    assert handle.kind == "nuclei" and handle.count == 2 and handle.summary == "2 nuclei"
    assert seen["method"] == "POST" and seen["path"] == "/api/v1/annotation"
    assert seen["itemId"] == "item9" and seen["token"] == "tok"  # D3: token server-side only
    assert seen["body"]["elements"][0] == {"type": "point", "center": [10.0, 20.0, 0]}
    assert len(seen["body"]["elements"]) == 2


@pytest.mark.asyncio
async def test_get_maps_point_elements_back_to_points():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/annotation/ann123"
        assert request.headers.get("Girder-Token") == "tok"
        return httpx.Response(200, json={
            "_id": "ann123",
            "annotation": {"name": "Copilot nuclei · 2", "elements": [
                {"type": "point", "center": [10.0, 20.0, 0]},
                {"type": "point", "center": [11.0, 21.0, 0]},
            ]},
        })

    got = await _store(handler).get(owner="u1", ref="ann123", token="tok")
    assert got == {"kind": "nuclei", "count": 2, "points": [[10.0, 20.0], [11.0, 21.0]]}


@pytest.mark.asyncio
async def test_get_returns_none_when_annotation_is_inaccessible():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"message": "Access denied"})

    assert await _store(handler).get(owner="u1", ref="nope", token="tok") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_girder_annotations.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'agent.loop.girder_annotations'`.

- [ ] **Step 3: Write minimal implementation**

Create `services/agent/src/agent/loop/girder_annotations.py`:

```python
"""Durable artifact store backed by Girder DSA annotations (R11 — D4).

Swaps in behind the ArtifactStore seam so a `run_segmentation`'s nuclei persist as a real
DSA annotation on the slide item: they survive reload, appear in the Annotations panel, and
render natively (`point` elements). The agent loop and the `ArtifactHandle` shape are
untouched — only where the bytes live changes.

Reads/writes go server-to-server with the caller's Girder token (D3, never a model arg),
against the same Girder the viewer is signed into (`settings.girder_base`).
"""

import httpx

from .artifacts import ArtifactHandle, ArtifactStore


class GirderAnnotationStore(ArtifactStore):
    """Persists bulk nuclei geometry as a DSA annotation; reads it back by annotation id."""

    def __init__(self, girder_base: str, client: httpx.AsyncClient | None = None) -> None:
        self._base = girder_base.rstrip("/")
        self._client = client

    def _acquire(self) -> tuple[httpx.AsyncClient, bool]:
        """Reuse an injected client (tests), else build a per-call one we must close."""
        if self._client is not None:
            return self._client, False
        return httpx.AsyncClient(base_url=self._base, timeout=30.0), True

    async def put(self, *, owner, conversation_id, kind, bbox, geometry, summary,
                  item_id=None, token=None) -> ArtifactHandle:
        points = geometry.get("points", [])
        count = geometry.get("count", len(points))
        elements = [
            {"type": "point", "center": [float(p[0]), float(p[1]), 0]} for p in points
        ]
        doc = {
            "name": f"Copilot nuclei · {count}",
            "description": _describe(count, bbox),
            "elements": elements,
        }
        client, owns = self._acquire()
        try:
            resp = await client.post(
                "/annotation", params={"itemId": item_id}, json=doc, headers=_auth(token),
            )
            resp.raise_for_status()
            ann_id = str(resp.json()["_id"])
        finally:
            if owns:
                await client.aclose()
        return ArtifactHandle(kind=kind, ref=ann_id, count=count, summary=summary, bbox=bbox)

    async def get(self, *, owner, ref, token=None) -> dict | None:
        client, owns = self._acquire()
        try:
            resp = await client.get(f"/annotation/{ref}", headers=_auth(token))
            if resp.status_code in (401, 403, 404):
                return None  # not accessible to this token / gone
            resp.raise_for_status()
            data = resp.json()
        finally:
            if owns:
                await client.aclose()
        elements = (data.get("annotation") or {}).get("elements") or []
        points = [
            [float(el["center"][0]), float(el["center"][1])]
            for el in elements
            if el.get("type") == "point" and el.get("center")
        ]
        return {"kind": "nuclei", "count": len(points), "points": points}


def _auth(token: str | None) -> dict:
    return {"Girder-Token": token} if token else {}


def _describe(count: int, bbox: dict | None) -> str:
    if not bbox:
        return f"CellViT-SAM-H segmentation. {count} nuclei."
    x, y = int(bbox.get("x", 0)), int(bbox.get("y", 0))
    w, h = int(bbox.get("width", 0)), int(bbox.get("height", 0))
    return f"CellViT-SAM-H segmentation of a {w}x{h}px region at ({x}, {y}). {count} nuclei."


__all__ = ["GirderAnnotationStore"]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_girder_annotations.py -v`
Expected: PASS (three tests).

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/agent/loop/girder_annotations.py services/agent/tests/test_girder_annotations.py
git commit -m "feat(agent): add GirderAnnotationStore for durable nuclei"
```

---

### Task 3: `run_server_tool` passes `item_id`/`token` into `put`

**Files:**
- Modify: `services/agent/src/agent/loop/tools.py:155-159` (real path) and `:166-170` (stub path)
- Test: `services/agent/tests/test_loop_tools.py`

**Interfaces:**
- Consumes: the widened `put` (Task 1); `ToolContext.girder_token`; `scope["item_id"]`.
- Produces: both `put(...)` calls in `run_server_tool` include `item_id=(scope or {}).get("item_id")` and `token=ctx.girder_token`.

- [ ] **Step 1: Write the failing test**

Add to `services/agent/tests/test_loop_tools.py` (a spy store that records the `put` kwargs):

```python
class _SpyStore:
    def __init__(self):
        self.put_kwargs = None

    async def put(self, **kwargs):
        from agent.loop.artifacts import ArtifactHandle
        self.put_kwargs = kwargs
        return ArtifactHandle(kind="nuclei", ref="r1", count=kwargs["geometry"]["count"],
                              summary=kwargs["summary"], bbox=kwargs["bbox"])

    async def get(self, **kwargs):
        return None


async def test_run_segmentation_threads_item_id_and_token_into_put(monkeypatch):
    import agent.loop.tools as tools

    async def _fake_seg(*, base_url, slide_ref, bbox, token):
        return tools.SegmentResult(count=2, points=[[1.0, 2.0], [3.0, 4.0]], mpp=0.5)

    monkeypatch.setattr(tools, "segment_region", _fake_seg)
    spy = _SpyStore()
    ctx = tools.ToolContext(owner="u1", conversation_id=1, artifacts=spy,
                            girder_token="tok", cellvit_url="http://cellvit")
    scope = {"item_id": "item9", "roi": {"x": 0, "y": 0, "width": 10, "height": 10}}

    out = await tools.run_server_tool(tools.get_tool("run_segmentation"), {}, scope, ctx)

    assert out.ok
    assert spy.put_kwargs["item_id"] == "item9"
    assert spy.put_kwargs["token"] == "tok"
```

(If `SegmentResult` is not already re-exported from `agent.loop.tools`, import it in the test from `agent.loop.segmenter` instead.)

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_loop_tools.py::test_run_segmentation_threads_item_id_and_token_into_put -v`
Expected: FAIL with `KeyError: 'item_id'` (the current `put` call omits it).

- [ ] **Step 3: Write minimal implementation**

In `services/agent/src/agent/loop/tools.py`, update the **real path** `put` call (currently around line 156):

```python
            geometry = {"kind": "nuclei", "count": res.count, "points": res.points}
            handle = await ctx.artifacts.put(
                owner=ctx.owner, conversation_id=ctx.conversation_id, kind="nuclei",
                bbox=region, geometry=geometry, summary=f"{res.count:,} nuclei",
                item_id=slide_ref, token=ctx.girder_token,
            )
```

And the **stub path** `put` call (currently around line 167):

```python
        geometry = _stub_nuclei_geometry(region)
        handle = await ctx.artifacts.put(
            owner=ctx.owner, conversation_id=ctx.conversation_id, kind="nuclei",
            bbox=region, geometry=geometry, summary=f"{geometry['count']:,} nuclei",
            item_id=(scope or {}).get("item_id"), token=ctx.girder_token,
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_loop_tools.py -v`
Expected: PASS (new test plus all pre-existing loop-tools tests).

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/agent/loop/tools.py services/agent/tests/test_loop_tools.py
git commit -m "feat(agent): thread item_id and token into artifact put"
```

---

### Task 4: `get_turn_artifact` threads the caller token into `get`

**Files:**
- Modify: `services/agent/src/agent/gateway/routes.py:236-256`
- Test: `services/agent/tests/test_agent_turn_routes.py`

**Interfaces:**
- Consumes: `get_girder_token` dependency (already defined in `routes.py:43`); the widened `get(..., token=...)` (Task 1).
- Produces: `get_turn_artifact` calls `artifacts.get(owner=_uid(user), ref=ref, token=token)` where `token` is the request's `Girder-Token` header.

- [ ] **Step 1: Write the failing test**

Add to `services/agent/tests/test_agent_turn_routes.py` (override the artifact store with a spy that records the token):

```python
def test_get_turn_artifact_passes_caller_token_to_store(store):
    from agent.gateway.app import create_app
    from agent.gateway.auth import require_user
    from agent.gateway.routes import get_agent, get_store, get_artifacts
    from agent.loop import StubAgentLoop

    class _TokenSpyStore:
        def __init__(self):
            self.seen_token = "UNSET"

        async def put(self, **kwargs):
            from agent.loop.artifacts import ArtifactHandle
            return ArtifactHandle(kind="nuclei", ref="r1", count=0, summary="0", bbox=None)

        async def get(self, *, owner, ref, token=None):
            self.seen_token = token
            return {"kind": "nuclei", "count": 0, "points": []}

    spy = _TokenSpyStore()
    app = create_app()
    app.dependency_overrides[require_user] = lambda: {"_id": "u1", "login": "tester"}
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_agent] = lambda: StubAgentLoop()
    app.dependency_overrides[get_artifacts] = lambda: spy
    from starlette.testclient import TestClient
    c = TestClient(app)
    cid = c.post("/api/copilot/conversations", json={"item_id": "s1"}).json()["id"]

    r = c.get(f"/api/copilot/conversations/{cid}/artifacts/anyref",
              headers={"Girder-Token": "tok-42"})
    assert r.status_code == 200
    assert spy.seen_token == "tok-42"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_agent_turn_routes.py::test_get_turn_artifact_passes_caller_token_to_store -v`
Expected: FAIL — `spy.seen_token` is `"UNSET"` because the current route calls `get(owner=..., ref=ref)` without `token` (its default `None` never reaches the spy's recording... it does record `None`, so the assertion `== "tok-42"` fails).

- [ ] **Step 3: Write minimal implementation**

In `services/agent/src/agent/gateway/routes.py`, add the token dependency and pass it through:

```python
@router.get("/conversations/{conversation_id}/artifacts/{ref}")
async def get_turn_artifact(
    conversation_id: int,
    ref: str,
    user: dict = Depends(require_user),
    store: ConversationStore = Depends(get_store),
    artifacts: ArtifactStore = Depends(get_artifacts),
    token: str | None = Depends(get_girder_token),
) -> dict:
    """Fetch a turn artifact's bulk geometry out-of-band by its handle `ref` (D4).

    Owner-scoped: the conversation must be the caller's. The caller's Girder token is
    threaded to the store so the durable (DSA-annotation) backend can authorize the read
    against Girder; the in-memory backend ignores it and scopes by owner.
    """
    conv = await store.get_conversation(user=_uid(user), conversation_id=conversation_id)
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    geometry = await artifacts.get(owner=_uid(user), ref=ref, token=token)
    if geometry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Artifact not found")
    return geometry
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_agent_turn_routes.py -v`
Expected: PASS (new test plus all pre-existing turn-routes tests, including the owner-scoping ones).

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/agent/gateway/routes.py services/agent/tests/test_agent_turn_routes.py
git commit -m "feat(agent): pass caller token to artifact get"
```

---

### Task 5: `create_app` selects the durable store when segmentation is real

**Files:**
- Modify: `services/agent/src/agent/gateway/app.py:8,45`
- Test: `services/agent/tests/test_app.py` (create if absent)

**Interfaces:**
- Consumes: `GirderAnnotationStore` (Task 2); `get_settings().cellvit_service_url`, `get_settings().girder_base`.
- Produces: `app.state.artifacts` is a `GirderAnnotationStore` when `cellvit_service_url` is set, else an `InMemoryArtifactStore`.

- [ ] **Step 1: Write the failing test**

Create (or add to) `services/agent/tests/test_app.py`:

```python
from agent.gateway.app import create_app
from agent.common.config import get_settings
from agent.loop.artifacts import InMemoryArtifactStore
from agent.loop.girder_annotations import GirderAnnotationStore


def test_uses_in_memory_store_without_cellvit(monkeypatch):
    monkeypatch.setenv("AGENT_CELLVIT_SERVICE_URL", "")
    get_settings.cache_clear()
    try:
        app = create_app()
        assert isinstance(app.state.artifacts, InMemoryArtifactStore)
    finally:
        get_settings.cache_clear()


def test_uses_girder_annotation_store_when_cellvit_configured(monkeypatch):
    monkeypatch.setenv("AGENT_CELLVIT_SERVICE_URL", "http://cellvit:8020")
    get_settings.cache_clear()
    try:
        app = create_app()
        assert isinstance(app.state.artifacts, GirderAnnotationStore)
    finally:
        get_settings.cache_clear()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_app.py -v`
Expected: FAIL on `test_uses_girder_annotation_store_when_cellvit_configured` — the current `create_app` always builds `InMemoryArtifactStore`.

- [ ] **Step 3: Write minimal implementation**

In `services/agent/src/agent/gateway/app.py`, update the import and the store wiring:

```python
from ..loop.artifacts import InMemoryArtifactStore
from ..loop.girder_annotations import GirderAnnotationStore
```

```python
    app.state.agent = build_agent(settings)          # SDK loop when keyed, else stub
    # Durable DSA-annotation store when real segmentation is on (nuclei survive reload and
    # show in the Annotations panel); the in-memory stub otherwise (dev/tests, keyless).
    app.state.artifacts = (
        GirderAnnotationStore(settings.girder_base)
        if settings.cellvit_service_url
        else InMemoryArtifactStore()
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_app.py -v`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/agent/gateway/app.py services/agent/tests/test_app.py
git commit -m "feat(agent): use durable store when cellvit configured"
```

---

### Task 6: Neutral default for `girder_base`

**Files:**
- Modify: `services/agent/src/agent/common/config.py:16`
- Test: `services/agent/tests/test_config.py` (create)

**Interfaces:**
- Produces: `Settings.model_fields["girder_base"].default == "http://localhost:9080/api/v1"` — a neutral local default that no longer names a specific remote dev host. `AGENT_GIRDER_BASE` still overrides it (compose injects `http://host.docker.internal:9080/api/v1`).

- [ ] **Step 1: Write the failing test**

Create `services/agent/tests/test_config.py`:

```python
from agent.common.config import Settings


def test_girder_base_default_is_neutral_local_not_a_remote_dev_host():
    # The compile-time default must not name a specific remote dev host (it misleads readers
    # into thinking the copilot talks to it); compose injects AGENT_GIRDER_BASE at runtime.
    default = Settings.model_fields["girder_base"].default
    assert default == "http://localhost:9080/api/v1"
    assert "lymphoma" not in default
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_config.py -v`
Expected: FAIL — the default is still `https://lymphoma.dev.pathassist.health/api/v1`.

- [ ] **Step 3: Write minimal implementation**

In `services/agent/src/agent/common/config.py`, replace the default:

```python
    # The copilot authorizes every request against the same Girder the viewer uses. This
    # compile-time default is only a neutral local fallback — deployment sets AGENT_GIRDER_BASE
    # (compose injects http://host.docker.internal:9080/api/v1).
    girder_base: str = "http://localhost:9080/api/v1"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_config.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/agent/common/config.py services/agent/tests/test_config.py
git commit -m "chore(agent): neutral default for girder_base"
```

---

## Final Verification (after all tasks)

- [ ] Run the full agent suite from `services/agent/`: `uv run pytest -q` — expect all green (pre-existing + new).
- [ ] `uv run ruff check .` — expect clean.
- [ ] **Manual/browser E2E** (in Chen's deployment, `cellvit` configured): draw a Region, ask "count the nuclei here"; confirm (1) the live cyan overlay still paints, (2) a new annotation `Copilot nuclei · <count>` appears in the **Annotations panel**, (3) reload the page → the annotation is still listed and renders when toggled on.
- [ ] Recreate the copilot container so the new store wiring loads: `docker compose up -d copilot` (the `./src` mount hot-reloads code, but confirm `app.state.artifacts` is `GirderAnnotationStore` — a fresh process picks it up).

---

## Self-Review

- **Spec coverage:** durable persistence (Tasks 2, 5), appears in Annotations panel + native render (point-element schema, verified against `annotationUtils.js`), token server-side (Tasks 3, 4), config cleanup (Task 6), reload survival (durable annotation, no per-turn store schema change per decision B1). Covered.
- **Placeholder scan:** every step carries complete code and an exact command with expected output. None found.
- **Type consistency:** `put`/`get` signatures match across the ABC, `InMemoryArtifactStore`, `GirderAnnotationStore`, and all call sites (`run_server_tool`, `get_turn_artifact`). `ref` is the annotation id end-to-end; `get` returns `{kind, count, points}` matching what `fetchTurnArtifact` → `setCopilotNuclei` → `NucleiOverlay` already consume.
