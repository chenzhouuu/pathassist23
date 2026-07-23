"""The preprocess service (Flask): trigger a Trident index build, poll its status, retrieve regions.

Flask (not FastAPI) to match cellvit/pathvlm and keep the base env torch-free. The resolver,
pipeline, job queue, and retrieval fn are injectable via ``app.config`` (tests override them),
defaulting to the real implementations behind the stub/real Trident seam. Every coordinate is
level-0 slide pixels (D5). The heavy build runs on the single-consumer worker thread (F7), so /run
returns immediately with a job id and the panel polls /status.
"""

import logging

from flask import Flask, jsonify, request

from .artifacts import cache_paths, params_hash
from .config import get_settings
from .jobs import JobQueue
from .pipeline import run_pipeline
from .retrieval import find_regions as retrieve_regions
from .slide_resolver import resolve_slide

logger = logging.getLogger(__name__)


def _build_params(body: dict, settings) -> dict:
    return {
        "encoder": body.get("encoder") or settings.image_encoder,
        "mag": int(body.get("mag") or settings.default_mag),
        "patch_size": int(body.get("patch_size") or settings.default_patch_size),
        "segmenter": body.get("segmenter") or settings.default_segmenter,
    }


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["RESOLVE"] = resolve_slide          # injectable seams (tests override these)
    app.config["PIPELINE"] = run_pipeline
    app.config["FIND_REGIONS"] = retrieve_regions
    app.config["QUEUE"] = JobQueue()

    @app.get("/health")
    def health():
        s = get_settings()
        return jsonify({
            "status": "ok", "service": "preprocess",
            "model": "trident" if s.use_trident else "stub",
        })

    @app.post("/run")
    def run():
        body = request.get_json(force=True, silent=True) or {}
        item = body.get("item")
        if not item:
            return jsonify({"detail": "item is required"}), 400
        settings = get_settings()
        params = _build_params(body, settings)
        phash = params_hash(
            params["encoder"], params["mag"], params["patch_size"],
            params["segmenter"], settings.index_version,
        )
        sink = cache_paths(settings.artifact_cache, item, phash)
        token = body.get("girder_token")

        def job(report):
            slide_path = app.config["RESOLVE"](
                item, settings.download_dir, settings, token,
            )
            res = app.config["PIPELINE"](
                slide_path, params, sink, use_trident=settings.use_trident, on_stage=report,
            )
            return {
                "n_patches": res.n_patches, "dim": res.dim, "encoder": res.encoder,
                "features_ref": res.features_ref, "contours_ref": res.contours_ref,
                "params_hash": phash,
            }

        job_id = app.config["QUEUE"].submit(job)
        return jsonify({
            "job_id": job_id, "params_hash": phash, "status": "queued", **params,
        }), 202

    @app.get("/status")
    def status():
        job_id = request.args.get("job_id")
        if not job_id:
            return jsonify({"detail": "job_id is required"}), 400
        s = app.config["QUEUE"].status(job_id)
        if s is None:
            return jsonify({"detail": "unknown job_id"}), 404
        result = s.pop("result", None) or {}
        return jsonify({**s, **result})

    @app.post("/find_regions")
    def find_regions():
        body = request.get_json(force=True, silent=True) or {}
        item, query = body.get("item"), body.get("query")
        if not item or not query:
            return jsonify({"detail": "item and query are required"}), 400
        settings = get_settings()
        encoder = body.get("encoder") or settings.text_encoder
        if not settings.is_text_capable(encoder):
            return jsonify({
                "detail": f"encoder '{encoder}' is image-only; text search needs a conch_v1 or "
                          "musk index",
            }), 409
        mag = int(body.get("mag") or settings.default_mag)
        patch_size = int(body.get("patch_size") or settings.default_patch_size)
        segmenter = body.get("segmenter") or settings.default_segmenter
        phash = params_hash(encoder, mag, patch_size, segmenter, settings.index_version)
        sink = cache_paths(settings.artifact_cache, item, phash)
        if not sink["features"].exists():
            return jsonify({
                "detail": "this slide isn't preprocessed for text search yet",
                "params_hash": phash,
            }), 404
        regions = app.config["FIND_REGIONS"](
            sink["features"], query, int(body.get("k") or 8), encoder,
            use_trident=settings.use_trident,
        )
        top = regions[0]["score"] if regions else 0.0
        return jsonify({
            "regions": regions, "top_score": top, "encoder": encoder,
            "n_candidates": len(regions), "query": query,
        })

    return app
