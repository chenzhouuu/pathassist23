"""The CellViT inference service (Flask): region-read → infer → level-0 re-offset, over HTTP.

Flask (not FastAPI) so the process carries no pydantic v2 — the real CellViT model needs
pydantic v1 and runs in-process behind the `infer.segment_array` seam. The region reader and
model are injectable via `app.config` (tests override them), defaulting to the real
`fetch_region` / `segment_array`. Every bbox in / centroid out is level-0 slide pixels (D8).
"""

import httpx
from flask import Flask, jsonify, request
from pathassist_jobs import JobQueue

from .config import get_settings
from .geometry import offset_points, offset_rings
from .heads import warm_heads
from .infer import segment_array, warm_up
from .region import fetch_region, fetch_slide_info
from .routes import register as register_nuclei
from .slides import read_contours, tissue_core_tiles
from .taxonomy import DEFAULT
from .taxonomy import get as get_taxonomy


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
    app.config["JOBS"] = JobQueue("cellvit-worker")

    # Preload the GPU model synchronously, ON THE WORKER'S MAIN THREAD. This must NOT run in a
    # background thread: building the model starts ray, and ray initialized on a thread that
    # then exits has its GCS torn down — every later /segment then fails to connect to GCS.
    # Blocking worker startup by ~12s is the price; warm_up is best-effort and never raises.
    if get_settings().model == "cellvit":
        warm_up()

    # The classifier bundle is ~13 MB and lands in the same volume as the SAM-H checkpoint. Fetched
    # here so the first classify run does not pay for it, and so a box that cannot reach Zenodo
    # says so at boot rather than twenty minutes into a job. Never raises. A no-op where the
    # cellvit package is absent (the GPU-free image), which then classifies from whatever is
    # already in the cache volume.
    warm_heads()

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

        # PanNuke, and only PanNuke. This route is the agent's stateless "what is in this box", and
        # it re-runs the encoder every call — the five classifier heads are reached through the
        # artifact, where the tokens are already stored and a naming costs a lookup (Inc 7 D10).
        seg = app.config["SEGMENT"](region.pixels, region.mpp)
        centroids = offset_points(seg.points, bbox["x"], bbox["y"], region.scale)
        contours = offset_rings(seg.contours, bbox["x"], bbox["y"], region.scale)
        pannuke = get_taxonomy(DEFAULT)

        counts_by_type: dict[str, int] = {}
        for c in seg.classes:
            n = pannuke.name(c)
            counts_by_type[n] = counts_by_type.get(n, 0) + 1

        # Alignment invariant (F2): a mismatch is an internal error, not a miscoloured overlay.
        if not (len(centroids) == len(seg.classes) == sum(counts_by_type.values())):
            return jsonify({"detail": "internal: class/centroid misalignment"}), 500

        return jsonify({
            "count": len(centroids),
            "centroids": centroids,
            "classes": seg.classes,
            # Per-nucleus polygon in level-0 px, index-aligned with `centroids` (Inc 3b). Older
            # consumers ignore it; the biomarker rasteriser draws these to paint nucleus shape.
            "contours": contours,
            "counts_by_type": counts_by_type,
            "class_names": {str(k): v for k, v in pannuke.names.items()},
            "bbox": bbox,
            "mpp": region.mpp,
        })

    register_nuclei(app)

    return app
