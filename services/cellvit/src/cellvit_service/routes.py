"""The nuclei artifact's HTTP surface: enqueue a job, poll it, read it back (Inc 5, ticket 05).

Registered beside the existing `/segment`, which is unchanged — that route is the agent's
stateless "what is in this box" call and keeps working exactly as it did. What is new is the
artifact control plane: a job that stores rings on disk, addressed by a content hash, which the
Workspace lists and later tickets rasterise.

Everything expensive is reached through `app.config` seams, so the whole surface is testable with a
Flask test client and no GPU, no weights and no slide:

    READ_REGION(girder_base, slide_ref, bbox, token) -> RegionImage
    SLIDE_INFO(girder_base, slide_ref, token)        -> (width, height, mpp)
    SEGMENT(pixels, mpp)                             -> (points, classes, contours)
"""

import logging
import shutil
from pathlib import Path

from flask import jsonify, request

from .artifacts import (
    Coverage,
    art_hash,
    artifact_dir,
    meta_path,
    read_json,
    summary_path,
)
from .config import get_settings
from .nuclei import SlideInfo, run_region

logger = logging.getLogger(__name__)

# The only backend today. Named rather than implied so the artifact hash, the meta and the panel
# all say which model produced a nucleus, and a future decoder can coexist instead of invalidating
# what is already stored.
DEFAULT_BACKEND = "cellvit-sam-h"


def register(app) -> None:
    @app.post("/nuclei")
    def enqueue_nuclei():
        body = request.get_json(force=True, silent=True) or {}
        slide_ref = body.get("slide_ref")
        bbox = body.get("bbox")
        if not slide_ref:
            return jsonify({"detail": "slide_ref is required"}), 400
        if not isinstance(bbox, dict):
            # Whole-slide is ticket 07: it needs the tissue mask to know where to bother looking,
            # and a cooperative stop to be interruptible. Refusing is better than quietly running
            # for hours over background.
            return jsonify({"detail": "a bbox object is required (whole-slide is not yet built)"}), 400

        s = get_settings()
        if app.config.get("SEGMENT") is None:
            return jsonify({"detail": "nuclei segmentation needs the GPU worker"}), 503

        backend = DEFAULT_BACKEND if s.model == "cellvit" else "stub"
        ah = art_hash(backend=backend)
        token = body.get("girder_token")

        def work(report):
            width, height, mpp = app.config["SLIDE_INFO"](
                girder_base=s.girder_base, slide_ref=slide_ref, token=token,
            )

            def read(window):
                return app.config["READ_REGION"](
                    girder_base=s.girder_base, slide_ref=slide_ref, bbox=window, token=token,
                )

            return run_region(
                root=artifact_dir(s.artifact_cache, slide_ref, ah), art=ah,
                slide=SlideInfo(width, height, mpp),
                bbox=bbox, tiles=None,
                read_region=read, segment=app.config["SEGMENT"], backend=backend,
                report=report, should_stop=getattr(report, "stopping", None),
            )

        job_id = app.config["JOBS"].submit(work)
        return jsonify({
            "art_hash": ah, "job_id": job_id, "status": "queued",
            "backend": backend, "scope": "region",
        })

    @app.get("/nuclei/status/<job_id>")
    def nuclei_job_status(job_id: str):
        st = app.config["JOBS"].status(job_id)
        if st is None:
            return jsonify({"detail": "unknown job"}), 404
        return jsonify(st)

    @app.post("/nuclei/cancel/<job_id>")
    def nuclei_job_cancel(job_id: str):
        """Ask a job to stop at its next core-tile boundary. Wired to the UI in ticket 07."""
        st = app.config["JOBS"].cancel(job_id)
        if st is None:
            return jsonify({"detail": "unknown job"}), 404
        return jsonify(st)

    @app.get("/nuclei/<item>/<ahash>/meta")
    def nuclei_meta(item: str, ahash: str):
        root = _root(item, ahash)
        meta = read_json(meta_path(root))
        if meta is None:
            return jsonify({"detail": "no nuclei artifact for that hash"}), 404
        cov = Coverage.load(root)
        meta["coverage"] = {"core": cov.core, "n_tiles": len(cov.done),
                            "bounds": cov.bounds(), "done": sorted(cov.done)}
        meta["summary"] = read_json(summary_path(root)) or {}
        return jsonify(meta)

    @app.delete("/nuclei/<item>/<ahash>")
    def delete_nuclei(item: str, ahash: str):
        """Remove an artifact's whole directory. Idempotent, like tissue's and biomarker's —
        the gateway deletes the durable row first and this second."""
        try:
            root = _root(item, ahash)
        except ValueError as exc:
            return jsonify({"detail": str(exc)}), 400
        if root.is_dir():
            shutil.rmtree(root)
        return "", 204

    @app.get("/nuclei/<item>/<ahash>/usage")
    def nuclei_usage(item: str, ahash: str):
        """What this artifact costs on disk, for the confirm dialog. 0 for one already gone."""
        try:
            root = _root(item, ahash)
        except ValueError as exc:
            return jsonify({"detail": str(exc)}), 400
        return jsonify({"bytes": _dir_bytes(root)})


def _root(item: str, ahash: str) -> Path:
    return artifact_dir(get_settings().artifact_cache, item, ahash)


def _dir_bytes(root: Path) -> int:
    """Bytes on disk under `root`, or 0 if it is not there."""
    if not root.is_dir():
        return 0
    return sum(f.stat().st_size for f in root.rglob("*") if f.is_file())


__all__ = ["register", "DEFAULT_BACKEND"]
