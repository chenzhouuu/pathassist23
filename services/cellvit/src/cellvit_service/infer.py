"""Nucleus segmentation on an extracted region → region-local centroids.

`segment_array` dispatches on the `CELLVIT_MODEL` setting: "stub" (default) is the
GPU-free deterministic grid that keeps the pipeline testable; "cellvit" runs the real
CellViT-SAM-H model (GPU only). The real path is validated on real H&E — see the R11.0
spike verdict in docs/Chen/2026-07-21-pathagent-v2-cellvit-gpu-followup-plan.md.

cellvit/torch/tifffile are imported lazily inside the real path, so `CELLVIT_MODEL=stub`
and CI never import them (the service base env is GPU-free).
"""

import json
import logging
import shutil
import tempfile
import threading
import uuid
from pathlib import Path

import numpy as np

from .config import get_settings

logger = logging.getLogger(__name__)

_STUB_STRIDE = 32

# CellViT-SAM-H loads a ~2.7 GB checkpoint, so build it once and reuse it across requests.
# The lock makes the lazy build safe if warm-up and the first request race.
_MODEL = None
_MODEL_LOCK = threading.Lock()


def _stub_segment_array(pixels: np.ndarray, mpp: float | None) -> list[list[float]]:
    """A deterministic 32-px grid over the region — no GPU, no model."""
    h, w = pixels.shape[:2]
    return [
        [float(x), float(y)]
        for y in range(0, h, _STUB_STRIDE)
        for x in range(0, w, _STUB_STRIDE)
    ]


def _get_cellvit_model():
    """Lazily build the CellViT-SAM-H inference model (singleton). GPU only."""
    global _MODEL
    if _MODEL is None:
        with _MODEL_LOCK:
            if _MODEL is None:  # double-checked: another thread may have built it while we waited
                from cellvit.inference.inference import CellViTInference
                from cellvit.utils.ressource_manager import SystemConfiguration

                settings = get_settings()
                sc = SystemConfiguration(gpu=settings.gpu_index)
                _MODEL = CellViTInference(
                    model_name="SAM",
                    outdir=tempfile.mkdtemp(prefix="cellvit_base_"),
                    system_configuration=sc,
                    nuclei_taxonomy="pannuke",
                    batch_size=settings.batch_size,
                    geojson=False,   # we read centroids straight from cells.json
                    graph=False,
                    compression=False,
                    enforce_amp=False,
                    debug=False,
                )
    return _MODEL


def warm_up() -> bool:
    """Preload the CellViT model so the first real request doesn't pay the ~2.7 GB load.

    Best-effort and safe to call in a background thread at startup: a no-op that returns
    False when the stub backend is selected (no GPU model to load), and True once a load is
    attempted for the real backend. Never raises — a failed warm-up is logged and the first
    request retries the build and surfaces any error itself.
    """
    if get_settings().model != "cellvit":
        return False
    try:
        _get_cellvit_model()
    except Exception:  # noqa: BLE001 — warm-up is best-effort; the request path will report
        logger.warning("cellvit warm-up failed; first request will retry", exc_info=True)
    return True


def _cellvit_segment_array(pixels: np.ndarray, mpp: float | None) -> list[list[float]]:
    """Real CellViT-SAM-H inference on a region ndarray → region-local ``[x, y]`` centroids.

    CellViT has no region API, so the region is written as an OpenSlide-readable tiled TIFF
    (a mini-WSI) at ``mpp`` and run through ``process_wsi`` (which reuses CellViT's exact
    tiling/stitching/edge-dedup). ``wsi_mpp`` is passed explicitly, so the output centroids
    come back in the mini-WSI's level-0 pixel frame = region-local — the caller re-offsets
    them to level-0 slide pixels with ``scale=1.0`` (R11.0 spike verdict).
    """
    import tifffile

    mpp = mpp or 0.25
    det = _get_cellvit_model()
    workdir = Path(tempfile.mkdtemp(prefix="cellvit_seg_"))
    try:
        stem = uuid.uuid4().hex
        tif = workdir / f"{stem}.tif"
        res = 1e4 / mpp  # pixels per cm → OpenSlide derives MPP from the resolution tag
        tifffile.imwrite(
            str(tif), pixels, tile=(256, 256), photometric="rgb",
            resolution=(res, res), resolutionunit="CENTIMETER",
        )
        det.outdir = workdir
        det.process_wsi(wsi_path=str(tif), wsi_mpp=mpp, wsi_magnification=None)
        cells = json.load(open(workdir / stem / "cells.json"))["cells"]
        return [[float(c["centroid"][0]), float(c["centroid"][1])] for c in cells]
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def segment_array(pixels: np.ndarray, mpp: float | None) -> list[list[float]]:
    """Return region-local ``[x, y]`` nucleus centroids for the region ``pixels``."""
    if get_settings().model == "cellvit":
        return _cellvit_segment_array(pixels, mpp)
    return _stub_segment_array(pixels, mpp)
