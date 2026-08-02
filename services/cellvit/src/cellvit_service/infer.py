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
from dataclasses import dataclass
from math import ceil
from pathlib import Path

import numpy as np

from .artifacts import TOKEN_DIM
from .config import get_settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Segmented:
    """One region's nuclei: five arrays that are index-aligned and must stay that way.

    A tuple would do and did until Inc 7, when the fourth and fifth arrived. Five parallel lists
    positional-unpacked at six call sites is the shape that gets mis-indexed once and then pairs
    every nucleus with its neighbour's outline forever, so they travel named.

    ``classes`` and ``probs`` are **PanNuke**: the class the decoder's type head gave this nucleus,
    and the fraction of the instance's pixels that voted for it (upstream's ``type_prob``, which
    is a genuine per-nucleus agreement measure rather than a posterior — a different quantity from
    the softmax a classifier head produces, and stored under the same name for the same purpose).

    ``tokens`` is ``[N, 1280]``: the encoder's per-nucleus embedding, which is what every
    classifier head reads and what Inc 7 exists to keep.
    """

    points: list[list[float]]
    classes: list[int]
    contours: list[list[list[float]]]
    tokens: np.ndarray
    probs: list[float]

    @staticmethod
    def empty() -> "Segmented":
        return Segmented([], [], [], np.zeros((0, TOKEN_DIM), dtype=np.float16), [])

_STUB_STRIDE = 32

# CellViT-SAM-H tiles its input at this patch size in the model's target-mpp frame. A mini-WSI
# smaller than one patch makes process_wsi sample a single patch, and its patch→WSI coordinate
# mapping is then off by ~one patch — every centroid comes back shifted by hundreds of px
# (verified: a 247x192 region returned x[-490,-252] unpadded vs x[6,244] once padded past a
# patch). We pad sub-patch regions up so process_wsi tiles like a normal WSI, then clip away any
# detection that lands in the padded margin. Large regions already tile correctly and are untouched.
_CELLVIT_PATCH = 1024        # inference patch side (px), in the model's target-mpp frame
_CELLVIT_TARGET_MPP = 0.25   # CellViT-SAM-H is an x40 model
_PAD_MARGIN = 128            # clear the patch + tile overlap so the WSI tiles unambiguously


def _min_native_side(mpp: float) -> int:
    """Native px a region side must reach so its resampled size clears one inference patch.

    process_wsi resamples native ``mpp`` → the model target mpp, so
    ``resampled = native * (mpp / target)``. We need ``resampled ≥ patch + margin``, i.e.
    ``native ≥ (patch + margin) * target / mpp``.
    """
    return max(1, ceil((_CELLVIT_PATCH + _PAD_MARGIN) * _CELLVIT_TARGET_MPP / mpp))


def _pad_to_min(pixels: np.ndarray, min_side: int) -> np.ndarray:
    """Pad bottom/right so both sides reach ``min_side``, keeping content at the origin.

    The region stays at ``[0:h, 0:w]`` byte-for-byte, so its centroids need no un-offset. The
    pad is filled with the region's per-channel median (a tissue-free background estimate) so it
    grows no spurious nuclei, and any that do appear at the seam are clipped by
    :func:`_clip_to_region`. A no-op (returns the input unchanged) when the region already
    clears ``min_side`` — large regions tile correctly on their own.
    """
    h, w = pixels.shape[:2]
    pad_h = max(0, min_side - h)
    pad_w = max(0, min_side - w)
    if not pad_h and not pad_w:
        return pixels
    fill = np.median(pixels.reshape(-1, pixels.shape[2]), axis=0).astype(pixels.dtype)
    canvas = np.empty((h + pad_h, w + pad_w, pixels.shape[2]), dtype=pixels.dtype)
    canvas[:] = fill
    canvas[:h, :w] = pixels
    return canvas


def _clip_to_region(seg: Segmented, w: int, h: int) -> Segmented:
    """Keep only centroids inside ``[0, w) x [0, h)`` — drop pad-area hits.

    Every array is filtered in lockstep with the centroids: they are index-aligned everywhere
    downstream (the rasteriser draws ``contours[i]`` for the cell whose centroid is ``points[i]``,
    and a classifier head reads ``tokens[i]`` for the same one), so a partial filter would silently
    mis-pair nuclei — or, worse than mis-pair, label them from a neighbour's embedding.
    """
    keep = [i for i, p in enumerate(seg.points) if 0.0 <= p[0] < w and 0.0 <= p[1] < h]
    if len(keep) == len(seg.points):
        return seg
    tokens = (seg.tokens[keep] if len(seg.tokens)
              else np.zeros((0, TOKEN_DIM), dtype=np.float16))
    return Segmented(
        points=[seg.points[i] for i in keep],
        classes=[seg.classes[i] for i in keep],
        contours=[seg.contours[i] for i in keep],
        tokens=tokens,
        probs=[seg.probs[i] for i in keep],
    )

# CellViT-SAM-H loads a ~2.7 GB checkpoint, so build it once and reuse it across requests.
# The lock makes the lazy build safe if warm-up and the first request race.
_MODEL = None
_MODEL_LOCK = threading.Lock()


# Stub nuclei are drawn as a small diamond so the contour path (rasterise → crop → downsample)
# is exercised in CI with a shape that is neither a point nor an axis-aligned box.
_STUB_RADIUS = 9.0


def _stub_segment_array(pixels: np.ndarray, mpp: float | None) -> Segmented:
    """A deterministic 32-px grid over the region: centroid, PanNuke class and contour per point.

    Its tokens are zeros, and deliberately so. The stub has no encoder, and a plausible-looking
    embedding is the one thing worse than an obvious one: classification of a stub artifact then
    puts every nucleus in whichever class the head's bias favours, which reads as a stub rather
    than as a result. The path is exercised end to end; the labelling is not a claim.
    """
    h, w = pixels.shape[:2]
    points: list[list[float]] = []
    classes: list[int] = []
    contours: list[list[list[float]]] = []
    idx = 0
    for y in range(0, h, _STUB_STRIDE):
        for x in range(0, w, _STUB_STRIDE):
            fx, fy = float(x), float(y)
            points.append([fx, fy])
            classes.append(1 + (idx % 5))   # cycles all five classes → typed path exercised in CI
            contours.append([
                [fx, fy - _STUB_RADIUS], [fx + _STUB_RADIUS, fy],
                [fx, fy + _STUB_RADIUS], [fx - _STUB_RADIUS, fy],
            ])
            idx += 1
    return Segmented(
        points=points, classes=classes, contours=contours,
        tokens=np.zeros((len(points), TOKEN_DIM), dtype=np.float16),
        probs=[1.0] * len(points),
    )


def reset_cellvit_model() -> None:
    """Drop the inference singleton and tear ray down with it, so the next call rebuilds both.

    Why this exists. `CellViTInference` is reused across calls, and it drives its tiling through a
    pool of ray actors that live inside it. Somewhere past twenty-odd consecutive `process_wsi`
    calls those actors stop delivering: the worker thread blocks in `ray.get()` inside
    `process_wsi` with the actors alive at ~0 % CPU and the GPU idle, and never comes back. It was
    observed twice on a whole-slide run (once after 21 cores, once after 26), and confirmed by
    stack dump. Nothing in this service can interrupt it — a `ray.get()` deep inside vendored code
    is not cancellable, and cooperative stop only gets a look-in between cores.

    So the state is not allowed to accumulate that far. This is a recycle, not a fix: the upstream
    behaviour is unexplained, and the mitigation is to give it a fresh session often enough that it
    never gets there. It costs a model reload, which is why it happens on a count rather than on
    every call.

    Note this protects the interactive `/segment` route too — it was on exactly the same path to
    the same wedge, just more slowly.
    """
    global _MODEL
    with _MODEL_LOCK:
        _MODEL = None
    try:
        import ray

        if ray.is_initialized():
            ray.shutdown()
    except Exception:  # noqa: BLE001 — no ray (stub env) or an already-dead session is not an error
        logger.debug("ray shutdown during recycle was a no-op", exc_info=True)


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
                    # The one flag Inc 7 turns on. `graph` is upstream's name for "also write the
                    # per-nucleus tokens", as `cells.pt`, row-aligned with `cells.json`. They are
                    # computed either way — `retrieve_tokens=True` is how the postprocessor gets
                    # the array it classifies from — and until now we let them be discarded.
                    graph=True,
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


def _load_cells(cells_json: Path) -> list:
    """CellViT's per-region output. A region with zero detected nuclei (sparse or blank
    tissue) makes CellViT write *no* cells.json — that's an empty result, not a failure, so
    return ``[]`` instead of raising FileNotFoundError (which surfaced as a 500)."""
    if not cells_json.exists():
        return []
    with open(cells_json) as fh:
        return json.load(fh)["cells"]


def _load_tokens(cells_pt: Path, n: int) -> np.ndarray:
    """CellViT's per-nucleus embeddings, written beside ``cells.json`` when ``graph=True``.

    Row ``i`` is cell ``i`` of ``cells.json``: upstream filters ``cell_tokens`` through the same
    ``keep_idx``, the same ``_reallign_grid`` and the same ``_remove_padding`` as the cell list, and
    returns before writing either when there are no cells at all. So the two files exist together
    or not at all, and are the same length.

    That length is checked rather than trusted. A mismatch would not fail — it would label every
    nucleus from its neighbour's embedding, which is the kind of wrong that looks like a result.
    """
    if n == 0:
        return np.zeros((0, TOKEN_DIM), dtype=np.float16)
    if not cells_pt.exists():
        raise RuntimeError(
            f"cellvit wrote {n} nuclei but no {cells_pt.name} — the inference session was built "
            f"without graph=True, so these nuclei could never be classified"
        )
    import torch

    graph = torch.load(cells_pt, map_location="cpu", weights_only=False)
    tokens = np.asarray(graph.x.detach().cpu().numpy(), dtype=np.float16)
    if tokens.shape != (n, TOKEN_DIM):
        raise RuntimeError(
            f"cellvit returned {tokens.shape} tokens for {n} nuclei — expected ({n}, {TOKEN_DIM}); "
            f"the token/cell alignment this artifact depends on does not hold"
        )
    return tokens


def _cellvit_segment_array(pixels: np.ndarray, mpp: float | None) -> Segmented:
    """Real CellViT-SAM-H inference → region-local centroids, PanNuke classes and tokens.

    CellViT has no region API, so the region is written as an OpenSlide-readable tiled TIFF
    (a mini-WSI) at ``mpp`` and run through ``process_wsi`` (which reuses CellViT's exact
    tiling/stitching/edge-dedup). ``wsi_mpp`` is passed explicitly, so the output centroids
    come back in the mini-WSI's level-0 pixel frame = region-local — the caller re-offsets
    them to level-0 slide pixels with ``scale=1.0`` (R11.0 spike verdict).
    """
    import tifffile

    mpp = mpp or 0.25
    h, w = pixels.shape[:2]
    # Pad a sub-patch region up so process_wsi tiles it normally (see _pad_to_min); real nuclei
    # then come back in the true region frame and pad-margin detections are clipped out below.
    padded = _pad_to_min(pixels, _min_native_side(mpp))
    det = _get_cellvit_model()
    workdir = Path(tempfile.mkdtemp(prefix="cellvit_seg_"))
    try:
        stem = uuid.uuid4().hex
        tif = workdir / f"{stem}.tif"
        res = 1e4 / mpp  # pixels per cm → OpenSlide derives MPP from the resolution tag
        tifffile.imwrite(
            str(tif), padded, tile=(256, 256), photometric="rgb",
            resolution=(res, res), resolutionunit="CENTIMETER",
        )
        det.outdir = workdir
        det.process_wsi(wsi_path=str(tif), wsi_mpp=mpp, wsi_magnification=None)
        cells = _load_cells(workdir / stem / "cells.json")
        local = [[float(c["centroid"][0]), float(c["centroid"][1])] for c in cells]
        classes = [int(c["type"]) for c in cells]
        # CellViT already writes each nucleus\'s polygon next to its centroid; we simply stopped
        # throwing it away (Inc 3b needs the shape to rasterise the phenotype map). A cell with no
        # contour degenerates to its centroid rather than dropping the detection.
        contours = [
            [[float(px), float(py)] for px, py in c.get("contour") or []] or [list(ctr)]
            for c, ctr in zip(cells, local, strict=True)
        ]
        # The share of the instance's pixels that voted for its winning type. Real here, unlike the
        # `type_prob` upstream writes when a classifier head is in play, which it truncates to int.
        probs = [float(c.get("type_prob") or 0.0) for c in cells]
        tokens = _load_tokens(workdir / stem / "cells.pt", len(cells))
        return _clip_to_region(
            Segmented(points=local, classes=classes, contours=contours,
                      tokens=tokens, probs=probs),
            w, h,
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def segment_array(pixels: np.ndarray, mpp: float | None) -> Segmented:
    """One region's nuclei, in region-local pixels.

    See :class:`Segmented` for the alignment rule its five arrays are held to.
    """
    if get_settings().model != "cellvit":
        return _stub_segment_array(pixels, mpp)
    _recycle_if_due()
    return _cellvit_segment_array(pixels, mpp)


# Consecutive real inferences since the last rebuild. Guarded by its own lock rather than
# _MODEL_LOCK, which _get_cellvit_model holds across a 2.7 GB load.
_CALLS = 0
_CALLS_LOCK = threading.Lock()


def _recycle_if_due() -> None:
    """Rebuild the model every `recycle_every` inferences (0 disables). See reset_cellvit_model."""
    global _CALLS
    every = get_settings().recycle_every
    if every <= 0:
        return
    with _CALLS_LOCK:
        _CALLS += 1
        due = _CALLS > every
        if due:
            _CALLS = 1
    if due:
        logger.info("recycling the CellViT session after %d inferences", every)
        reset_cellvit_model()
