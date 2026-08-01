"""The biomarker inference service (Flask): region-read + CellViT centroids → per-cell phenotype.

Mirrors the CellViT service shape: the region reader, the CellViT client, and the per-tile mIF
predictor are injectable via ``app.config`` (tests override them). The dense mIF never leaves this
process — pipeline.phenotype_region streams tiles and returns compact per-cell records (design §5,
review S2). Every bbox in / centroid out is level-0 slide pixels (D8).

Run modes (config.Settings.mode): ``real`` loads GigaTIME-Flash on the worker main thread;
``stub`` serves the deterministic dev field; ``unavailable`` ⇒ /phenotype returns 503 (an honest
"GPU worker needed" — never a fabricated phenotype).
"""

import logging

import httpx
import numpy as np
from flask import Flask, jsonify, request

from .cellvit_client import fetch_centroids
from .config import get_settings
from .infer import tile_fn
from .jobs import JobQueue
from .markers import CHANNEL_NAMES, MARKER_CHANNELS
from .nuclei_client import fetch_cells
from .pipeline import counts_by_phenotype, flag_counts, phenotype_region
from .region import fetch_region
from .routes import register as register_map_routes
from .slides import open_slide_handle, preprocess_contours_path, tissue_core_tiles

logger = logging.getLogger(__name__)

# Match the agent's interactive segmentation cap: a whole-slide-sized ROI would tie up the GPU for
# minutes (that path is the Inc 3b whole-slide job, not this route).
_MAX_AREA = 4096 * 4096
# Fallback µm/px when the slide exposes no metadata (CellViT uses the same default).
_DEFAULT_MPP = 0.25


def _nuclei_factory(slide_ref: str, token: str | None, nuclei_hash: str):
    """A per-job nucleus source: level-0 centroids + classes + contours for a read window.

    Reads the *stored* nuclei artifact rather than segmenting the slide again (Inc 5, D9). A
    whole-slide phenotype map used to run a second whole-slide CellViT pass on the same cells the
    nuclei artifact already holds; now it asks for them. The batch CellViT instance is still the
    one addressed (D12), but the call is a read, so it no longer competes for the GPU at all.

    `token` is no longer needed — reading an artifact touches no slide — and is kept in the
    signature because the caller has it and a later source may.

    The caller asks for the *haloed* window and then narrows to the core by centroid, exactly as it
    did against `/segment`, so the substitution changes where the cells come from and nothing about
    what is done with them.
    """
    base = get_settings().batch_cellvit_url

    def fetch_nuclei(bbox: dict):
        res = fetch_cells(base_url=base, slide_ref=slide_ref, art_hash=nuclei_hash, bbox=bbox)
        if not res.covered:
            # The nuclei artifact does not reach here. Writing this core anyway would put an empty
            # phenotype tile on the map, and an empty tile reads as "no cells" rather than "not
            # computed" — a hole indistinguishable from a finding. Fail with the reason instead;
            # extending the nuclei artifact and starting again resumes from coverage.
            raise RuntimeError(
                f"the nuclei artifact does not cover {bbox} — build nuclei over this area first, "
                "or the phenotype map would report an uncomputed region as empty"
            )
        return res.centroids, res.classes, res.contours

    return fetch_nuclei


def _tissue_tiles(*, item: str, seg_hash: str, width: int, height: int, core: int):
    """Core tiles intersecting the preprocess segmentation's tissue contours (read-only mount)."""
    s = get_settings()
    gj = None
    path = preprocess_contours_path(s.preprocess_cache_root, item, seg_hash)
    if path.is_file():
        import json
        with open(path) as fh:
            gj = json.load(fh)
    else:
        logger.warning("no tissue contours at %s — region jobs fall back to the requested bbox",
                       path)
    return tissue_core_tiles(gj, width, height, core)


def create_app() -> Flask:
    app = Flask(__name__)
    settings = get_settings()
    app.config["READ_REGION"] = fetch_region       # injectable seams (tests override these)
    app.config["FETCH_CENTROIDS"] = fetch_centroids
    app.config["MODE"] = settings.mode
    app.config["TILE_PREDICT"] = None
    # Inc 3b map seams (tests override these; see routes.register)
    app.config["JOBS"] = JobQueue()
    app.config["OPEN_SLIDE"] = open_slide_handle
    app.config["FETCH_NUCLEI_FACTORY"] = _nuclei_factory
    app.config["TISSUE_TILES"] = _tissue_tiles

    # Load the real model synchronously on the worker main thread (like CellViT's warm_up). A load
    # failure degrades to 503 rather than crashing the worker.
    if settings.mode == "real":
        try:
            from .model import load_flash
            model = load_flash(settings.weights_file)
            import torch
            model.to(f"cuda:{settings.gpu_index}" if torch.cuda.is_available() else "cpu")
            app.config["TILE_PREDICT"] = tile_fn("real", model)
            # Warm-up forward on the worker main thread (like CellViT): surface peak GPU memory
            # and first-inference latency at startup rather than on the first user request (M4).
            try:
                app.config["TILE_PREDICT"](np.zeros((256, 256, 3), dtype=np.uint8))
            except Exception:  # noqa: BLE001 — warm-up is best-effort, never fatal
                logger.warning("GigaTIME-Flash warm-up forward failed", exc_info=True)
        except Exception:  # noqa: BLE001 — a bad load must not crash the worker; report unavailable
            logger.exception("GigaTIME-Flash load failed; serving /phenotype as unavailable")
            app.config["MODE"] = "unavailable"
    elif settings.mode == "stub":
        app.config["TILE_PREDICT"] = tile_fn("stub", None)

    register_map_routes(app)

    @app.get("/health")
    def health():
        return jsonify({"status": "ok", "service": "biomarker", "mode": app.config["MODE"]})

    @app.post("/phenotype")
    def phenotype():
        body = request.get_json(force=True, silent=True) or {}
        slide_ref = body.get("slide_ref")
        bbox = body.get("bbox")
        if not slide_ref or not isinstance(bbox, dict):
            return jsonify({"detail": "slide_ref and a bbox object are required"}), 400
        try:
            area = float(bbox["width"]) * float(bbox["height"])
        except (KeyError, TypeError, ValueError):
            return jsonify({"detail": "bbox needs numeric x, y, width, height"}), 400
        if area <= 0 or area > _MAX_AREA:
            return jsonify({
                "detail": "region too large for interactive phenotyping — zoom to about "
                          "4000x4000 px or less (whole-slide phenotyping is a separate job)",
            }), 400

        predict = app.config["TILE_PREDICT"]
        if predict is None:
            return jsonify({
                "detail": "biomarker phenotyping needs the GPU worker (GigaTIME-Flash weights)",
            }), 503

        s = get_settings()
        try:
            region = app.config["READ_REGION"](
                girder_base=s.girder_base, slide_ref=slide_ref,
                bbox=bbox, token=body.get("girder_token"),
            )
        except httpx.HTTPError as exc:
            return jsonify({"detail": f"could not read the slide region from Girder: {exc}"}), 502
        try:
            cres = app.config["FETCH_CENTROIDS"](
                base_url=s.cellvit_url, slide_ref=slide_ref,
                bbox=bbox, token=body.get("girder_token"),
            )
        except httpx.HTTPError as exc:
            return jsonify({"detail": f"could not fetch nuclei from CellViT: {exc}"}), 502

        mpp = region.mpp or _DEFAULT_MPP
        # S1: GigaTIME-Flash is fed native-resolution tiles (no resample in v1). If the slide's
        # native mpp is far from the pinned expected value, the physical FOV per 256-window drifts
        # and predictions degrade silently — warn rather than hide it (review H1).
        if s.expected_input_mpp and region.mpp and \
                abs(region.mpp - s.expected_input_mpp) / s.expected_input_mpp > 0.2:
            logger.warning(
                "slide native mpp %.3g deviates >20%% from expected %.3g — GigaTIME FOV may drift",
                region.mpp, s.expected_input_mpp,
            )
        radius_px = max(1.0, s.nucleus_radius_um / mpp)
        cells, thresholds = phenotype_region(
            region.pixels, predict, cres.centroids, cres.classes,
            origin_x=float(bbox["x"]), origin_y=float(bbox["y"]),
            read_scale=region.scale, radius_px=radius_px,
        )
        return jsonify({
            "count": len(cells),
            "cells": cells,
            "counts_by_phenotype": counts_by_phenotype(cells),
            "flag_counts": flag_counts(cells),
            # markers with a real positive population this region (adaptive threshold not None)
            "positive_markers": sorted(m for m in MARKER_CHANNELS if thresholds.get(m) is not None),
            "marker_names": CHANNEL_NAMES,
            "bbox": bbox,
            "mpp": region.mpp,
        })

    return app
