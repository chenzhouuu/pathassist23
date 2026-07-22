"""The pathvlm Perceptor service (Flask): region-read at a target magnification → describe.

Flask (not FastAPI) to match the cellvit service and keep the base env pydantic/torch-free. The
region reader and describe fn are injectable via ``app.config`` (tests override them), defaulting
to the real ``fetch_region_at_mag`` / ``describe_array``. Every bbox is level-0 slide pixels (D8).

No region-area cap: the describe output is always bounded by ``perceptor_out_px`` and large_image
reads a large region from a low pyramid level (a cheap low-mag overview), unlike segmentation
which processes every pixel — so only bbox validity is checked.
"""

import httpx
from flask import Flask, jsonify, request

from .config import get_settings
from .infer import describe_array, warm_up
from .region import fetch_region_at_mag


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["READ_REGION"] = fetch_region_at_mag  # injectable seams (tests override these)
    app.config["DESCRIBE"] = describe_array

    # Preload MedGemma synchronously on the worker's main thread when a checkpoint is configured;
    # the stub needs no model. warm_up is best-effort and never raises.
    if get_settings().use_model:
        warm_up()

    @app.get("/health")
    def health():
        s = get_settings()
        model = "medgemma" if s.use_model else "stub"
        return jsonify({"status": "ok", "service": "pathvlm", "model": model})

    @app.post("/describe_region")
    def describe_region():
        body = request.get_json(force=True, silent=True) or {}
        slide_ref = body.get("slide_ref")
        bbox = body.get("bbox")
        if not slide_ref or not isinstance(bbox, dict):
            return jsonify({"detail": "slide_ref and a bbox object are required"}), 400
        if float(bbox.get("width", 0)) <= 0 or float(bbox.get("height", 0)) <= 0:
            return jsonify({"detail": "bbox width and height must be positive"}), 400

        settings = get_settings()
        try:
            region = app.config["READ_REGION"](
                girder_base=settings.girder_base, slide_ref=slide_ref, bbox=bbox,
                magnification=body.get("magnification"), out_px=settings.perceptor_out_px,
                default_mag=settings.perceptor_default_mag, token=body.get("girder_token"),
            )
        except httpx.HTTPError as exc:
            return jsonify(
                {"detail": f"could not read the slide region from Girder: {exc}"}
            ), 502

        description = app.config["DESCRIBE"](region.pixels, region.magnification, body.get("focus"))
        return jsonify({
            "description": description,
            "magnification_used": region.magnification,
            "mpp": region.mpp,
            "bbox": bbox,
        })

    return app
