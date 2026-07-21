"""The CellViT inference service (Flask): region-read → infer → level-0 re-offset, over HTTP.

Flask (not FastAPI) so the process carries no pydantic v2 — the real CellViT model needs
pydantic v1 and runs in-process behind the `infer.segment_array` seam. The region reader and
model are injectable via `app.config` (tests override them), defaulting to the real
`fetch_region` / `segment_array`. Every bbox in / centroid out is level-0 slide pixels (D8).
"""

import httpx
from flask import Flask, jsonify, request

from .config import get_settings
from .geometry import offset_points
from .infer import segment_array
from .region import fetch_region


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["READ_REGION"] = fetch_region   # injectable seams (tests override these)
    app.config["SEGMENT"] = segment_array

    @app.get("/health")
    def health():
        settings = get_settings()
        return jsonify({"status": "ok", "service": "cellvit", "model": settings.model})

    @app.post("/segment")
    def segment():
        body = request.get_json(force=True, silent=True) or {}
        slide_ref = body.get("slide_ref")
        bbox = body.get("bbox")
        if not slide_ref or not isinstance(bbox, dict):
            return jsonify({"detail": "slide_ref and a bbox object are required"}), 400

        settings = get_settings()
        try:
            region = app.config["READ_REGION"](
                girder_base=settings.girder_base, slide_ref=slide_ref,
                bbox=bbox, token=body.get("girder_token"),
            )
        except httpx.HTTPError as exc:
            return jsonify(
                {"detail": f"could not read the slide region from Girder: {exc}"}
            ), 502

        local = app.config["SEGMENT"](region.pixels, region.mpp)
        centroids = offset_points(local, bbox["x"], bbox["y"], region.scale)
        return jsonify({"count": len(centroids), "centroids": centroids, "bbox": bbox})

    return app
