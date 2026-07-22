# Cell Classification + Typed Counts — Implementation Plan (Increment 1)

> **For agentic workers:** Implement task-by-task with **strict TDD** (write the failing test → watch
> it fail → minimal code → green → commit). Steps use checkbox (`- [ ]`) syntax for tracking. There is
> **no** superpowers sub-skill — follow this plan directly.

**Spec:** `docs/Chen/plans/2026-07-22-pathagent-v2-cell-classification-typed-counts-design.md` (amended
per its review). **Goal:** surface CellViT's per-nucleus PanNuke class so a segmentation returns
**typed counts** (per-class breakdown) instead of a bare total, persists the class on the DSA
annotation, and paints the overlay by class — every typed number originating in a deterministic tool
result, never the model.

**Architecture:** thread the class through the existing
`infer → /segment → segmenter → tools → girder_annotations → overlay` chain. The **int** id lives only
inside the CellViT service; the `segmenter` translates it to a PanNuke **name**, and every consumer
past that point (geometry, both artifact stores, overlay) sees a name — so there is one representation
to key colour on (F1). `type_prob` is not threaded this increment (F3). DSA elements carry `group` +
per-element `lineColor`, matching the repo's `makePoint` convention (F4).

**Tech Stack:** Python 3 · Flask (cellvit service) · FastAPI + httpx (`MockTransport` in tests) ·
pytest (`asyncio_mode = "auto"`) · React 18 + OpenSeadragon (overlay). Girder 5 / DSA `/annotation`.

## Global Constraints

- Communicate with Chen in **Chinese**; keep **all code, comments, docs, and commit messages in English**.
- **Do NOT push.** Local commits of validated tasks are fine; nothing is pushed this session.
- **Never** commit `.env`/secrets or the unrelated dashboard WIP (`package*.json`,
  `src/components/dashboard/*`, `RightPanel/LeftSidebar/ViewerPanel.jsx`, `index.css`, `vite.config.js`,
  `src/test/`). Commit only the files each task names.
- **Conventional Commits**: `type(scope): subject`, subject ≤ 50 chars, no trailing period.
- End every commit message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Strict TDD**: write the failing test first, watch it fail, then minimal code.
- **Vendored taxonomy (critical):** the PanNuke id→name/colour tables live in `cellvit.config.config`,
  but that package ships **only in the GPU Dockerfile** (imported lazily) — the base/CI env has no
  `cellvit`. So each service vendors its own small constant (Tasks 1, 5) and the frontend its own JS map
  (Task 8). Keep the three copies in sync with the verified values below.
- **PanNuke ground truth** (verified against `cellvit/config/config.py`): `1 Neoplastic rgb(255,0,0)` ·
  `2 Inflammatory rgb(34,221,77)` · `3 Connective rgb(35,92,236)` · `4 Dead rgb(254,255,0)` ·
  `5 Epithelial rgb(255,159,68)`. `0 = Background`, never present in `cells`.
- Run Python tests/ruff from each service dir: `cd services/cellvit` or `cd services/agent`, then
  `uv run pytest ...` / `uv run ruff check .`.

---

## File Structure

**CellViT service** (`services/cellvit/src/cellvit_service/`)
- `pannuke.py` **(create)** — vendored `TYPE_NAMES: dict[int,str]` + `name_for(id)`. GPU-free.
- `infer.py` **(modify)** — `segment_array` returns `(points, classes:list[int])`; stub assigns a
  deterministic class; real path reads `type`; `_clip_to_region` clips both arrays in lockstep.
- `app.py` **(modify)** — `/segment` offsets xy, computes `counts_by_type` (by name) + `class_names`,
  adds `classes`/`counts_by_type`/`class_names` to the response, and asserts the alignment invariant.

**Agent** (`services/agent/src/agent/loop/`)
- `segmenter.py` **(modify)** — `SegmentResult` gains `classes:list[str]` (names) + `counts_by_type`;
  the single int→name translation point (via the wire's `class_names`).
- `pannuke.py` **(create)** — vendored `PANNUKE_NAMES:list[str]` (loop stub) + `CLASS_HEX:dict[str,str]`
  (DSA element `lineColor`). GPU-free.
- `tools.py` **(modify)** — typed summary + name-`classes` geometry; loop stub emits names.
- `girder_annotations.py` **(modify)** — `put` tags each element `group` + `lineColor`; `get` reads
  `group` back into an aligned name `classes` list.

**Frontend** (`src/components/viewer/`)
- `pannukeColors.js` **(create)** — `CLASS_COLOR` (name→rgba) + `colorForClass` + `presentClasses`.
- `NucleiOverlay.jsx` **(modify)** — colour each dot by class (cyan fallback) + a legend of present
  classes.

**Agent system prompt** (`services/agent/src/agent/loop/sdk.py`)
- `_SYSTEM` **(modify)** — the F8 wording rule (fractions OK; never invent a count; never call it TILs).

**Tests:** create `services/cellvit/tests/test_pannuke.py`, `services/agent/tests/test_pannuke.py`;
extend `services/cellvit/tests/test_infer.py`, `test_segment_route.py`; `services/agent/tests/
test_segmenter.py`, `test_loop_tools.py`, `test_girder_annotations.py`, `test_sdk_loop.py`.

---

### Task 1: CellViT vendored PanNuke taxonomy (`pannuke.py`)

**Files:**
- Create: `services/cellvit/src/cellvit_service/pannuke.py`
- Test: `services/cellvit/tests/test_pannuke.py`

- [ ] **Step 1: Write the failing test**

Create `services/cellvit/tests/test_pannuke.py`:

```python
from cellvit_service.pannuke import TYPE_NAMES, name_for


def test_type_names_are_the_five_pannuke_classes():
    assert TYPE_NAMES == {
        1: "Neoplastic", 2: "Inflammatory", 3: "Connective", 4: "Dead", 5: "Epithelial",
    }


def test_name_for_maps_ids_and_falls_back_for_unknown():
    assert name_for(1) == "Neoplastic"
    assert name_for(5) == "Epithelial"
    assert name_for(0) == "Unknown"   # background never appears in cells
    assert name_for(99) == "Unknown"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/cellvit && uv run pytest tests/test_pannuke.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'cellvit_service.pannuke'`.

- [ ] **Step 3: Write minimal implementation**

Create `services/cellvit/src/cellvit_service/pannuke.py`:

```python
"""Vendored PanNuke nucleus taxonomy (GPU-free).

The authoritative values live in ``cellvit.config.config.TYPE_NUCLEI_DICT_PANNUKE``, but that
package ships only in the GPU Dockerfile (imported lazily) — the base/CI env has no ``cellvit``.
So the id→name map is vendored here as a plain constant. Keep it in sync with CellViT's PanNuke
taxonomy.
"""

# id 0 = Background (never present in cells.json). ids 1..5 are the PanNuke classes.
TYPE_NAMES: dict[int, str] = {
    1: "Neoplastic",
    2: "Inflammatory",
    3: "Connective",
    4: "Dead",
    5: "Epithelial",
}


def name_for(type_id: int) -> str:
    """PanNuke class name for a nucleus ``type`` id; ``"Unknown"`` for anything out of range."""
    return TYPE_NAMES.get(int(type_id), "Unknown")


__all__ = ["TYPE_NAMES", "name_for"]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/cellvit && uv run pytest tests/test_pannuke.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add services/cellvit/src/cellvit_service/pannuke.py services/cellvit/tests/test_pannuke.py
git commit -m "feat(cellvit): vendor PanNuke id-name taxonomy"
```

---

### Task 2: `infer.py` returns `(points, classes)`; lockstep clip; stub class

**Files:**
- Modify: `services/cellvit/src/cellvit_service/infer.py` (`segment_array`, `_stub_segment_array`,
  `_cellvit_segment_array`, `_clip_to_region`)
- Test: `services/cellvit/tests/test_infer.py`

**Interface:** `segment_array(pixels, mpp) -> tuple[list[list[float]], list[int]]` — two parallel,
index-aligned arrays. `_clip_to_region(points, classes, w, h) -> tuple[list, list]`.

- [ ] **Step 1: Write the failing test**

Replace the stub-shape assertion and the `_clip_to_region` case in `services/cellvit/tests/
test_infer.py`. The stub test (around line 25) becomes:

```python
def test_stub_segment_array_returns_aligned_points_and_classes():
    import numpy as np
    from cellvit_service.infer import segment_array

    points, classes = segment_array(np.zeros((128, 128, 3), dtype=np.uint8), mpp=None)
    assert len(points) == len(classes) and len(points) > 0
    assert all(1 <= c <= 5 for c in classes)          # deterministic PanNuke ids
    assert all(len(p) == 2 for p in points)           # xy stays 2-D
```

And the clip test (around line 71) becomes:

```python
def test_clip_to_region_drops_pad_hits_in_lockstep():
    from cellvit_service.infer import _clip_to_region

    points = [[5.0, 5.0], [246.9, 191.9], [300.0, 10.0], [10.0, 500.0], [-1.0, 5.0]]
    classes = [1, 2, 3, 4, 5]
    kept_pts, kept_cls = _clip_to_region(points, classes, 247, 192)
    assert kept_pts == [[5.0, 5.0], [246.9, 191.9]]   # only the two inside [0,247) x [0,192)
    assert kept_cls == [1, 2]                          # their classes rode along
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/cellvit && uv run pytest tests/test_infer.py -v`
Expected: FAIL — `segment_array` returns a bare list (unpack error) and `_clip_to_region` takes 3 args.

- [ ] **Step 3: Write minimal implementation**

In `services/cellvit/src/cellvit_service/infer.py`:

```python
def _clip_to_region(
    points: list[list[float]], classes: list[int], w: int, h: int
) -> tuple[list[list[float]], list[int]]:
    """Keep only centroids inside ``[0, w) x [0, h)`` — drop pad-area hits, class in lockstep."""
    kept_pts: list[list[float]] = []
    kept_cls: list[int] = []
    for p, c in zip(points, classes):
        if 0.0 <= p[0] < w and 0.0 <= p[1] < h:
            kept_pts.append(p)
            kept_cls.append(c)
    return kept_pts, kept_cls


def _stub_segment_array(
    pixels: np.ndarray, mpp: float | None
) -> tuple[list[list[float]], list[int]]:
    """A deterministic 32-px grid over the region, with a deterministic PanNuke class per point."""
    h, w = pixels.shape[:2]
    points: list[list[float]] = []
    classes: list[int] = []
    idx = 0
    for y in range(0, h, _STUB_STRIDE):
        for x in range(0, w, _STUB_STRIDE):
            points.append([float(x), float(y)])
            classes.append(1 + (idx % 5))   # cycles all five classes → typed path exercised in CI
            idx += 1
    return points, classes
```

In `_cellvit_segment_array`, read the class alongside the centroid and clip both:

```python
        cells = json.load(open(workdir / stem / "cells.json"))["cells"]
        local = [[float(c["centroid"][0]), float(c["centroid"][1])] for c in cells]
        classes = [int(c["type"]) for c in cells]
        return _clip_to_region(local, classes, w, h)
```

And update the return type of the public dispatcher:

```python
def segment_array(
    pixels: np.ndarray, mpp: float | None
) -> tuple[list[list[float]], list[int]]:
    """Region-local ``[x, y]`` centroids + aligned PanNuke class ids for the region ``pixels``."""
    if get_settings().model == "cellvit":
        return _cellvit_segment_array(pixels, mpp)
    return _stub_segment_array(pixels, mpp)
```

(Also update the `_cellvit_segment_array` / `_stub_segment_array` return annotations to the tuple.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/cellvit && uv run pytest tests/test_infer.py -v`
Expected: PASS (all, including the padding/mpp tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add services/cellvit/src/cellvit_service/infer.py services/cellvit/tests/test_infer.py
git commit -m "feat(cellvit): read nucleus class alongside centroid"
```

---

### Task 3: `/segment` returns typed counts + asserts the alignment invariant

**Files:**
- Modify: `services/cellvit/src/cellvit_service/app.py` (the `/segment` handler)
- Test: `services/cellvit/tests/test_segment_route.py`

**Interface:** `/segment` response gains `classes: list[int]`, `counts_by_type: dict[str,int]` (by
name, zero-count classes omitted), `class_names: dict[str,str]`; existing `count`/`centroids`/`bbox`/
`mpp` preserved. Invariant `count == len(centroids) == len(classes) == sum(counts_by_type.values())`.

- [ ] **Step 1: Write the failing test**

In `services/cellvit/tests/test_segment_route.py`, update the injected fake to the new return shape
(around line 29) and add typed assertions:

```python
def test_segment_returns_typed_counts_and_class_names(client_app):
    app, client = client_app

    def fake_segment(pixels, mpp):
        return [[0.0, 0.0], [10.0, 20.0], [5.0, 5.0]], [1, 2, 1]  # (points, class ids)

    app.config["SEGMENT"] = fake_segment
    # ... existing READ_REGION fake with scale=1.0 and a bbox at (100, 200) ...

    body = client.post("/segment", json={
        "slide_ref": "s1", "bbox": {"x": 100, "y": 200, "width": 50, "height": 50},
    }).get_json()

    assert body["count"] == 3
    assert body["centroids"] == [[100.0, 200.0], [110.0, 220.0], [105.0, 205.0]]
    assert body["classes"] == [1, 2, 1]
    assert body["counts_by_type"] == {"Neoplastic": 2, "Inflammatory": 1}
    assert body["class_names"]["1"] == "Neoplastic" and len(body["class_names"]) == 5
    # invariant holds
    assert body["count"] == len(body["centroids"]) == len(body["classes"])
    assert sum(body["counts_by_type"].values()) == body["count"]
```

(Match the existing test's fixture/`READ_REGION` setup — reuse how `test_segment_route.py` already
builds `app`/`client` and the region fake; only the `SEGMENT` return shape and assertions change.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/cellvit && uv run pytest tests/test_segment_route.py -v`
Expected: FAIL — the route unpacks a bare list from `SEGMENT` and emits no `classes`/`counts_by_type`.

- [ ] **Step 3: Write minimal implementation**

In `services/cellvit/src/cellvit_service/app.py`, add the import and rewrite the tail of `segment()`:

```python
from .pannuke import TYPE_NAMES, name_for
```

```python
        local_points, classes = app.config["SEGMENT"](region.pixels, region.mpp)
        centroids = offset_points(local_points, bbox["x"], bbox["y"], region.scale)

        counts_by_type: dict[str, int] = {}
        for c in classes:
            n = name_for(c)
            counts_by_type[n] = counts_by_type.get(n, 0) + 1

        # Alignment invariant (F2): a mismatch is an internal error, not a miscoloured overlay.
        if not (len(centroids) == len(classes) == sum(counts_by_type.values())):
            return jsonify({"detail": "internal: class/centroid misalignment"}), 500

        return jsonify({
            "count": len(centroids),
            "centroids": centroids,
            "classes": classes,
            "counts_by_type": counts_by_type,
            "class_names": {str(k): v for k, v in TYPE_NAMES.items()},
            "bbox": bbox,
            "mpp": region.mpp,
        })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/cellvit && uv run pytest tests/test_segment_route.py -v`
Expected: PASS (new test + pre-existing route tests, whose fakes you updated to the tuple shape).

- [ ] **Step 5: Commit**

```bash
git add services/cellvit/src/cellvit_service/app.py services/cellvit/tests/test_segment_route.py
git commit -m "feat(cellvit): typed counts in segment response"
```

---

### Task 4: `SegmentResult` carries name classes + counts (int→name at the client)

**Files:**
- Modify: `services/agent/src/agent/loop/segmenter.py`
- Test: `services/agent/tests/test_segmenter.py`

**Interface:** `SegmentResult` gains `classes: list[str]` (PanNuke names, aligned with `points`) and
`counts_by_type: dict[str, int]`. `segment_region` maps the wire's int `classes` through `class_names`;
absent/mismatched → `classes=[]` (graceful for an older service / stub).

- [ ] **Step 1: Write the failing test**

Add to `services/agent/tests/test_segmenter.py` (mirror the file's existing `MockTransport` setup):

```python
async def test_segment_region_maps_class_ids_to_names():
    import httpx
    from agent.loop.segmenter import segment_region

    def handler(request):
        return httpx.Response(200, json={
            "count": 3,
            "centroids": [[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]],
            "classes": [1, 2, 1],
            "counts_by_type": {"Neoplastic": 2, "Inflammatory": 1},
            "class_names": {"1": "Neoplastic", "2": "Inflammatory", "3": "Connective",
                            "4": "Dead", "5": "Epithelial"},
            "mpp": 0.5,
        })

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://cv")
    res = await segment_region(base_url="http://cv", slide_ref="s1",
                               bbox={"x": 0, "y": 0, "width": 9, "height": 9},
                               token="tok", client=client)
    assert res.count == 3
    assert res.classes == ["Neoplastic", "Inflammatory", "Neoplastic"]
    assert res.counts_by_type == {"Neoplastic": 2, "Inflammatory": 1}
    assert len(res.classes) == len(res.points)


async def test_segment_region_without_classes_defaults_to_empty():
    import httpx
    from agent.loop.segmenter import segment_region

    def handler(request):
        return httpx.Response(200, json={"count": 1, "centroids": [[1.0, 2.0]], "mpp": None})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://cv")
    res = await segment_region(base_url="http://cv", slide_ref="s1",
                               bbox={"x": 0, "y": 0, "width": 9, "height": 9},
                               token="tok", client=client)
    assert res.classes == [] and res.counts_by_type == {}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/agent && uv run pytest tests/test_segmenter.py -v`
Expected: FAIL — `SegmentResult` has no `classes`/`counts_by_type`.

- [ ] **Step 3: Write minimal implementation**

In `services/agent/src/agent/loop/segmenter.py`:

```python
from dataclasses import dataclass, field


@dataclass(frozen=True)
class SegmentResult:
    """Segmentation outcome: a nucleus count + level-0 ``[x, y]`` centroids, the slide's native
    µm/px (``mpp``), the per-nucleus PanNuke class **name** (aligned with ``points``), and the
    per-class breakdown (``counts_by_type``, by name)."""

    count: int
    points: list[list[float]]
    mpp: float | None = None
    classes: list[str] = field(default_factory=list)
    counts_by_type: dict[str, int] = field(default_factory=dict)
```

And at the tail of `segment_region`, translate ints → names (the single translation point):

```python
    centroids = [[float(p[0]), float(p[1])] for p in data.get("centroids", [])]
    mpp = data.get("mpp")
    class_names = data.get("class_names") or {}
    names = [class_names.get(str(c)) for c in (data.get("classes") or [])]
    if len(names) != len(centroids):
        names = []   # older service / stub without classes — degrade, keep points usable
    return SegmentResult(
        count=int(data.get("count", len(centroids))),
        points=centroids,
        mpp=float(mpp) if mpp else None,
        classes=names,
        counts_by_type=data.get("counts_by_type") or {},
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/agent && uv run pytest tests/test_segmenter.py -v`
Expected: PASS (new tests + pre-existing).

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/agent/loop/segmenter.py services/agent/tests/test_segmenter.py
git commit -m "feat(agent): name-typed classes in SegmentResult"
```

---

### Task 5: Agent vendored PanNuke names + colours (`pannuke.py`)

**Files:**
- Create: `services/agent/src/agent/loop/pannuke.py`
- Test: `services/agent/tests/test_pannuke.py`

- [ ] **Step 1: Write the failing test**

Create `services/agent/tests/test_pannuke.py`:

```python
from agent.loop.pannuke import PANNUKE_NAMES, CLASS_HEX


def test_pannuke_names_in_id_order():
    assert PANNUKE_NAMES == ["Neoplastic", "Inflammatory", "Connective", "Dead", "Epithelial"]


def test_class_hex_covers_every_name():
    assert set(CLASS_HEX) == set(PANNUKE_NAMES)
    assert CLASS_HEX["Neoplastic"] == "#ff0000"
    assert CLASS_HEX["Inflammatory"] == "#22dd4d"
    assert CLASS_HEX["Epithelial"] == "#ff9f44"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/agent && uv run pytest tests/test_pannuke.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'agent.loop.pannuke'`.

- [ ] **Step 3: Write minimal implementation**

Create `services/agent/src/agent/loop/pannuke.py`:

```python
"""Vendored PanNuke class names + overlay colours for the agent loop (GPU-free).

Mirrors CellViT's PanNuke taxonomy/colours (``cellvit.config.config``), vendored because that
package is GPU-only. ``PANNUKE_NAMES`` (id order) drives the loop stub; ``CLASS_HEX`` is the DSA
``point`` element ``lineColor`` (repo ``makePoint`` convention). Names must match the CellViT
service's ``pannuke.TYPE_NAMES``.
"""

# PanNuke ids 1..5 in order — used by the GPU-free loop stub to synthesize typed nuclei.
PANNUKE_NAMES: list[str] = ["Neoplastic", "Inflammatory", "Connective", "Dead", "Epithelial"]

# Official PanNuke overlay colours (COLOR_DICT_CELLS), name → hex for a DSA element `lineColor`.
CLASS_HEX: dict[str, str] = {
    "Neoplastic": "#ff0000",     # 255,0,0
    "Inflammatory": "#22dd4d",   # 34,221,77
    "Connective": "#235cec",     # 35,92,236
    "Dead": "#feff00",           # 254,255,0
    "Epithelial": "#ff9f44",     # 255,159,68
}


__all__ = ["PANNUKE_NAMES", "CLASS_HEX"]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/agent && uv run pytest tests/test_pannuke.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/agent/loop/pannuke.py services/agent/tests/test_pannuke.py
git commit -m "feat(agent): vendor PanNuke names and colours"
```

---

### Task 6: `tools.py` typed summary + name-`classes` geometry + typed stub

**Files:**
- Modify: `services/agent/src/agent/loop/tools.py`
- Test: `services/agent/tests/test_loop_tools.py`

**Interface:** the `run_segmentation` summary enumerates the breakdown (desc by count; degrades to a
bare total with no classes); geometry gains `classes: list[str]` (names); the loop stub emits names.

- [ ] **Step 1: Write the failing test**

Add to `services/agent/tests/test_loop_tools.py`:

```python
from agent.loop.tools import _typed_summary


def test_typed_summary_formats_breakdown_desc_and_degrades():
    assert _typed_summary(195, {"Neoplastic": 142, "Inflammatory": 31, "Connective": 22}) == \
        "195 nuclei — 142 Neoplastic, 31 Inflammatory, 22 Connective"
    assert _typed_summary(195, {"Neoplastic": 195}) == "195 nuclei — 195 Neoplastic"
    assert _typed_summary(195, {}) == "195 nuclei"


async def test_stub_segmentation_geometry_carries_name_classes(monkeypatch):
    import agent.loop.tools as tools

    class _SpyStore:
        def __init__(self): self.geometry = None
        async def put(self, **kw):
            from agent.loop.artifacts import ArtifactHandle
            self.geometry = kw["geometry"]
            return ArtifactHandle(kind="nuclei", ref="r1", count=kw["geometry"]["count"],
                                  summary=kw["summary"], bbox=kw["bbox"])
        async def get(self, **kw): return None

    spy = _SpyStore()
    ctx = tools.ToolContext(owner="u1", conversation_id=1, artifacts=spy)  # no cellvit_url → stub
    scope = {"roi": {"x": 0, "y": 0, "width": 10, "height": 10}}
    out = await tools.run_server_tool(tools.get_tool("run_segmentation"), {}, scope, ctx)

    assert out.ok
    assert set(spy.geometry["classes"]) <= {"Neoplastic", "Inflammatory", "Connective",
                                            "Dead", "Epithelial"}
    assert len(spy.geometry["classes"]) == len(spy.geometry["points"])
    assert "—" in out.summary   # typed breakdown, not a bare total
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/agent && uv run pytest tests/test_loop_tools.py -v`
Expected: FAIL — `_typed_summary` does not exist; stub geometry has no `classes`.

- [ ] **Step 3: Write minimal implementation**

In `services/agent/src/agent/loop/tools.py`, import the names and add two helpers:

```python
from .pannuke import PANNUKE_NAMES


def _counts_by_type(classes: list[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for name in classes:
        if name:
            counts[name] = counts.get(name, 0) + 1
    return counts


def _typed_summary(count: int, counts_by_type: dict[str, int]) -> str:
    """"195 nuclei — 142 Neoplastic, 31 Inflammatory" (breakdown desc by count).

    No classes → just the total; the counts are always tool-derived (never model-computed)."""
    head = f"{count:,} nuclei"
    if not counts_by_type:
        return head
    parts = [f"{n:,} {name}" for name, n in
             sorted(counts_by_type.items(), key=lambda kv: (-kv[1], kv[0]))]
    return f"{head} — {', '.join(parts)}"
```

Rewrite `_stub_nuclei_geometry` to carry names:

```python
def _stub_nuclei_geometry(bbox: dict | None) -> dict:
    """A deterministic canned point set with a deterministic PanNuke class per point (names)."""
    ox = float(bbox["x"]) if bbox else 0.0
    oy = float(bbox["y"]) if bbox else 0.0
    points = [[ox + (i % 64), oy + (i // 64)] for i in range(_STUB_NUCLEI)]
    classes = [PANNUKE_NAMES[i % 5] for i in range(_STUB_NUCLEI)]
    return {"kind": "nuclei", "count": len(points), "points": points, "classes": classes}
```

In `run_server_tool`, **real path** — typed summary + class-carrying geometry:

```python
            mpp_note = f" (at {res.mpp:.3g} µm/px)" if res.mpp else ""
            summary = f"segmented {_typed_summary(res.count, res.counts_by_type)}{mpp_note}"
            if ctx.artifacts is None:
                return ToolOutcome(ok=True, summary=summary)
            geometry = {"kind": "nuclei", "count": res.count, "points": res.points,
                        "classes": res.classes}
            try:
                handle = await ctx.artifacts.put(
                    owner=ctx.owner, conversation_id=ctx.conversation_id, kind="nuclei",
                    bbox=region, geometry=geometry, summary=f"{res.count:,} nuclei",
                    item_id=slide_ref, token=ctx.girder_token,
                )
            except Exception:  # noqa: BLE001 — persisting the overlay must not sink the count
                logger.warning("persisting nuclei annotation failed", exc_info=True)
                return ToolOutcome(ok=True, summary=summary)
            return ToolOutcome(ok=True, summary=summary, artifact=handle)
```

And the **stub path** — build geometry first, derive the typed summary from it:

```python
        # Canned stub (no service configured / unit context) — honors the bbox arg too.
        where = "in the region" if region else "across the slide"
        geometry = _stub_nuclei_geometry(region)
        summary = (f"segmented {_typed_summary(geometry['count'], _counts_by_type(geometry['classes']))}"
                   f" {where}")
        if ctx is None or ctx.artifacts is None:
            return ToolOutcome(ok=True, summary=summary)
        try:
            handle = await ctx.artifacts.put(
                owner=ctx.owner, conversation_id=ctx.conversation_id, kind="nuclei",
                bbox=region, geometry=geometry, summary=f"{geometry['count']:,} nuclei",
                item_id=(scope or {}).get("item_id"), token=ctx.girder_token,
            )
        except Exception:  # noqa: BLE001 — persisting the overlay must not sink the count
            logger.warning("persisting nuclei annotation failed", exc_info=True)
            return ToolOutcome(ok=True, summary=summary)
        return ToolOutcome(ok=True, summary=summary, artifact=handle)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/agent && uv run pytest tests/test_loop_tools.py -v`
Expected: PASS (new tests + pre-existing loop-tools tests; update any that asserted the old
`"segmented 1,234 nuclei ..."` string to the typed form).

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/agent/loop/tools.py services/agent/tests/test_loop_tools.py
git commit -m "feat(agent): typed counts summary and geometry"
```

---

### Task 7: `girder_annotations.py` persists the class (`group` + `lineColor`)

**Files:**
- Modify: `services/agent/src/agent/loop/girder_annotations.py`
- Test: `services/agent/tests/test_girder_annotations.py`

**Interface:** `put` tags each `point` element with `group` (name) + `lineColor` (PanNuke hex) and adds
the annotation's `groups` list; `get` reads `group` back into an aligned name `classes` list (missing
group → `None`). `len(classes) == len(points)` always.

- [ ] **Step 1: Write the failing test**

Add to `services/agent/tests/test_girder_annotations.py`:

```python
@pytest.mark.asyncio
async def test_put_tags_group_and_linecolor_per_element():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"_id": "ann1"})

    await _store(handler).put(
        owner="u1", conversation_id=1, kind="nuclei",
        bbox={"x": 0, "y": 0, "width": 5, "height": 5},
        geometry={"kind": "nuclei", "count": 2, "points": [[1, 2], [3, 4]],
                  "classes": ["Neoplastic", "Inflammatory"]},
        summary="2 nuclei", item_id="item9", token="tok",
    )
    els = seen["body"]["elements"]
    assert els[0] == {"type": "point", "center": [1.0, 2.0, 0],
                      "group": "Neoplastic", "lineColor": "#ff0000"}
    assert els[1]["group"] == "Inflammatory" and els[1]["lineColor"] == "#22dd4d"
    assert seen["body"]["groups"] == ["Neoplastic", "Inflammatory"]


@pytest.mark.asyncio
async def test_get_reads_group_back_into_aligned_classes():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"_id": "ann1", "annotation": {"elements": [
            {"type": "point", "center": [1.0, 2.0, 0], "group": "Neoplastic"},
            {"type": "point", "center": [3.0, 4.0, 0]},                       # legacy, no group
        ]}})

    got = await _store(handler).get(owner="u1", ref="ann1", token="tok")
    assert got == {"kind": "nuclei", "count": 2, "points": [[1.0, 2.0], [3.0, 4.0]],
                   "classes": ["Neoplastic", None]}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/agent && uv run pytest tests/test_girder_annotations.py -v`
Expected: FAIL — elements have no `group`/`lineColor`; `get` returns no `classes`.

- [ ] **Step 3: Write minimal implementation**

In `services/agent/src/agent/loop/girder_annotations.py`, import the colour map and rewrite `put`'s
element build and `get`'s element read:

```python
from .pannuke import CLASS_HEX
```

`put` (replace the `elements = [...]` / `doc = {...}` block):

```python
        points = geometry.get("points", [])
        count = geometry.get("count", len(points))
        classes = geometry.get("classes") or []
        elements: list[dict] = []
        groups: list[str] = []
        for i, p in enumerate(points):
            el = {"type": "point", "center": [float(p[0]), float(p[1]), 0]}
            name = classes[i] if i < len(classes) else None
            if name:
                el["group"] = name
                if name in CLASS_HEX:
                    el["lineColor"] = CLASS_HEX[name]   # repo makePoint convention (F4)
                if name not in groups:
                    groups.append(name)
            elements.append(el)
        doc = {
            "name": f"Copilot nuclei · {count}",
            "description": _describe(count, bbox),
            "elements": elements,
        }
        if groups:
            doc["groups"] = groups
```

`get` (replace the `points = [...]` comprehension and the return):

```python
        elements = (data.get("annotation") or {}).get("elements") or []
        points: list[list[float]] = []
        classes: list[str | None] = []
        for el in elements:
            center = el.get("center") or ()
            if el.get("type") == "point" and len(center) >= 2:
                points.append([float(center[0]), float(center[1])])
                classes.append(el.get("group"))   # name or None, in lockstep with points
        return {"kind": "nuclei", "count": len(points), "points": points, "classes": classes}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/agent && uv run pytest tests/test_girder_annotations.py -v`
Expected: PASS (new tests + pre-existing put/get round-trip tests — update those to expect the added
`classes` key on `get`).

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/agent/loop/girder_annotations.py services/agent/tests/test_girder_annotations.py
git commit -m "feat(agent): persist nucleus class on DSA annotation"
```

---

### Task 8: Frontend PanNuke colour module (`pannukeColors.js`)

**Files:**
- Create: `src/components/viewer/pannukeColors.js`

> **Note:** the committed branch has no JS test runner (vitest arrives only with the uncommitted
> dashboard WIP, which must not be committed). This module is pure and side-effect-free; it is verified
> by use in Task 9's browser E2E. If/when a committed vitest harness lands, add a unit test for
> `colorForClass` and `presentClasses`.

- [ ] **Step 1: Create the module**

Create `src/components/viewer/pannukeColors.js`:

```javascript
// PanNuke class → copilot overlay colour. Mirrors CellViT COLOR_DICT_CELLS (vendored — the
// service emits class *names*; this maps a name to a canvas rgba). Keep in sync with the agent's
// pannuke.CLASS_HEX and the CellViT service pannuke.TYPE_NAMES.
export const CLASS_COLOR = {
  Neoplastic:   'rgba(255, 0, 0, 0.85)',
  Inflammatory: 'rgba(34, 221, 77, 0.85)',
  Connective:   'rgba(35, 92, 236, 0.85)',
  Dead:         'rgba(254, 255, 0, 0.85)',
  Epithelial:   'rgba(255, 159, 68, 0.85)',
};

// Cyan — the safe default for an unknown / legacy (null-class) nucleus (today's overlay colour).
export const DEFAULT_NUCLEUS_COLOR = 'rgba(34, 211, 238, 0.85)';

export function colorForClass(name) {
  return CLASS_COLOR[name] || DEFAULT_NUCLEUS_COLOR;
}

// Distinct class names actually present in an overlay, in canonical PanNuke order (for the legend).
const ORDER = ['Neoplastic', 'Inflammatory', 'Connective', 'Dead', 'Epithelial'];
export function presentClasses(nuclei) {
  const set = new Set((nuclei?.classes || []).filter(Boolean));
  return ORDER.filter((n) => set.has(n));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/viewer/pannukeColors.js
git commit -m "feat(copilot): PanNuke overlay colour map"
```

---

### Task 9: `NucleiOverlay.jsx` — colour by class + legend

**Files:**
- Modify: `src/components/viewer/NucleiOverlay.jsx`

**Interface:** each dot is coloured by `copilotNuclei.classes?.[i] ?? null` via `colorForClass` (cyan
fallback, dark stroke kept); a small legend lists the classes present in the current overlay.

- [ ] **Step 1: Update the component**

Replace `src/components/viewer/NucleiOverlay.jsx` with:

```javascript
// src/components/viewer/NucleiOverlay.jsx
// Copilot nuclei overlay. Paints the centroids a run produced as dots on the slide, coloured by
// PanNuke class (increment 1), mirroring AnnotationCanvas: a <canvas> pinned over OSD, re-projected
// via imgToViewer on every viewport event so the dots track pan/zoom. Non-interactive.
import React, { useRef, useEffect, useCallback } from 'react';
import { useStore } from '../../store/index.js';
import { imgToViewer } from '../annotations/annotationUtils.js';
import { colorForClass, presentClasses } from './pannukeColors.js';

export default function NucleiOverlay({ viewer }) {
  const canvasRef = useRef(null);
  const copilotNuclei = useStore((s) => s.copilotNuclei);
  const showNucleiOverlay = useStore((s) => s.showNucleiOverlay);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const osd = viewer.current;
    if (!canvas || !osd?.element) return;
    const el = osd.element;
    if (canvas.width !== el.clientWidth || canvas.height !== el.clientHeight) {
      canvas.width = el.clientWidth;
      canvas.height = el.clientHeight;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!showNucleiOverlay || !copilotNuclei) return;

    const pts = copilotNuclei.points || [];
    const classes = copilotNuclei.classes;         // may be undefined / shorter (legacy)
    ctx.save();
    ctx.strokeStyle = 'rgba(8, 51, 68, 0.9)';      // dark stroke for contrast on light tissue
    ctx.lineWidth = 0.75;
    for (let i = 0; i < pts.length; i++) {
      const p = imgToViewer(osd, pts[i][0], pts[i][1]);
      if (p.x < -8 || p.y < -8 || p.x > canvas.width + 8 || p.y > canvas.height + 8) continue;
      ctx.fillStyle = colorForClass(classes?.[i] ?? null);   // per-class colour, cyan fallback (F6)
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }, [viewer, copilotNuclei, showNucleiOverlay]);

  useEffect(() => {
    const osd = viewer.current;
    if (!osd) return undefined;
    const events = ['open', 'animation', 'animation-finish', 'pan', 'zoom',
                    'resize', 'rotate', 'update-viewport'];
    events.forEach((e) => osd.addHandler(e, render));
    render();
    return () => {
      events.forEach((e) => { try { osd.removeHandler(e, render); } catch (_) { /* */ } });
    };
  }, [viewer, render]);

  useEffect(() => { render(); }, [render]);

  const legend = (showNucleiOverlay && copilotNuclei) ? presentClasses(copilotNuclei) : [];

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute', top: 0, left: 0,
          width: '100%', height: '100%', zIndex: 4, pointerEvents: 'none',
        }}
      />
      {legend.length > 0 && (
        <div
          style={{
            position: 'absolute', bottom: 12, left: 12, zIndex: 5, pointerEvents: 'none',
            background: 'rgba(15,23,42,0.72)', color: '#e2e8f0', borderRadius: 6,
            padding: '6px 8px', font: '11px/1.4 system-ui, sans-serif',
          }}
        >
          {legend.map((name) => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%',
                             background: colorForClass(name), border: '1px solid rgba(8,51,68,0.9)' }} />
              {name}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Manual browser E2E**

`npm run dev` + the agent/cellvit stack up. Open a slide → Copilot tab → draw a Region → "count the
nuclei here". Confirm: (1) the answer enumerates the **typed breakdown** (e.g. "… — 142 Neoplastic, 31
Inflammatory, …"), (2) dots render **coloured by class** with the correct PanNuke colours, (3) the
**legend** shows only the classes present, (4) a `Copilot nuclei · <count>` annotation appears in the
Annotations panel coloured by group, (5) reload → the annotation persists and re-renders coloured.

- [ ] **Step 3: Commit**

```bash
git add src/components/viewer/NucleiOverlay.jsx
git commit -m "feat(copilot): colour nuclei overlay by class"
```

---

### Task 10: Agent system prompt — the wording rule (F8)

**Files:**
- Modify: `services/agent/src/agent/loop/sdk.py` (`_SYSTEM`)
- Test: `services/agent/tests/test_sdk_loop.py`

- [ ] **Step 1: Write the failing test**

Add to `services/agent/tests/test_sdk_loop.py`:

```python
def test_system_prompt_bounds_typed_class_claims():
    from agent.loop.sdk import _SYSTEM
    assert "never invent a count" in _SYSTEM
    assert "TILs" in _SYSTEM   # must not label a PanNuke Inflammatory fraction a TILs score
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/agent && uv run pytest tests/test_sdk_loop.py::test_system_prompt_bounds_typed_class_claims -v`
Expected: FAIL — the phrases are not yet in `_SYSTEM`.

- [ ] **Step 3: Write minimal implementation**

In `services/agent/src/agent/loop/sdk.py`, insert the F8 sentence into `_SYSTEM` before
`"Research use only; this is not a diagnosis."`:

```python
    "Every quantitative claim MUST come from a tool result — never invent a count or a "
    "density. You may report class breakdowns and fractions of tool-reported counts (e.g. "
    "'~16% of the cells here are Inflammatory'), but never call a PanNuke Inflammatory "
    "fraction a TILs score or a diagnosis. All coordinates are image / level-0 pixels. When a "
    "request needs a region and none is given, use the current viewport or the whole slide as "
    "appropriate. Research use only; this is not a diagnosis."
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/agent && uv run pytest tests/test_sdk_loop.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/agent/loop/sdk.py services/agent/tests/test_sdk_loop.py
git commit -m "feat(agent): bound typed-class claims in system prompt"
```

---

## Final Verification (after all tasks)

- [ ] CellViT service suite: `cd services/cellvit && uv run pytest -q && uv run ruff check .` — green + clean.
- [ ] Agent suite: `cd services/agent && uv run pytest -q && uv run ruff check .` — green + clean.
- [ ] **Real-GPU browser E2E** (Chen's deployment, `cellvit` configured): segment a mixed ROI →
  (1) the answer enumerates the typed breakdown with numbers matching the tool output exactly;
  (2) the overlay paints nuclei by PanNuke class + a legend of present classes; (3) the DSA annotation
  is coloured by group in the Annotations panel; (4) reload → colours survive the round-trip.
- [ ] Regression: an all-one-class result reads "N nuclei — N <Class>"; a class-less result (older
  service) reads today's "N nuclei"; legacy annotations load as cyan without throwing.
- [ ] Recreate the copilot + cellvit containers so the new code loads:
  `docker compose up -d copilot cellvit`.

## Self-Review

- **Spec coverage:** infer reads class (T2); typed `/segment` + invariant (T3, F2); name-first classes
  end-to-end — int→name at the segmenter (T4, F1), names in geometry/stores (T6/T7); `type_prob` never
  threaded (F3); DSA `group` + per-element `lineColor` (T7, F4); overlay colour-by-class + legend + null
  guard (T9, F6); zero/one/many summary formatting unit-tested (T6, F7); wording rule (T10, F8); vendored
  taxonomy in all three packages (T1/T5/T8). CellViT test-migration budget (F5) is folded into T2/T3.
  Covered.
- **Placeholder scan:** every step carries complete code + an exact command with expected output. None.
- **Type consistency:** `segment_array → (points, classes:int)` (T2) consumed by `/segment` (T3);
  wire `classes:int` + `class_names` → `SegmentResult.classes:str` (T4) → geometry `classes:str` (T6) →
  DSA `group`/`get` `classes:str|None` (T7) → overlay `classes?.[i]` (T9). Names — `Neoplastic …
  Epithelial` — identical across `cellvit_service.pannuke.TYPE_NAMES`, `agent.loop.pannuke`, and
  `pannukeColors.js`. `counts_by_type` is by name throughout. Consistent.
