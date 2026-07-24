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
from flask import Flask, jsonify, request

from .cellvit_client import fetch_centroids
from .config import get_settings
from .infer import tile_fn
from .markers import CHANNEL_NAMES, MARKER_CHANNELS
from .pipeline import counts_by_phenotype, flag_counts, phenotype_region
from .region import fetch_region

logger = logging.getLogger(__name__)

# Match the agent's interactive segmentation cap: a whole-slide-sized ROI would tie up the GPU for
# minutes (that path is the Inc 3b whole-slide job, not this route).
_MAX_AREA = 4096 * 4096
# Fallback µm/px when the slide exposes no metadata (CellViT uses the same default).
_DEFAULT_MPP = 0.25


def create_app() -> Flask:
    app = Flask(__name__)
    settings = get_settings()
    app.config["READ_REGION"] = fetch_region       # injectable seams (tests override these)
    app.config["FETCH_CENTROIDS"] = fetch_centroids
    app.config["MODE"] = settings.mode
    app.config["TILE_PREDICT"] = None

    # Load the real model synchronously on the worker main thread (like CellViT's warm_up). A load
    # failure degrades to 503 rather than crashing the worker.
    if settings.mode == "real":
        try:
            from .model import load_flash
            model = load_flash(settings.weights_file)
            import torch
            model.to(f"cuda:{settings.gpu_index}" if torch.cuda.is_available() else "cpu")
            app.config["TILE_PREDICT"] = tile_fn("real", model)
        except Exception:  # noqa: BLE001 — a bad load must not crash the worker; report unavailable
            logger.exception("GigaTIME-Flash load failed; serving /phenotype as unavailable")
            app.config["MODE"] = "unavailable"
    elif settings.mode == "stub":
        app.config["TILE_PREDICT"] = tile_fn("stub", None)

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
