"""The tissue segmentation service (Flask): dense tissue-class maps over a WSI (Inc 4).

Mirrors the biomarker service's shape — the slide reader, the tissue-contour source and the dense
predictor are injectable via ``app.config`` so the whole HTTP surface is testable without a GPU.

There is deliberately **no dev stub**. Inc 3b could afford one because a fabricated phenotype is
obviously a dev artefact; a fabricated *tissue map* would produce area fractions and a TSR that
look exactly like real ones. Without weights this service returns 503 and says so.
"""

import json
import logging
import os

from flask import Flask, jsonify

from .classes import BACKENDS, get_backend
from .config import get_settings
from .jobs import JobQueue
from .model import load_backend, predict_fn
from .routes import register as register_map_routes
from .slides import open_slide_handle, preprocess_contours_path, tissue_core_tiles

logger = logging.getLogger(__name__)


def _contours(*, item: str, seg_hash: str) -> dict | None:
    """This slide's tissue contours from the preprocess cache (read-only mount)."""
    path = preprocess_contours_path(get_settings().preprocess_cache_root, item, seg_hash)
    if not path.is_file():
        logger.warning("no tissue contours at %s — the region will not be masked", path)
        return None
    with open(path) as fh:
        return json.load(fh)


def _tissue_tiles(*, item: str, seg_hash: str, width: int, height: int, core: int):
    return tissue_core_tiles(_contours(item=item, seg_hash=seg_hash), width, height, core)


def _load_on_best_device(backend, settings):
    """Load on the GPU, falling back to CPU when the card is full rather than going dark.

    The A6000 is shared with cellvit, GigaTIME, Trident and whatever the user is training. A
    CUDA OOM at load time used to mark the whole service unavailable, which turns a *slow* answer
    into *no* answer. A region job on CPU is minutes rather than seconds — acceptable; a
    whole-slide job on CPU is not, and the panel's timing will make that obvious.

    ``TISSUE_DEVICE=cpu`` forces the fallback (useful while another job owns the card).
    """
    import torch

    path = settings.weights_path(backend.weights_file)
    forced = os.getenv("TISSUE_DEVICE", "").strip()
    if forced:
        return load_backend(backend, path, forced), forced
    if not torch.cuda.is_available():
        return load_backend(backend, path, "cpu"), "cpu"

    device = f"cuda:{settings.gpu_index}"
    try:
        return load_backend(backend, path, device), device
    except torch.cuda.OutOfMemoryError:
        logger.warning("GPU %s is full — loading the tissue backend on CPU instead", device)
    except RuntimeError as exc:                       # older torch raises a plain RuntimeError
        if "out of memory" not in str(exc).lower():
            raise
        logger.warning("GPU %s is full — loading the tissue backend on CPU instead", device)
    torch.cuda.empty_cache()
    return load_backend(backend, path, "cpu"), "cpu"


def create_app() -> Flask:
    app = Flask(__name__)
    settings = get_settings()
    app.config["JOBS"] = JobQueue()
    app.config["OPEN_SLIDE"] = open_slide_handle
    app.config["TISSUE_TILES"] = _tissue_tiles
    app.config["CONTOURS"] = _contours
    app.config["PREDICT"] = None
    app.config["BACKEND"] = None

    backend = get_backend(None)
    if settings.has_weights(backend.weights_file):
        try:
            model, device = _load_on_best_device(backend, settings)
            app.config["PREDICT"] = predict_fn(model, device)
            app.config["BACKEND"] = backend.name
            app.config["DEVICE"] = device
            # Warm-up on the worker main thread (like cellvit/biomarker): surface peak GPU memory
            # and first-inference latency at startup rather than on the first user request.
            try:
                import numpy as np

                app.config["PREDICT"](np.zeros((backend.patch_in, backend.patch_in, 3),
                                               dtype=np.uint8))
            except Exception:  # noqa: BLE001 — warm-up is best-effort, never fatal
                logger.warning("tissue backend warm-up forward failed", exc_info=True)
        except Exception:  # noqa: BLE001 — a bad load must not crash the worker
            logger.exception("tissue backend load failed; serving /tissue as unavailable")
    else:
        logger.warning("no tissue weights at %s — /tissue returns 503",
                       settings.weights_path(backend.weights_file))

    register_map_routes(app)

    @app.get("/health")
    def health():
        return jsonify({
            "status": "ok", "service": "tissue",
            "mode": "real" if app.config["PREDICT"] else "unavailable",
            "backend": app.config["BACKEND"],
            # Surfaced because a CPU fallback is the difference between a region job that takes
            # minutes and a whole-slide job that is not worth starting.
            "device": app.config.get("DEVICE"),
            "backends": sorted(BACKENDS),
        })

    return app
