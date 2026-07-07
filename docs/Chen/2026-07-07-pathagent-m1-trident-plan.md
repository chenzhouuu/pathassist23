# PathAgent M1 — Trident Preprocessing Backbone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the M0 fake preprocess worker with a real Trident-backed pipeline that turns a WSI (`itemId`) into cached CONCH patch features + coords + a typed manifest, and verify it end-to-end on real slides.

**Architecture:** The RQ worker resolves a slide (local `slides_root` first, Girder download fallback), invokes Trident's `run_single_slide.py` **as a subprocess in its own heavy ML conda env** (`pathology`: torch+CUDA+openslide+CONCH), then normalizes Trident's nested output into the existing flat `CachePaths` layout and writes a typed manifest read from the real h5 attrs. The gateway/queue/registry contract from M0 is unchanged; only the worker function behind `enqueue_preprocess` is swapped.

**Tech stack:** Python 3.11, uv, FastAPI/RQ (existing), httpx (Girder), h5py (read Trident h5 attrs), subprocess (Trident in `pathology` env), pytest + respx + fakeredis.

**Verified environment facts (this machine, 2026-07-07):**
- Trident env: `/home/chen/miniconda3/envs/pathology/bin/python` (trident, torch 2.10+cu128, CUDA True).
- Trident repo: `/home/chen/MIL-Lab/trident` (`run_single_slide.py`).
- Weights cached: seg `~/.cache/trident`; CONCH/UNI in `~/.cache/huggingface`. HF token in `/home/chen/pathassist23/.env.local` as `HF_token` (forwarded via env, never logged/committed).
- Real test slides: `/home/chen/data2/BRCA-TEST/BRACS_*.svs` (BRACS_1648.svs = 895 MB, smallest).
- GPU: RTX A6000, 48 GB, idle.
- Trident output layout for a slide stem `NAME`, encoder `E`, mag `M`, patch `P`, overlap `O`:
  - coords: `JOB/{M}x_{P}px_{O}px_overlap/patches/NAME_patches.h5` — dataset `coords (N,2) int64`, `coords.attrs` = {level0_width, level0_height, level0_magnification, target_magnification, patch_size, patch_size_level0, overlap, name}.
  - features: `JOB/{M}x_{P}px_{O}px_overlap/features_E/NAME.h5` — datasets `features (N,512) float32` + `coords (N,2) int64`, same `coords.attrs`; `features.attrs.encoder == E`.
  - tissue polygons: `JOB/contours_geojson/NAME.geojson`; thumbnail: `JOB/thumbnails/NAME.jpg`.

---

## File structure

- Modify `src/pathagent/common/config.py` — add Trident/slide/subprocess settings.
- Modify `src/pathagent/common/schemas.py` — add `Manifest` model.
- Create `src/pathagent/worker/slide_resolver.py` — `resolve_slide()` (local-first, Girder fallback).
- Create `src/pathagent/worker/girder_download.py` — `download_item_slide()` (httpx).
- Create `src/pathagent/worker/trident_runner.py` — `build_command()` + `run_trident()`.
- Create `src/pathagent/worker/artifacts.py` — `normalize_and_manifest()` (reads h5, copies to flat paths, writes manifest).
- Create `src/pathagent/worker/trident_preprocess.py` — `run_trident_preprocess()` (orchestrator; the swap target).
- Modify `src/pathagent/gateway/queue.py` — enqueue `run_trident_preprocess`.
- Modify `src/pathagent/common/cache_keys.py` — bump `PIPELINE_VERSION` "1" → "2".
- Modify `pyproject.toml` — add `h5py`.
- Tests under `tests/worker/` + `tests/common/`.
- Create `scripts/m1_real_slide.py` — real-WSI end-to-end runner + report.

---

## Task 1: M1 settings

**Files:** Modify `src/pathagent/common/config.py`; Test `tests/common/test_config.py`.

Add fields to `Settings` (env-overridable via `PATHAGENT_*`):

```python
    trident_python: Path = Path("/home/chen/miniconda3/envs/pathology/bin/python")
    trident_repo: Path = Path("/home/chen/MIL-Lab/trident")
    trident_gpu: int = 0
    seg_conf_thresh: float = 0.5
    default_overlap: int = 0
    slides_root: Path | None = None
    subprocess_timeout_s: int = 3600
```

- [ ] Test: defaults present (`trident_repo` name == "trident", `trident_gpu == 0`, `slides_root is None`).
- [ ] Test: env override — set `PATHAGENT_TRIDENT_GPU=1` and `PATHAGENT_SLIDES_ROOT=/tmp/x` (via monkeypatch + `Settings()` fresh instance), assert applied.
- [ ] Commit.

Note: the HF token is **not** a Settings field. The worker forwards `HF_TOKEN`/`HUGGING_FACE_HUB_TOKEN` from `os.environ` to the Trident subprocess (see Task 3), keeping the secret out of the config object and logs.

---

## Task 2: Slide resolver (local-first) + Girder downloader

**Files:** Create `src/pathagent/worker/girder_download.py`, `src/pathagent/worker/slide_resolver.py`; Test `tests/worker/test_slide_resolver.py`, `tests/worker/test_girder_download.py`.

`girder_download.py`:
```python
import httpx
from pathlib import Path

WSI_EXTS = (".svs", ".tif", ".tiff", ".ndpi", ".scn", ".mrxs", ".dcm")

def download_item_slide(
    item_id: str, dest_dir: Path, girder_base: str, girder_token: str | None = None,
    timeout: float = 300.0,
) -> Path:
    """Download the largest WSI file of a Girder item into dest_dir; return the path."""
    headers = {"Girder-Token": girder_token} if girder_token else {}
    with httpx.Client(base_url=girder_base, headers=headers, timeout=timeout) as client:
        r = client.get(f"/item/{item_id}/files")
        r.raise_for_status()
        files = r.json()
        wsi = [f for f in files if str(f.get("name", "")).lower().endswith(WSI_EXTS)] or files
        if not wsi:
            raise ValueError(f"no files on Girder item {item_id}")
        target = max(wsi, key=lambda f: f.get("size", 0))
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / str(target["name"])
        with client.stream("GET", f"/file/{target['_id']}/download") as resp:
            resp.raise_for_status()
            with dest.open("wb") as fh:
                for chunk in resp.iter_bytes(chunk_size=1 << 20):
                    fh.write(chunk)
    return dest
```

`slide_resolver.py`:
```python
import logging
from pathlib import Path
from ..common.config import Settings
from .girder_download import WSI_EXTS, download_item_slide

logger = logging.getLogger(__name__)

def _local_candidate(item_id: str, slides_root: Path) -> Path | None:
    direct = slides_root / item_id
    if direct.is_file():
        return direct
    for ext in ("",) + WSI_EXTS:
        for hit in slides_root.glob(f"**/{item_id}{ext}"):
            if hit.is_file():
                return hit
    return None

def resolve_slide(
    item_id: str, dest_dir: Path, settings: Settings, girder_token: str | None = None,
) -> Path:
    """Resolve a slide file for item_id: local slides_root first, else Girder download."""
    if settings.slides_root is not None:
        hit = _local_candidate(item_id, settings.slides_root)
        if hit is not None:
            logger.info("resolved %s -> local %s", item_id, hit)
            return hit
    logger.info("resolving %s via Girder download", item_id)
    return download_item_slide(item_id, dest_dir, settings.girder_base, girder_token)
```

- [ ] Test (local): create `slides_root/BRACS_1648.svs`; `resolve_slide("BRACS_1648.svs", ...)` returns it without touching network.
- [ ] Test (local glob): create nested `slides_root/sub/foo.svs`; `resolve_slide("foo", ...)` finds it.
- [ ] Test (Girder, respx): mock `/item/{id}/files` (two files, pick largest `.svs`) + `/file/{fid}/download` (bytes); assert file written with correct name/content; assert `Girder-Token` header sent when token given. `slides_root=None`.
- [ ] Test (Girder no files): respx returns `[]` → `ValueError`.
- [ ] Commit.

---

## Task 3: Trident subprocess runner

**Files:** Create `src/pathagent/worker/trident_runner.py`; Test `tests/worker/test_trident_runner.py`.

```python
import logging
import os
import subprocess
from pathlib import Path
from ..common.config import Settings
from ..common.schemas import FeatureSpec

logger = logging.getLogger(__name__)

def build_command(slide_path: Path, job_dir: Path, spec: FeatureSpec, settings: Settings) -> list[str]:
    return [
        str(settings.trident_python),
        str(settings.trident_repo / "run_single_slide.py"),
        "--slide_path", str(slide_path),
        "--job_dir", str(job_dir),
        "--patch_encoder", spec.patch_encoder,
        "--mag", str(spec.mag),
        "--patch_size", str(spec.patch_size),
        "--overlap", str(settings.default_overlap),
        "--seg_conf_thresh", str(settings.seg_conf_thresh),
        "--gpu", str(settings.trident_gpu),
    ]

def _subprocess_env() -> dict[str, str]:
    env = os.environ.copy()
    tok = env.get("HF_TOKEN") or env.get("HUGGING_FACE_HUB_TOKEN")
    if tok:
        env["HF_TOKEN"] = tok
        env["HUGGING_FACE_HUB_TOKEN"] = tok
    return env

def run_trident(slide_path: Path, job_dir: Path, spec: FeatureSpec, settings: Settings) -> None:
    """Run Trident's single-slide pipeline as a subprocess; raise on failure. Logs to job_dir/trident.log."""
    job_dir.mkdir(parents=True, exist_ok=True)
    cmd = build_command(slide_path, job_dir, spec, settings)
    logger.info("running trident: %s", " ".join(cmd))
    proc = subprocess.run(
        cmd, cwd=str(settings.trident_repo), env=_subprocess_env(),
        capture_output=True, text=True, timeout=settings.subprocess_timeout_s,
    )
    (job_dir / "trident.log").write_text((proc.stdout or "") + "\n--- STDERR ---\n" + (proc.stderr or ""))
    if proc.returncode != 0:
        raise RuntimeError(f"trident failed (rc={proc.returncode}); see {job_dir/'trident.log'}")
```

- [ ] Test: `build_command` yields exact arg list (encoder/mag/patch/overlap/gpu) for a `FeatureSpec(patch_encoder="conch_v1", mag=20, patch_size=256)`.
- [ ] Test: `run_trident` success — monkeypatch `subprocess.run` to return a `CompletedProcess(returncode=0, stdout="ok", stderr="")`; assert `trident.log` written, no raise.
- [ ] Test: `run_trident` failure — monkeypatch to `returncode=1`; assert `RuntimeError` and log written.
- [ ] Test: `_subprocess_env` promotes `HF_TOKEN` to both keys (monkeypatch `os.environ`).
- [ ] Commit.

---

## Task 4: Manifest schema

**Files:** Modify `src/pathagent/common/schemas.py`; Test `tests/common/test_schemas.py`.

```python
class Manifest(CamelModel):
    """Typed description of a preprocessed case's cached artifacts."""
    cache_key: str
    item_id: str
    slide_name: str
    backbone: FeatureSpec
    patch_count: int
    feature_dim: int
    level0_width: int
    level0_height: int
    level0_magnification: float
    target_magnification: float
    patch_size_level0: int
    overlap: int
    pipeline_version: str
    artifacts: dict[str, str] = Field(default_factory=dict)
```

- [ ] Test: round-trips camelCase (`patchCount`, `featureDim`, `level0Width`) via `model_dump(by_alias=True)` / `model_validate`.
- [ ] Commit.

---

## Task 5: Artifact normalization + manifest builder

**Files:** Create `src/pathagent/worker/artifacts.py`; Test `tests/worker/test_artifacts.py`.

```python
import logging
import shutil
from pathlib import Path
import h5py
from ..common.cache_keys import CachePaths, PIPELINE_VERSION
from ..common.schemas import FeatureSpec, Manifest

logger = logging.getLogger(__name__)

def _trident_subdir(job_dir: Path, spec: FeatureSpec, overlap: int) -> Path:
    return job_dir / f"{spec.mag}x_{spec.patch_size}px_{overlap}px_overlap"

def normalize_and_manifest(
    job_dir: Path, slide_stem: str, item_id: str, cache_key: str,
    spec: FeatureSpec, overlap: int, paths: CachePaths,
) -> Manifest:
    """Locate Trident outputs, copy into the flat CachePaths, read attrs, write + return the manifest."""
    sub = _trident_subdir(job_dir, spec, overlap)
    feat_src = sub / f"features_{spec.patch_encoder}" / f"{slide_stem}.h5"
    coords_src = sub / "patches" / f"{slide_stem}_patches.h5"
    if not feat_src.is_file():
        raise FileNotFoundError(f"trident features missing: {feat_src}")

    paths.root.mkdir(parents=True, exist_ok=True)
    with h5py.File(feat_src, "r") as f:
        feats = f["features"]
        patch_count, feature_dim = int(feats.shape[0]), int(feats.shape[1])
        a = dict(f["coords"].attrs)

    shutil.copy2(feat_src, paths.features(spec.patch_encoder))
    if coords_src.is_file():
        shutil.copy2(coords_src, paths.coords)
    artifacts = {
        "features": paths.features(spec.patch_encoder).name,
        "coords": paths.coords.name if coords_src.is_file() else "",
    }
    thumb_src = job_dir / "thumbnails" / f"{slide_stem}.jpg"
    if thumb_src.is_file():
        shutil.copy2(thumb_src, paths.thumbnail)
        artifacts["thumbnail"] = paths.thumbnail.name
    geo_src = job_dir / "contours_geojson" / f"{slide_stem}.geojson"
    if geo_src.is_file():
        shutil.copy2(geo_src, paths.root / "tissue.geojson")
        artifacts["tissue"] = "tissue.geojson"

    manifest = Manifest(
        cache_key=cache_key, item_id=item_id, slide_name=slide_stem, backbone=spec,
        patch_count=patch_count, feature_dim=feature_dim,
        level0_width=int(a["level0_width"]), level0_height=int(a["level0_height"]),
        level0_magnification=float(a["level0_magnification"]),
        target_magnification=float(a["target_magnification"]),
        patch_size_level0=int(a["patch_size_level0"]), overlap=int(a["overlap"]),
        pipeline_version=PIPELINE_VERSION, artifacts=artifacts,
    )
    paths.manifest.write_text(manifest.model_dump_json(by_alias=True, indent=2))
    return manifest
```

- [ ] Test: build a synthetic Trident tree with `h5py` (features `(7,512)` f32 + coords `(7,2)` i64 with the full `coords.attrs`), a thumbnail jpg, and a geojson; run `normalize_and_manifest`; assert manifest fields (`patch_count==7`, `feature_dim==512`, level0/mag from attrs), and that `paths.features(...)`, `paths.coords`, `paths.thumbnail`, `paths.root/"tissue.geojson"`, `paths.manifest` all exist.
- [ ] Test: missing features h5 → `FileNotFoundError`.
- [ ] Commit.

---

## Task 6: Real preprocess worker (the swap target)

**Files:** Create `src/pathagent/worker/trident_preprocess.py`; Test `tests/worker/test_trident_preprocess.py`.

```python
import logging
from pathlib import Path
from typing import Any
from ..common import connection
from ..common.cache_keys import cache_paths
from ..common.config import get_settings
from ..common.registry import Registry
from ..common.schemas import FeatureSpec, JobStatus, PreprocessRequest, ReadyFlags, StatusResponse
from .artifacts import normalize_and_manifest
from .slide_resolver import resolve_slide
from .trident_runner import run_trident

logger = logging.getLogger(__name__)

def run_trident_preprocess(cache_key: str, item_id: str, request_payload: dict[str, Any]) -> None:
    """Real M1 worker: resolve slide -> Trident seg/coords/CONCH -> normalize -> ready."""
    settings = get_settings()
    registry = Registry(connection.get_job_redis())
    request = PreprocessRequest.model_validate(request_payload)
    spec: FeatureSpec = request.backbone
    paths = cache_paths(cache_key)
    job_dir = paths.root / "trident"
    try:
        registry.set_status(cache_key, StatusResponse(status=JobStatus.running, stage="resolving", progress=0.05))
        slide_path = resolve_slide(item_id, paths.root / "download", settings)
        registry.set_status(cache_key, StatusResponse(status=JobStatus.running, stage="segmentation", progress=0.2))
        run_trident(Path(slide_path), job_dir, spec, settings)
        registry.set_status(cache_key, StatusResponse(status=JobStatus.running, stage="manifest", progress=0.9))
        normalize_and_manifest(
            job_dir, Path(slide_path).stem, item_id, cache_key, spec, settings.default_overlap, paths,
        )
        registry.set_status(cache_key, StatusResponse(
            status=JobStatus.ready, stage="done", progress=1.0,
            ready=ReadyFlags(features=True, slidechat=False, classifiers=False),
        ))
        logger.info("trident preprocess complete: %s", cache_key)
    except Exception as exc:  # noqa: BLE001 - any failure becomes a visible job error
        logger.exception("trident preprocess failed: %s", cache_key)
        registry.set_status(cache_key, StatusResponse(status=JobStatus.error, stage="error", error=str(exc)))
        raise
```

- [ ] Test (happy path, all deps monkeypatched): patch `resolve_slide`→a fake path, `run_trident`→noop, `normalize_and_manifest`→a `Manifest`; use `job_redis` fixture; assert final status `ready` with `features=True` and the intermediate stages were set (`resolving`→`segmentation`→`manifest`).
- [ ] Test (error path): patch `run_trident` to raise; assert status `error` with the message and that the exception re-raises.
- [ ] Commit.

---

## Task 7: Wire the queue + bump pipeline version + h5py dep

**Files:** Modify `src/pathagent/gateway/queue.py`, `src/pathagent/common/cache_keys.py`, `pyproject.toml`; Test `tests/gateway/test_queue.py`.

- [ ] `queue.py`: import `run_trident_preprocess`, enqueue it in `enqueue_preprocess`.
- [ ] `cache_keys.py`: `PIPELINE_VERSION = "2"`.
- [ ] `pyproject.toml`: add `h5py>=3.10` to dependencies; `uv lock`.
- [ ] Update `tests/gateway/test_queue.py` to assert the enqueued function is `run_trident_preprocess`.
- [ ] Run `uv run pytest -q` — all green. Run `uv run ruff check .` — clean.
- [ ] Commit.

---

## Task 8: Real-WSI end-to-end verification

**Files:** Create `scripts/m1_real_slide.py`.

A runnable script (inline fakeredis or `--redis-url` worker mode) that:
- Sets `PATHAGENT_SLIDES_ROOT=/home/chen/data2/BRCA-TEST`, `PATHAGENT_CACHE_DIR=<tmp>`.
- Builds a `PreprocessRequest(backbone=FeatureSpec(patch_encoder="conch_v1", mag=20, patch_size=256))`.
- Runs `run_trident_preprocess(cache_key, "BRACS_1648.svs", request.model_dump(by_alias=True))` inline (HF_TOKEN in env).
- Asserts: status `ready`; `features_conch_v1.h5` exists with `features` shape `(N,512)`, `N>0`; `coords.h5` exists; `manifest.json` parses to a `Manifest` with matching `patch_count`/`feature_dim==512` and non-zero level0 dims.
- Prints a report table and exits non-zero on any failure.

- [ ] Run it on the real slide (background; minutes). Capture output.
- [ ] Write a verification report to `docs/Chen/2026-07-07-pathagent-m1-report.md`.
- [ ] Commit.

---

## Self-review notes
- **Coordinate contract:** manifest carries level-0 geometry straight from Trident `coords.attrs` (never hardcoded) — matches design §"Coordinate contract".
- **Secret hygiene:** HF token flows only through subprocess env; never written to Settings, manifest, logs, or git.
- **Cache invalidation:** `PIPELINE_VERSION` "1"→"2" invalidates M0 stub caches (Plan-2 prerequisite).
- **Env isolation:** heavy CV/ML deps stay in the `pathology` conda env behind a subprocess; the gateway/worker venv gains only `h5py`.
- **Backward compat:** `fake_preprocess.py` stays for fast inline demos/tests; only the production queue swaps to the real worker.
