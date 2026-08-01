"""The CellViT inference service (Flask): region-read → infer → level-0 re-offset, over HTTP.

Flask (not FastAPI) so the process carries no pydantic v2 — the real CellViT model needs
pydantic v1 and runs in-process behind the `infer.segment_array` seam. The region reader and
model are injectable via `app.config` (tests override them), defaulting to the real
`fetch_region` / `segment_array`. Every bbox in / centroid out is level-0 slide pixels (D8).
"""

import httpx
from flask import Flask, jsonify, request

from .config import get_settings
from .geometry import offset_points, offset_rings
from .infer import segment_array, warm_up
from .jobs import JobQueue
from .pannuke import TYPE_NAMES, name_for
from .region import fetch_region, fetch_slide_info
from .routes import register as register_nuclei
from .slides import read_contours, tissue_core_tiles


def _tissue_tiles(*, item: str, seg_hash: str, width: int, height: int, core: int):
    """Which core tiles a whole-slide run should bother with, from the preprocess segmentation."""
    s = get_settings()
    return tissue_core_tiles(read_contours(s.preprocess_cache, item, seg_hash),
                             width, height, core)


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["READ_REGION"] = fetch_region   # injectable seams (tests override these)
    app.config["SEGMENT"] = segment_array
    app.config["SLIDE_INFO"] = fetch_slide_info
    app.config["TISSUE_TILES"] = _tissue_tiles
    # Nuclei builds are minutes of GPU work, so they queue on one worker thread rather than
    # occupying a request (Inc 5, ticket 05). /segment stays synchronous: it is one small box.
    app.config["JOBS"] = JobQueue()

    # Preload the GPU model synchronously, ON THE WORKER'S MAIN THREAD. This must NOT run in a
    # background thread: building the model starts ray, and ray initialized on a thread that
    # then exits has its GCS torn down — every later /segment then fails to connect to GCS.
    # Blocking worker startup by ~12s is the price; warm_up is best-effort and never raises.
    if get_settings().model == "cellvit":
        warm_up()

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

        local_points, classes, local_contours = app.config["SEGMENT"](region.pixels, region.mpp)
        centroids = offset_points(local_points, bbox["x"], bbox["y"], region.scale)
        contours = offset_rings(local_contours, bbox["x"], bbox["y"], region.scale)

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
            # Per-nucleus polygon in level-0 px, index-aligned with `centroids` (Inc 3b). Older
            # consumers ignore it; the biomarker rasteriser draws these to paint nucleus shape.
            "contours": contours,
            "counts_by_type": counts_by_type,
            "class_names": {str(k): v for k, v in TYPE_NAMES.items()},
            "bbox": bbox,
            "mpp": region.mpp,
        })

    register_nuclei(app)

    return app
