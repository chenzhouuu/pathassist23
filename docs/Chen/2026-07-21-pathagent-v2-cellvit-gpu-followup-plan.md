# R11 CellViT — GPU Follow-up (Real Model) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans for the CPU phases. The **GPU phases run on the ≥24 GB box and are verified by manual smoke, not CI** — an agent writes the code; a human (or a GPU-equipped session) runs the smokes. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Swap the deterministic stub behind `cellvit_service.infer.segment_array` for the real **CellViT-SAM-H** model, containerize it on a GPU, and prove real nuclei segment + paint on a real slide — completing R11 (the framework landed in `2026-07-21-pathagent-v2-cellvit-r11-plan.md`, commits `fd07393..b6956cc`).

**Architecture:** The CellViT service and its HTTP contract are unchanged; only `infer.segment_array(pixels, mpp) -> [[x,y],…]` gets a real body, selected by a `CELLVIT_MODEL` setting (`"stub"` default keeps CPU/CI green; `"cellvit"` runs the GPU model). The model is a lazy import so the module still imports without torch. A GPU Dockerfile + a `docker-compose` service run it; the gateway reaches it by service name. Everything else (region-read, coordinate re-offset, the gateway wiring, the artifact/overlay contract) is already built and tested.

**Tech Stack:** Python 3.11, FastAPI, `uv`; **GPU:** CUDA 12.1, torch 2.2.2, `cellvit==1.0.9` (CellViT-Inference), ≥24 GB VRAM. Design spec: `docs/Chen/2026-07-21-pathagent-v2-cellvit-r11-deployment-design.md`.

## Execution status (2026-07-21, on the RTX A6000 workstation — uncommitted)

- **Phase 0 (hardening): DONE.** cellvit `/segment` → 502 on region-read failure; ruff config +
  `.gitignore`. (cellvit suite green.)
- **Phase 1 (R11.0 spike): DONE.** See the "R11.0 spike verdict" section below. Full recipe
  validated on real H&E (160 cells on the BRACS test tile, region-local coords).
- **Phase 2 (real inference): DONE + validated.** `infer.segment_array` dispatches on
  `CELLVIT_MODEL`; `_cellvit_segment_array` (tifffile mini-WSI → warm `CellViTInference` singleton →
  `process_wsi` → `cells.json` centroids) returns 160 cells through the real service module.
- **Framework pivot: `services/cellvit` rewritten FastAPI → Flask** (the pydantic v1/v2 conflict,
  see the spike verdict). Flask app + `os.getenv` config + sync `fetch_region`. cellvit suite green
  (9 passed, ruff clean); the gateway is unaffected (still 70 passed).
- **Phase 3 (container): DONE + validated in the container.** `services/cellvit/Dockerfile`
  (Flask + pinned torch 2.2.2 / pydantic-v1 / openslide-bin) + a `cellvit` GPU service in
  `services/agent/docker-compose.yml` (nvidia reservation; 2.7 GB weight bind-mounted from the host
  `~/.cache/cellvit`; gateway gets `AGENT_CELLVIT_SERVICE_URL`). **Built, started, `/health` ok, GPU
  passthrough (CUDA True), model loaded from the mounted weights, real inference = 160 cells on
  BRACS inside `agent-cellvit-1`** — identical to the host result. **Container config finding:**
  cellvit's ray backend needs a large `/dev/shm` → added `shm_size: "8gb"` +
  `RAY_OBJECT_STORE_ALLOW_SLOW_STORAGE=1` (ray spills to /tmp/ray, perf warning only).
- **Phase 4 (real-slide E2E): pending** — needs a keyed gateway + a real slide + the browser. The
  `agent-cellvit-1` container is left running and ready.
- Local validation env (kept): spike venv `~/.cache/cellvit-spike`, weights `~/.cache/cellvit`,
  test DB in the scratchpad. `services/agent/max-ROI guard` done (agent suite green).

## Global Constraints

- **License posture: research / non-commercial** (Chen's call) — CellViT (Commons Clause + PanNuke CC-BY-NC-SA) is cleared for this use; cite the papers. Do NOT ship this as a commercial/clinical product without a license review.
- **TDD** for the CPU phases (Phase 0, Phase 2A) — failing test first. **The GPU phases (Phase 1, 2B, 3, 4) have no CI test** — the real model/torch/Girder/GPU are unavailable off-box; their acceptance is a **manual smoke with the exact commands given**. Never claim a GPU task passed without pasting the smoke output.
- **Keep the stub as the default and fallback.** `CELLVIT_MODEL=stub` (default) must always work with no torch installed, so the existing CPU tests stay green. Only `CELLVIT_MODEL=cellvit` on the GPU box loads the real model.
- **Coordinate frame (D8):** every centroid returned is level-0 slide pixels. The spike (Phase 1) must nail the frame of CellViT's output relative to the input region + MPP, and set `offset_points`' `scale` accordingly.
- **D3:** the Girder token stays server-to-server; never a model argument.
- English for all code/comments/docs/commits; line length ≤ 100; `uv` for deps/tests.
- **Commit only when Chen asks** (he authorized per-task local commits for the R11 SDD run — confirm the same here). Conventional Commits, subject ≤ 50, no trailing period, ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Never commit secrets or unrelated WIP. Do NOT commit downloaded model weights.

---

## File Structure

**Modify — `services/cellvit/`:**
- `pyproject.toml` — add `[tool.ruff]` (mirror `services/agent`), `ruff` dev dep, `testpaths`; the real `cellvit`/`torch` deps live only in the Dockerfile (optional extra), never in the base deps (CPU/CI must install without them).
- `.gitignore` — new, mirror `services/agent/.gitignore`.
- `src/cellvit_service/config.py` — add `model: str = "stub"` (env `CELLVIT_MODEL`).
- `src/cellvit_service/app.py` — structured 502 when the region read fails; `/health` reports real GPU availability.
- `src/cellvit_service/infer.py` — dispatch `segment_array` → `_stub_segment_array` (default) vs `_cellvit_segment_array` (lazy GPU model).
- `Dockerfile` — new, CUDA 12.1 + `pip install cellvit`.
- `tests/test_segment_route.py`, `tests/test_infer.py` — error-path + dispatch tests.

**Modify — deploy:**
- the existing `docker-compose` file that defines the `copilot` gateway + `db` — add a `cellvit` GPU service and set the gateway's `AGENT_CELLVIT_SERVICE_URL`.

---

## Phase 0 — cellvit hardening (CPU, TDD, executable now)

### Task 1: Structured error when the region read fails

**Files:**
- Modify: `services/cellvit/src/cellvit_service/app.py`
- Modify: `services/cellvit/tests/test_segment_route.py`

**Interfaces:**
- Produces: `POST /segment` returns **502** with a clear detail when the Girder region read raises, instead of a raw 500.

- [ ] **Step 1: Write the failing test**

Append to `services/cellvit/tests/test_segment_route.py`:
```python
import httpx


def test_segment_returns_502_when_region_read_fails():
    from cellvit_service.app import create_app
    app = create_app()

    async def failing_read(*, girder_base, slide_ref, bbox, token, client=None):
        raise httpx.ConnectError("girder unreachable")

    app.state.read_region = failing_read
    client = TestClient(app, raise_server_exceptions=False)
    r = client.post("/segment", json={
        "slide_ref": "x", "bbox": {"x": 0, "y": 0, "width": 8, "height": 8},
    })
    assert r.status_code == 502
    assert "region" in r.json()["detail"].lower()
```

- [ ] **Step 2: Run — expect fail**

Run: `cd services/cellvit && uv run pytest tests/test_segment_route.py::test_segment_returns_502_when_region_read_fails -v`
Expected: FAIL (currently a raw 500 from the unhandled `httpx.ConnectError`).

- [ ] **Step 3: Implement**

In `services/cellvit/src/cellvit_service/app.py`, add `import httpx` and a `from fastapi import HTTPException`, and wrap the region read in the `/segment` route:
```python
        try:
            region = await request.app.state.read_region(
                girder_base=settings.girder_base, slide_ref=body.slide_ref,
                bbox=bbox, token=body.girder_token,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"could not read the slide region from Girder: {exc}",
            ) from exc
```
(Leave the `segment`/`offset_points` lines as they are, after this block.)

- [ ] **Step 4: Run — expect pass, and the full suite stays green**

Run: `cd services/cellvit && uv run pytest -q`
Expected: PASS (all green; +1 new test).

- [ ] **Step 5: Commit**

```bash
git add services/cellvit/src/cellvit_service/app.py services/cellvit/tests/test_segment_route.py
git commit  # fix(cellvit): 502 when the region read fails  (on Chen's go-ahead)
```

---

### Task 2: Tooling parity with the sibling service

**Files:**
- Modify: `services/cellvit/pyproject.toml`
- Create: `services/cellvit/.gitignore`
- (fix any files ruff flags)

**Interfaces:** none (config + lint). Deliverable: `ruff check` clean, `uv.lock` committed, `.gitignore` present.

- [ ] **Step 1: Add the ruff config + dev dep**

In `services/cellvit/pyproject.toml`, add to the dev group `"ruff>=0.6"`, add `testpaths = ["tests"]` under `[tool.pytest.ini_options]`, and append:
```toml
[tool.ruff]
line-length = 100
target-version = "py311"

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]
```
(No `BLE`/flake8-bugbear FastAPI immutable-calls block is needed yet — cellvit's routes don't use `Depends`/`Header` in argument defaults. Add it later if that changes.)

- [ ] **Step 2: Add `.gitignore`**

Create `services/cellvit/.gitignore` (mirror `services/agent/.gitignore`):
```
.venv/
__pycache__/
*.pyc
.pytest_cache/
.ruff_cache/
.env
```

- [ ] **Step 3: Run ruff and fix findings**

Run: `cd services/cellvit && uv run ruff check .`
Expected findings and their fixes:
- `tests/test_segment_route.py` — `import numpy as np`, `from cellvit_service.region import RegionImage`, `import httpx` sit mid-file (E402). Move all imports to the top of the file with the existing `from starlette.testclient import TestClient`.
- Any unused import / import-order (I) finding — apply `uv run ruff check --fix .` for the autofixable ones, then re-run.
Re-run until `ruff check .` reports "All checks passed!".

- [ ] **Step 4: Verify tests still green**

Run: `cd services/cellvit && uv run pytest -q`
Expected: PASS (import moves don't change behavior).

- [ ] **Step 5: Commit (including the lockfile)**

```bash
git add services/cellvit/pyproject.toml services/cellvit/.gitignore services/cellvit/uv.lock services/cellvit/tests/test_segment_route.py
git commit  # chore(cellvit): ruff config, gitignore, lockfile  (on Chen's go-ahead)
```

---

## Phase 1 — R11.0 spike (GPU box, throwaway, no production code)

### Task 3: Resolve the region→centroids recipe on real CellViT

**Runs on the ≥24 GB GPU box. Deliverable: a short written verdict (paste into the ledger / this file) that fixes Phase 2B's code — no committed code from this task.**

- [ ] **Install + self-check.** In a fresh CUDA 12.1 env: `pip install cellvit==1.0.9`, then `cellvit-check` (reports torch/CUDA/GPU) and `cellvit-download-examples`. Confirm SAM-H weights auto-download (≥3 GB cache) and note **the cache directory path** (needed for the Docker volume). Record VRAM used and the example WSI latency.

- [ ] **Answer the four spike questions (this is the whole point):**
  1. **Region input path** — can we run inference on an in-memory region **ndarray** by importing CellViT's internal inference function (read the installed `cellvit` package source for the callable behind `cellvit-inference`/`detect_cells`), OR must we write the ROI as an **OpenSlide-readable pyramidal TIFF** (`pyvips`/`tifffile`) and run the packaged `process_wsi`? Pick the one that works; the ndarray path is preferred (no temp file), the mini-WSI path is the robust fallback.
  2. **Output coordinate frame** — given an input region + its MPP, are CellViT's returned centroids in the **input array's pixel frame**, or in the internally-upsampled 0.25 µm/px frame? This sets `offset_points`' `scale`: if output is in the input frame at native mag, `scale = 1.0`; if in the 0.25 µm/px frame, `scale = mpp / 0.25`.
  3. **MPP handling** — does the chosen path accept an MPP argument (so a 20× slide is upscaled internally), or must we read the region at 0.25 µm/px ourselves? Confirm the `region.py` read magnification to use.
  4. **Output parsing** — what exact structure comes back (JSON/GeoJSON fields for centroid + class), so Phase 2B can extract `[x, y]` per nucleus.

- [ ] **Produce a minimal working snippet:** a ≤30-line Python function `region_array + mpp -> [[x,y],…]` on the real model, run on one example region, that returns a plausible nucleus count at plausible coordinates. This snippet IS the Phase 2B `_cellvit_segment_array` body.

- [ ] **Record the verdict** (path chosen, coordinate/scale rule, MPP rule, parse rule, cache dir, VRAM, latency) in `docs/Chen/2026-07-21-pathagent-v2-cellvit-gpu-followup-plan.md` under a new "## R11.0 spike verdict" heading, and in the SDD ledger.

---

## Phase 2 — real inference behind the seam

### Task 4A: Config-dispatched model seam (CPU, TDD, executable now)

**Files:**
- Modify: `services/cellvit/src/cellvit_service/config.py`
- Modify: `services/cellvit/src/cellvit_service/infer.py`
- Modify: `services/cellvit/tests/` (new `test_infer.py`)

**Interfaces:**
- Produces: `segment_array(pixels, mpp)` dispatches on `get_settings().model`: `"stub"` (default) → `_stub_segment_array`; `"cellvit"` → `_cellvit_segment_array` (lazy import, GPU). `_stub_segment_array` keeps the current 32-px-grid behavior.

- [ ] **Step 1: Write the failing test**

`services/cellvit/tests/test_infer.py`:
```python
import numpy as np

from cellvit_service.infer import segment_array


def test_default_model_is_the_stub_grid():
    # 128x128 at stride 32 → 4x4 = 16 grid points (the deterministic stub)
    pts = segment_array(np.zeros((128, 128, 3), dtype=np.uint8), mpp=None)
    assert len(pts) == 16
    assert pts[0] == [0.0, 0.0]
```

- [ ] **Step 2: Run — expect pass already? No — verify it passes against the CURRENT stub, then refactor without breaking it.**

Run: `cd services/cellvit && uv run pytest tests/test_infer.py -v`
Expected: PASS against today's `segment_array` (it IS the stub). This test pins the stub behavior so the refactor can't change it.

- [ ] **Step 3: Add the setting + dispatch (refactor)**

In `config.py`, add:
```python
    # Which segmentation model /segment uses. "stub" (default) is a GPU-free deterministic
    # grid; "cellvit" loads the real CellViT-SAM-H model (GPU only).
    model: str = "stub"
```
Rewrite `infer.py`:
```python
"""Nucleus segmentation on an extracted region → region-local centroids.

`segment_array` dispatches on the `CELLVIT_MODEL` setting: "stub" (default) is the
GPU-free deterministic grid that keeps the pipeline testable; "cellvit" lazily loads the
real CellViT-SAM-H model (GPU only, filled in Phase 2B). The real model swaps in behind
this exact signature — the /segment route and the coordinate re-offset never change.
"""

import numpy as np

from .config import get_settings

_STUB_STRIDE = 32


def _stub_segment_array(pixels: np.ndarray, mpp: float | None) -> list[list[float]]:
    """A deterministic 32-px grid over the region — no GPU, no model."""
    h, w = pixels.shape[:2]
    return [
        [float(x), float(y)]
        for y in range(0, h, _STUB_STRIDE)
        for x in range(0, w, _STUB_STRIDE)
    ]


def _cellvit_segment_array(pixels: np.ndarray, mpp: float | None) -> list[list[float]]:
    """Real CellViT-SAM-H inference (GPU). Filled by Phase 2B from the R11.0 spike."""
    raise NotImplementedError("CELLVIT_MODEL=cellvit requires the Phase 2B GPU implementation")


def segment_array(pixels: np.ndarray, mpp: float | None) -> list[list[float]]:
    """Return region-local ``[x, y]`` nucleus centroids for the region ``pixels``."""
    if get_settings().model == "cellvit":
        return _cellvit_segment_array(pixels, mpp)
    return _stub_segment_array(pixels, mpp)
```

- [ ] **Step 4: Run — the pinned stub test still passes**

Run: `cd services/cellvit && uv run pytest -q`
Expected: PASS (all green — the route still uses the stub by default).

- [ ] **Step 5: Commit**

```bash
git add services/cellvit/src/cellvit_service/config.py services/cellvit/src/cellvit_service/infer.py services/cellvit/tests/test_infer.py
git commit  # feat(cellvit): config-dispatched model seam  (on Chen's go-ahead)
```

### Task 4B: Real CellViT-SAM-H inference (GPU, manual smoke)

**Runs on the GPU box. Fills `_cellvit_segment_array` from the Phase 1 verdict.**

- [ ] **Implement `_cellvit_segment_array`** in `infer.py` using the spike's snippet: lazy-`import` the cellvit inference entrypoint INSIDE the function (so `CELLVIT_MODEL=stub`/CI never imports torch), run inference on `pixels` (passing `mpp` per the spike's MPP rule), parse centroids, and return region-local `[[x,y],…]`. If the spike chose the mini-WSI path, encapsulate the temp-TIFF write + `process_wsi` + GeoJSON parse here. Apply the spike's coordinate rule: if output is not in the input-array frame, the caller's `offset_points(..., scale=...)` must compensate — thread the needed `scale`/`mpp` back through `RegionImage.scale` accordingly (adjust `region.py` read magnification if the spike says to read at 0.25 µm/px instead of native).

- [ ] **GPU smoke (paste output as the acceptance evidence):**
  ```bash
  CELLVIT_MODEL=cellvit uv run python - <<'PY'
  import numpy as np
  from cellvit_service.infer import segment_array
  # a real H&E region is better; a synthetic one at least proves the model runs
  pts = segment_array(np.random.randint(0, 255, (1024, 1024, 3), dtype=np.uint8), mpp=0.25)
  print("nuclei:", len(pts), "sample:", pts[:3])
  PY
  ```
  Expected: runs on the GPU without error and returns a plausible, non-grid count. (Best: run on a real H&E 1024² tile and eyeball that the count is biologically sane.)

- [ ] **Commit** (`feat(cellvit): real CellViT-SAM-H inference`) — do NOT commit weights.

---

## Phase 3 — GPU container + compose (GPU)

### Task 5: Dockerfile, compose service, gateway wiring, GPU /health

- [ ] **Dockerfile** — `services/cellvit/Dockerfile`:
  ```dockerfile
  # CellViT inference service (GPU). CUDA 12.1 / torch 2.2.2 per the cellvit pin.
  FROM pytorch/pytorch:2.2.2-cuda12.1-cudnn8-runtime
  RUN pip install --no-cache-dir cellvit==1.0.9 \
        fastapi "uvicorn[standard]" httpx numpy pillow pydantic-settings
  WORKDIR /app
  COPY src ./src
  ENV PYTHONPATH=/app/src CELLVIT_MODEL=cellvit
  EXPOSE 8020
  CMD ["uvicorn", "cellvit_service.app:create_app", "--factory", \
       "--host", "0.0.0.0", "--port", "8020"]
  ```
  Mount the spike's weight-cache dir as a named volume so the ~1–2 GB SAM-H checkpoint survives restarts and isn't re-downloaded.

- [ ] **GPU-aware `/health`** — in `app.py`, make `/health` report real GPU availability without importing torch on CPU:
  ```python
  @app.get("/health")
  async def health() -> dict:
      s = get_settings()
      gpu = None
      if s.model == "cellvit":
          try:
              import torch  # noqa: PLC0415 — GPU-only, lazy by design
              gpu = torch.cuda.is_available()
          except Exception:  # noqa: BLE001
              gpu = False
      return {"status": "ok", "service": "cellvit", "model": s.model, "gpu": gpu}
  ```
  (Fail loud if `CELLVIT_MODEL=cellvit` but `gpu is False` — that's the R10 "runtime missing in container" lesson: a mis-mapped GPU should be obvious at `/health`, not at the first /segment.)

- [ ] **Compose** — in the existing compose file defining the `copilot`/`db` services, add:
  ```yaml
    cellvit:
      build: ./services/cellvit
      environment:
        CELLVIT_MODEL: cellvit
        CELLVIT_GIRDER_BASE: ${AGENT_GIRDER_BASE:-https://lymphoma.dev.pathassist.health/api/v1}
      deploy:
        resources:
          reservations:
            devices:
              - { driver: nvidia, count: 1, capabilities: [gpu] }
      volumes:
        - cellvit-weights:/root/.cache   # replace with the spike's cache dir
  ```
  and on the `copilot` gateway service add `AGENT_CELLVIT_SERVICE_URL: http://cellvit:8020` (same compose network → reach by service name; no host.docker.internal needed). Add `cellvit-weights:` under top-level `volumes:`.

- [ ] **Smoke:** `docker compose up -d cellvit`, then `curl http://<host>:8020/health` → `{"model":"cellvit","gpu":true}`. Then from the gateway container, POST /segment with a real `slide_ref` + a valid `girder_token` + a small bbox → real centroids. Paste the output.

- [ ] **Commit** (`feat(cellvit): GPU Dockerfile + compose service`).

---

## Phase 4 — real-slide end-to-end (GPU + browser)

### Task 6: Browser E2E + max-ROI guard

- [ ] **Max-ROI guard (CPU-testable, do first):** in the gateway `run_server_tool` real path (`services/agent/src/agent/loop/tools.py`), reject a region whose area exceeds a bound (e.g. `MAX_SEG_AREA = 4096*4096` level-0 px²) with `ToolOutcome(ok=False, summary="That region is too large for interactive segmentation — zoom to a smaller area (≤ ~4k×4k) and ask again.")`, so a whole-slide-sized ROI degrades gracefully instead of a 15-minute GPU hang. Write a failing test (`test_run_segmentation_rejects_oversized_region`) first, then implement, then `cd services/agent && uv run pytest -q` green. Commit (`feat(copilot): guard oversized segmentation regions`).

- [ ] **Browser E2E (manual, GPU + a real slide):** with the keyed gateway (real Claude) + the `cellvit` compose service up: open a real DSA slide, draw a Region over a nucleus-dense area, ask *"count the nuclei in this region"*, approve the gated tool. **Verify:** the tool card shows a real (non-grid) count; the overlay paints nuclei **on top of the real nuclei** (coordinate/MPP correctness — this is the real acceptance test for the spike's coordinate rule); a second nearby region gives a different, plausible count. Paste a screenshot / the counts.

- [ ] **If nuclei land off-target:** the spike's coordinate/scale rule (Phase 1 Q2/Q3) is wrong — return to it, fix `offset_points`' `scale` / the region read magnification, and re-smoke. Do not proceed until nuclei land on nuclei.

---

## R11.0 spike verdict (2026-07-21, on the RTX A6000 workstation)

**Environment (verified):** RTX A6000, 48 GB VRAM, driver 535, CUDA available. `pip install
cellvit==1.0.9` works. **openslide fix:** the system `libopenslide.so.0` (3.4.1) is too old for
openslide-python 1.4.x → `ModuleNotFoundError: Couldn't locate OpenSlide shared library`. Fix =
**`pip install openslide-bin`** (bundles libopenslide 4.x); after that `import openslide` and
`import cellvit.inference.inference` both succeed. `tifffile` is available; **`pyvips` is NOT**
(no system libvips).

**API (verified by reading the installed package + `detect_cells.py`):**
```python
from cellvit.inference.inference import CellViTInference
from cellvit.utils.ressource_manager import SystemConfiguration

sc = SystemConfiguration(gpu=0)
det = CellViTInference(
    model_name="SAM", outdir=OUT, system_configuration=sc,
    nuclei_taxonomy="pannuke", batch_size=8, geojson=True,
    graph=False, compression=False, enforce_amp=False, debug=False,
)
det.process_wsi(wsi_path=MINI_TIF, wsi_mpp=0.25, wsi_magnification=40)  # writes to OUT/<stem>/
```
- `process_wsi(wsi_path, wsi_mpp=None, wsi_magnification=None, ...)` is the **only public
  inference entry** — it reads an OpenSlide-readable WSI, tiles internally at
  `patch_size=1024, overlap=64`, targets `0.25 µm/px`, and writes results (GeoJSON when
  `geojson=True`) to `outdir/<wsi_stem>/`. `wsi_mpp` is passed explicitly, so the mini-WSI's own
  metadata MPP is overridden — we only need the TIFF to be OpenSlide-*openable*.
- A lower-level array path exists (`models/cell_segmentation/cellvit_sam.py::forward` +
  `inference/postprocessing_numpy.py::post_process_single_image`) but reassembling
  tiling/stitching/edge-dedup by hand is brittle → **Q1 resolved: use the mini-WSI path**
  (reuses process_wsi's exact coordinate logic).

**Weights:** `cellvit.utils.cache_models.cache_cellvit_sam_h()` downloads **`CellViT-SAM-H-x40-AMP.pth`
(2.80 GB)** from Zenodo record 15094831 to **`CACHE_DIR = $CELLVIT_CACHE or ~/.cache/cellvit`**.
→ **Dockerfile:** set `CELLVIT_CACHE=/weights-cache` and mount a named volume there (persist the
2.8 GB checkpoint across restarts).

**RESOLVED empirically (real CellViT-SAM-H on the real BRACS H&E tiff, 650×743):**
- OpenSlide **opens a plain `tifffile` tiled TIFF** (`tile=(256,256)`, resolution tag → mpp) as a
  1-level WSI — **no pyvips/libvips needed.** `wsi_mpp` passed explicitly overrides the tag anyway.
- **Q2/Q3 coordinate frame CONFIRMED:** output centroids are in the mini-WSI's level-0 pixel frame
  = **region-local**, so `offset_points(scale=1.0)` + add the bbox origin. (BRACS run: 160 cells,
  x∈[15,647] y∈[4,741], all inside the 650×743 region.)
- **Output parsing:** read `outdir/<stem>/cells.json` → `["cells"][i]["centroid"] = [x, y]` (also has
  `bbox`, `contour`, `type_prob`, PanNuke class). `geojson=False` is enough — centroids come from
  cells.json. The validated recipe = `services/cellvit/src/cellvit_service/infer.py::_cellvit_segment_array`
  (tifffile mini-WSI → warm CellViTInference singleton → process_wsi → cells.json centroids).

**⚠️ CRITICAL DEPLOYMENT CONFLICT — pydantic v1 vs v2:** `cellvit` is built for **pydantic v1**
(`pip install cellvit` resolves `pydantic==1.10.26`; its internal models like `LivePatchWSIConfig`
break under pydantic 2.x with "N validation errors ... missing"). Our `services/cellvit` uses
**FastAPI + pydantic-settings → pydantic v2**. **They cannot share one Python process/env** — a
`pydantic>=2.7` in the env breaks cellvit. Consequences for the container + the service framework:
- **Option A (recommended):** rewrite `services/cellvit` with **Flask** (no pydantic dependency) so
  cellvit runs in-process with a warm model. `config.py` drops `pydantic-settings` for `os.getenv`;
  `app.py` becomes Flask (manual JSON parsing); `geometry/region/infer` unchanged. Single process,
  model warm (~30–60 s load once, then fast), gateway-invisible (it's still an HTTP `/segment`).
- **Option B:** keep the FastAPI service (v2) + a **persistent cellvit worker subprocess** (v1 env,
  model warm) with local IPC. Keeps the built framework/tests but adds subprocess lifecycle + a
  protocol.
- **Option C (rejected):** subprocess-per-request via the cellvit CLI — reloads the 2.7 GB model on
  every /segment (~30–60 s each) → too slow for interactive use.
- Also pin **torch to a driver-compatible CUDA build** in the Dockerfile: `pip install cellvit`
  pulls the latest torch (cu13x) which needs a newer driver than 535 — base on
  `pytorch/pytorch:2.2.2-cuda12.1` or install `torch==2.5.1+cu121`.

---

## Deferred beyond this plan (R12+)

- Whole-slide async segmentation + `tool_progress` events + the non-blocking progress card.
- Durable DSA-annotation artifacts (overlays surviving reload) replacing the in-memory store.
- Per-nucleus class typing surfaced in the overlay (PanNuke 5-class); classifier hot-swap.
- Per-session token lifecycle hardening.
