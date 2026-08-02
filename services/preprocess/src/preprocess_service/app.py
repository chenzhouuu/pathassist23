"""The preprocess service (Flask): drive the Trident DAG stage-by-stage, poll status, retrieve.

Flask (not FastAPI) to match cellvit/pathvlm and keep the base env torch-free. The resolver,
pipeline, job queue, and retrieval fn are injectable via ``app.config`` (tests override them),
defaulting to the real implementations behind the stub/real Trident seam. Every coordinate is
level-0 slide pixels (D5). Heavy builds run on the single-consumer worker thread (F7), so each
trigger returns immediately with a job id and the panel polls /status.

The DAG (Inc 2b-3) is content-addressed: /segment → /patch → /features, each keyed by a hash that
transitively includes its ancestors, so upstream work is shared. /run_all chains all three (reusing
any cached stage) for the one-click path; the legacy /run remains for the flat single-shot index.
"""

import json
import logging
import os
import shutil
from pathlib import Path

from flask import Flask, jsonify, request
from pathassist_jobs import JobQueue

from .artifacts import (
    _artifact_dir,
    cache_paths,
    feat_hash,
    feat_paths,
    params_hash,
    patch_hash,
    patch_paths,
    seg_hash,
    seg_paths,
)
from .config import apply_model_cache_env, get_settings
from .pipeline import run_pipeline
from .predict import pred_hash, pred_paths, run_prediction, torch_available
from .retrieval import find_regions as retrieve_regions
from .slide_resolver import resolve_slide
from .stages import run_features, run_patching, run_segmentation
from .tasks import get_task, list_tasks

logger = logging.getLogger(__name__)


def _dir_bytes(root: Path) -> int:
    """Bytes on disk under `root`, or 0 if it is not there. Walked rather than cached: an artifact
    grows while it builds, and a stale number in a delete dialog is worse than a slow one."""
    if not root.is_dir():
        return 0
    return sum(f.stat().st_size for f in root.rglob("*") if f.is_file())


def _build_params(body: dict, settings) -> dict:
    return {
        "encoder": body.get("encoder") or settings.image_encoder,
        "mag": int(body.get("mag") or settings.default_mag),
        "patch_size": int(body.get("patch_size") or settings.default_patch_size),
        "segmenter": body.get("segmenter") or settings.default_segmenter,
    }


def _seg_params(body: dict, settings) -> dict:
    conf = body.get("seg_conf_thresh")
    return {
        "segmenter": body.get("segmenter") or settings.default_segmenter,
        "seg_conf_thresh": float(conf) if conf is not None else 0.5,
        "remove_artifacts": bool(body.get("remove_artifacts", False)),
        "remove_holes": bool(body.get("remove_holes", False)),
        "remove_penmarks": bool(body.get("remove_penmarks", False)),
    }


def _patch_params(body: dict, settings) -> dict:
    return {
        "mag": int(body.get("mag") or settings.default_mag),
        "patch_size": int(body.get("patch_size") or settings.default_patch_size),
        "overlap": int(body.get("overlap") or 0),
    }


def _seg_h(sp: dict, settings) -> str:
    return seg_hash(
        sp["segmenter"], sp["seg_conf_thresh"], sp["remove_artifacts"],
        sp["remove_holes"], sp["remove_penmarks"], settings.index_version, settings.impl,
    )


def _configure_logging() -> None:
    """Let the service's own INFO lines reach the container log.

    Gunicorn configures only its ``gunicorn.*`` loggers, so without this the root logger stays at
    WARNING and every ``logger.info`` in this package is dropped — which hides the stage timings,
    the prediction calls, and the per-stage CUDA reclaim. ``basicConfig`` is a no-op when handlers
    already exist, so this stays safe under any host.
    """
    logging.basicConfig(
        level=os.getenv("PREPROCESS_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def create_app() -> Flask:
    _configure_logging()
    # Redirect the HF / Trident weight caches to data2 before any lazy trident/conch import (F1).
    apply_model_cache_env(get_settings())
    app = Flask(__name__)
    app.config["RESOLVE"] = resolve_slide          # injectable seams (tests override these)
    app.config["PIPELINE"] = run_pipeline
    app.config["FIND_REGIONS"] = retrieve_regions
    app.config["PREDICT"] = run_prediction
    app.config["QUEUE"] = JobQueue("preprocess-worker")

    def _resolve(item, token, settings):
        return app.config["RESOLVE"](item, settings.download_dir, settings, token)

    @app.get("/health")
    def health():
        s = get_settings()
        return jsonify({
            "status": "ok", "service": "preprocess",
            "model": "trident" if s.use_trident else "stub",
        })

    # ── Content address, without doing the work (Inc 6, ticket 01) ──────────────────
    @app.post("/hash")
    def artifact_hash():
        """The `art_hash` a run with these params would produce. Enqueues nothing.

        The gateway needs the content address *before* it dispatches, because from Inc 6 the run
        goes onto a Celery queue and the gateway never sees the service's own ack. It could not
        compute the hash itself without a second copy of `artifacts.seg_hash` drifting from this
        one — the failure mode that split `conch_v1` into two encoders — so it asks instead.

        Pure: same params, same answer, no side effects, no slide read.
        """
        body = request.get_json(force=True, silent=True) or {}
        kind = body.get("kind")
        settings = get_settings()
        try:
            if kind == "segmentation":
                sp = _seg_params(body, settings)
                # `impl` rides with the params, not because a caller sets it — nobody can — but
                # because it is in the hash, and a row that records the address without recording
                # what produced it leaves two identical-looking artifacts on the same slide.
                return jsonify({"kind": kind, "art_hash": _seg_h(sp, settings),
                                "params": {**sp, "impl": settings.impl}})
            if kind == "patching":
                parent = body.get("seg_hash")
                if not parent:
                    return jsonify({"detail": "patching needs seg_hash"}), 400
                pp = _patch_params(body, settings)
                return jsonify({
                    "kind": kind, "params": {**pp, "impl": settings.impl},
                    "parent_hash": parent,
                    "art_hash": patch_hash(parent, pp["mag"], pp["patch_size"], pp["overlap"],
                                           settings.index_version, settings.impl),
                })
            if kind == "features":
                parent = body.get("patch_hash")
                if not parent:
                    return jsonify({"detail": "features needs patch_hash"}), 400
                encoder = body.get("encoder") or settings.image_encoder
                # `feat_version`, not `index_version`. The two are separate constants so that new
                # encoder weights can invalidate feature indexes without re-cutting every patch
                # grid, and this branch had the wrong one — so the address the gateway handed out
                # was not the address `/features` wrote to. Found on the DEMO slide (Inc 6 · 07):
                # the build finished, and the prediction behind it was refused 409 for a feature
                # index that was sitting on disk under a different name. The exact failure this
                # endpoint exists to prevent, inside the endpoint.
                return jsonify({
                    "kind": kind, "params": {"encoder": encoder, "impl": settings.impl},
                    "parent_hash": parent,
                    "art_hash": feat_hash(parent, encoder, settings.feat_version,
                                          settings.impl),
                })
            if kind == "prediction":
                # No `impl` here, and that is deliberate: a prediction is the MIL head applied to
                # an already-encoded index, so which pipeline produced the bytes is already carried
                # by the parent's hash. What it does depend on is `model_ver`, which is not a
                # request parameter at all — the caller chooses a task, and the registry says which
                # weights that is (`tasks.py`). Asking the caller for it would let a run be
                # addressed as weights it did not use.
                parent = body.get("feat_hash")
                task = get_task(body.get("task_id") or "")
                if not parent or task is None:
                    return jsonify({
                        "detail": f"prediction needs feat_hash and a known task_id "
                                  f"(got {body.get('task_id')!r})",
                    }), 400
                return jsonify({
                    "kind": kind, "params": {"task_id": task.id, "model_ver": task.model_ver},
                    "parent_hash": parent,
                    "art_hash": pred_hash(parent, task.id, task.model_ver),
                })
        except (TypeError, ValueError) as exc:
            return jsonify({"detail": f"bad params for {kind}: {exc}"}), 400
        return jsonify({"detail": f"no content address is defined for kind {kind!r}"}), 400

    # ── Artifact removal (Inc 5, ticket 04) ─────────────────────────────────────────
    # The gateway's row vocabulary, mapped to this service's directory names. Taking the row's own
    # `kind` keeps the mapping in one place instead of asking the gateway to know this layout.
    _KIND_DIR = {
        "segmentation": "seg", "patching": "patch", "features": "feat", "prediction": "pred",
    }

    def _artifact_root(kind: str, item: str, ahash: str) -> Path:
        sub = _KIND_DIR.get(kind)
        if sub is None:
            raise ValueError(f"unknown artifact kind {kind!r}")
        return _artifact_dir(get_settings().artifact_cache, item, sub, ahash)

    @app.delete("/artifacts/<kind>/<item>/<ahash>")
    def delete_artifact(kind: str, item: str, ahash: str):
        """Remove an artifact's whole directory.

        **Idempotent**: a directory that is already gone is a 204, not a 404. The gateway deletes
        the durable row first and this second, so a retry after a crash between the two must be
        able to finish the job rather than report a failure that has already happened.

        Only the gateway calls this, and only once it has established that nothing's `parent_hash`
        points here — this service has no view of the DAG and does not check.
        """
        try:
            root = _artifact_root(kind, item, ahash)
        except ValueError as exc:              # unknown kind, or a segment that could escape
            return jsonify({"detail": str(exc)}), 400
        if root.is_dir():
            shutil.rmtree(root)
        return "", 204

    @app.get("/artifacts/<kind>/<item>/<ahash>/usage")
    def artifact_usage(kind: str, item: str, ahash: str):
        """What this artifact costs on disk, for the confirm dialog. 0 for one already gone."""
        try:
            root = _artifact_root(kind, item, ahash)
        except ValueError as exc:
            return jsonify({"detail": str(exc)}), 400
        return jsonify({"bytes": _dir_bytes(root)})

    # ── Stage 1: tissue segmentation ────────────────────────────────────────────────
    @app.post("/segment")
    def segment():
        body = request.get_json(force=True, silent=True) or {}
        item = body.get("item")
        if not item:
            return jsonify({"detail": "item is required"}), 400
        settings = get_settings()
        sp = _seg_params(body, settings)
        sh = _seg_h(sp, settings)
        seg_sink = seg_paths(settings.artifact_cache, item, sh)
        token = body.get("girder_token")

        def job(report):
            slide_path = _resolve(item, token, settings)
            res = run_segmentation(
                slide_path, sp, seg_sink, use_trident=settings.use_trident, on_stage=report,
            )
            return {"n_contours": res.n_contours, "contours_ref": res.contours_ref, "seg_hash": sh}

        job_id = app.config["QUEUE"].submit(job)
        return jsonify({
            "job_id": job_id, "seg_hash": sh, "kind": "segmentation", "status": "queued",
            "impl": settings.impl, **sp,
        }), 202

    # ── Stage 2: tiling (needs a ready segmentation) ────────────────────────────────
    @app.post("/patch")
    def patch():
        body = request.get_json(force=True, silent=True) or {}
        item, sh = body.get("item"), body.get("seg_hash")
        if not item or not sh:
            return jsonify({"detail": "item and seg_hash are required"}), 400
        settings = get_settings()
        seg_sink = seg_paths(settings.artifact_cache, item, sh)
        if not seg_sink["contours"].exists():
            return jsonify({
                "detail": "segment this slide first (no segmentation for that seg_hash)",
                "seg_hash": sh,
            }), 409
        pp = _patch_params(body, settings)
        ph = patch_hash(sh, pp["mag"], pp["patch_size"], pp["overlap"], settings.index_version,
                        settings.impl)
        patch_sink = patch_paths(settings.artifact_cache, item, ph)
        token = body.get("girder_token")

        def job(report):
            slide_path = _resolve(item, token, settings)
            res = run_patching(
                slide_path, pp, seg_sink, patch_sink,
                use_trident=settings.use_trident, on_stage=report,
            )
            return {
                "n_patches": res.n_patches, "coords_ref": res.coords_ref,
                "patch_hash": ph, "seg_hash": sh,
            }

        job_id = app.config["QUEUE"].submit(job)
        return jsonify({
            "job_id": job_id, "patch_hash": ph, "seg_hash": sh, "kind": "patching",
            "status": "queued", "impl": settings.impl, **pp,
        }), 202

    # ── Stage 3: feature extraction (needs a ready patch grid) ──────────────────────
    @app.post("/features")
    def features():
        body = request.get_json(force=True, silent=True) or {}
        item, ph = body.get("item"), body.get("patch_hash")
        if not item or not ph:
            return jsonify({"detail": "item and patch_hash are required"}), 400
        settings = get_settings()
        patch_sink = patch_paths(settings.artifact_cache, item, ph)
        if not patch_sink["coords"].exists():
            return jsonify({
                "detail": "tile this slide first (no patch grid for that patch_hash)",
                "patch_hash": ph,
            }), 409
        encoder = body.get("encoder") or settings.image_encoder
        fh = feat_hash(ph, encoder, settings.feat_version, settings.impl)
        feat_sink = feat_paths(settings.artifact_cache, item, fh)
        token = body.get("girder_token")

        def job(report):
            slide_path = _resolve(item, token, settings)
            res = run_features(
                slide_path, {"encoder": encoder}, patch_sink, feat_sink,
                use_trident=settings.use_trident, on_stage=report, batch_limit=settings.batch_limit,
            )
            return {
                "n_patches": res.n_patches, "dim": res.dim, "encoder": res.encoder,
                "features_ref": res.features_ref, "feat_hash": fh, "patch_hash": ph,
            }

        job_id = app.config["QUEUE"].submit(job)
        return jsonify({
            "job_id": job_id, "feat_hash": fh, "patch_hash": ph, "kind": "features",
            "encoder": encoder, "status": "queued", "impl": settings.impl,
        }), 202

    # ── One-click: run the whole DAG in one job, reusing any cached stage ───────────
    @app.post("/run_all")
    def run_all():
        body = request.get_json(force=True, silent=True) or {}
        item = body.get("item")
        if not item:
            return jsonify({"detail": "item is required"}), 400
        settings = get_settings()
        sp, pp = _seg_params(body, settings), _patch_params(body, settings)
        encoder = body.get("encoder") or settings.image_encoder
        sh = _seg_h(sp, settings)
        ph = patch_hash(sh, pp["mag"], pp["patch_size"], pp["overlap"], settings.index_version,
                        settings.impl)
        fh = feat_hash(ph, encoder, settings.feat_version, settings.impl)
        seg_sink = seg_paths(settings.artifact_cache, item, sh)
        patch_sink = patch_paths(settings.artifact_cache, item, ph)
        feat_sink = feat_paths(settings.artifact_cache, item, fh)
        token = body.get("girder_token")

        def job(report):
            slide_path = _resolve(item, token, settings)
            if seg_sink["contours"].exists():
                report("segmentation", 1.0)
            else:
                run_segmentation(
                    slide_path, sp, seg_sink, use_trident=settings.use_trident, on_stage=report,
                )
            if patch_sink["coords"].exists():
                report("patching", 1.0)
            else:
                run_patching(
                    slide_path, pp, seg_sink, patch_sink,
                    use_trident=settings.use_trident, on_stage=report,
                )
            res = run_features(
                slide_path, {"encoder": encoder}, patch_sink, feat_sink,
                use_trident=settings.use_trident, on_stage=report, batch_limit=settings.batch_limit,
            )
            return {
                "n_patches": res.n_patches, "dim": res.dim, "encoder": res.encoder,
                "features_ref": res.features_ref,
                "seg_hash": sh, "patch_hash": ph, "feat_hash": fh,
            }

        job_id = app.config["QUEUE"].submit(job)
        return jsonify({
            "job_id": job_id, "seg_hash": sh, "patch_hash": ph, "feat_hash": fh,
            "kind": "run_all", "encoder": encoder, "status": "queued", **sp, **pp,
        }), 202

    # ── Stage 4: downstream task inference (Inc 2c) ─────────────────────────────────
    @app.get("/tasks")
    def tasks():
        """The task registry. Served by BOTH images — the panel can show the task card even
        where /predict would 503, so a CPU deployment explains itself instead of looking broken."""
        return jsonify({"tasks": list_tasks(), "available": torch_available()})

    @app.post("/predict")
    def predict():
        body = request.get_json(force=True, silent=True) or {}
        item, fh, task_id = body.get("item"), body.get("feat_hash"), body.get("task_id")
        if not item or not fh or not task_id:
            return jsonify({"detail": "item, feat_hash and task_id are required"}), 400
        task = get_task(task_id)
        if task is None:
            return jsonify({"detail": f"unknown task '{task_id}'", "task_id": task_id}), 404
        if not torch_available():
            return jsonify({
                "detail": "this preprocess image ships without torch; bring the service up with "
                          "the trident override to run downstream tasks",
                "task_id": task_id, "reason": "no_torch",
            }), 503

        settings = get_settings()
        features_path = feat_paths(settings.artifact_cache, item, fh)["features"]
        if not features_path.exists():
            return jsonify({
                "detail": "extract features for this slide first (no feature index for that "
                          "feat_hash)",
                "feat_hash": fh,
            }), 409

        prh = pred_hash(fh, task.id, task.model_ver)
        pred_sink = pred_paths(settings.artifact_cache, item, prh)
        weights_root = settings.mil_weights

        def job(report):
            report("predicting", 0.1)
            # Content-addressed: an identical (features, task, weights) triple has one answer, so a
            # cached document is served straight back instead of re-running.
            if pred_sink["prediction"].exists():
                doc = json.loads(pred_sink["prediction"].read_text())
            else:
                res = app.config["PREDICT"](task, features_path, weights_root)
                doc = res.document()
                pred_sink["dir"].mkdir(parents=True, exist_ok=True)
                pred_sink["prediction"].write_text(json.dumps(doc))
            report("predicting", 1.0)
            return {
                **{k: v for k, v in doc.items() if k not in ("coords", "attention", "evidence")},
                "pred_hash": prh, "feat_hash": fh,
                "prediction_ref": str(pred_sink["prediction"]),
            }

        job_id = app.config["QUEUE"].submit(job)
        return jsonify({
            "job_id": job_id, "pred_hash": prh, "feat_hash": fh, "kind": "prediction",
            "task_id": task.id, "model_ver": task.model_ver, "status": "queued",
        }), 202

    @app.get("/prediction")
    def prediction():
        """Serve a prediction's per-patch arrays (level-0 coords + attention + evidence)."""
        item, prh = request.args.get("item"), request.args.get("pred_hash")
        if not item or not prh:
            return jsonify({"detail": "item and pred_hash are required"}), 400
        settings = get_settings()
        path = pred_paths(settings.artifact_cache, item, prh)["prediction"]
        if not path.exists():
            return jsonify({"detail": "no prediction for that pred_hash", "pred_hash": prh}), 404
        return jsonify(json.loads(path.read_text()))

    # ── Legacy flat single-shot index (kept for back-compat) ────────────────────────
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
            params["segmenter"], settings.index_version, settings.impl,
        )
        sink = cache_paths(settings.artifact_cache, item, phash)
        token = body.get("girder_token")

        def job(report):
            slide_path = _resolve(item, token, settings)
            res = app.config["PIPELINE"](
                slide_path, params, sink, use_trident=settings.use_trident, on_stage=report,
                batch_limit=settings.batch_limit,
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

    @app.get("/contours")
    def contours():
        """Serve a segmentation's tissue contours (level-0 px GeoJSON) for the viewer overlay."""
        item, sh = request.args.get("item"), request.args.get("seg_hash")
        if not item or not sh:
            return jsonify({"detail": "item and seg_hash are required"}), 400
        settings = get_settings()
        path = seg_paths(settings.artifact_cache, item, sh)["contours"]
        if not path.exists():
            return jsonify({"detail": "no segmentation for that seg_hash", "seg_hash": sh}), 404
        import json
        return jsonify(json.loads(path.read_text()))

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
        # Prefer the DAG feat artifact; fall back to the legacy flat params_hash index.
        fh = body.get("feat_hash")
        if fh:
            features_path = feat_paths(settings.artifact_cache, item, fh)["features"]
        else:
            mag = int(body.get("mag") or settings.default_mag)
            patch_size = int(body.get("patch_size") or settings.default_patch_size)
            segmenter = body.get("segmenter") or settings.default_segmenter
            phash = params_hash(encoder, mag, patch_size, segmenter, settings.index_version,
                                settings.impl)
            features_path = cache_paths(settings.artifact_cache, item, phash)["features"]
        if not features_path.exists():
            return jsonify({
                "detail": "this slide isn't preprocessed for text search yet",
                "feat_hash": fh,
            }), 404
        regions = app.config["FIND_REGIONS"](
            features_path, query, int(body.get("k") or 8), encoder,
            use_trident=settings.use_trident,
        )
        top = regions[0]["score"] if regions else 0.0
        return jsonify({
            "regions": regions, "top_score": top, "encoder": encoder,
            "n_candidates": len(regions), "query": query,
        })

    return app
