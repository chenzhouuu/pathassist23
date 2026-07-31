"""The tissue map's HTTP surface: enqueue a job, poll it, serve tiles (Inc 4, design §6).

Everything expensive is reached through ``app.config`` seams so the whole surface is testable with
a Flask test client and no GPU, no weights and no slide:

    OPEN_SLIDE(girder_base, slide_ref, token, slides_root) -> (SlideHandle, reader)
    PREDICT(rgb)                                           -> [C, out, out] float32
    TISSUE_TILES(item, seg_hash, width, height, core)      -> [(tx, ty), ...]
    CONTOURS(item, seg_hash)                               -> geojson | None
"""

import logging
from pathlib import Path

import numpy as np
from flask import Response, jsonify, request

from .artifacts import (
    CORE,
    TILE,
    Coverage,
    art_hash,
    artifact_dir,
    meta_path,
    read_json,
    summary_path,
)
from .classes import BACKGROUND_INDEX, catalog, get_backend
from .config import get_settings
from .pyramid import read_class_tile, read_prob_tile
from .tiles import (
    TRANSPARENT_TILE,
    BadClassSpec,
    colourise_classes,
    composite_probs,
    encode_png,
    max_prob,
    outline_classes,
    parse_channels,
    parse_show,
)
from .wholeslide import SlideInfo, run_region

logger = logging.getLogger(__name__)

# A tile is immutable for a given (art_hash, coverage revision, query).
_TILE_CACHE = "public, max-age=86400"


def _png(body: bytes, rev: int = 0) -> Response:
    resp = Response(body, mimetype="image/png")
    resp.headers["Cache-Control"] = _TILE_CACHE
    resp.headers["ETag"] = f'W/"{rev}"'
    return resp


def register(app) -> None:  # noqa: C901 — a flat route table reads better than split helpers
    @app.get("/tissue/catalog")
    def tissue_catalog():
        doc = catalog()
        doc["core"] = CORE
        doc["tile"] = TILE
        return jsonify(doc)

    @app.post("/tissue")
    def enqueue():
        body = request.get_json(force=True, silent=True) or {}
        slide_ref = body.get("slide_ref")
        seg_hash = body.get("seg_hash")
        bbox = body.get("bbox")
        if not slide_ref or not seg_hash:
            return jsonify({"detail": "slide_ref and seg_hash are required"}), 400
        if bbox is not None and not isinstance(bbox, dict):
            return jsonify({"detail": "bbox must be an object or null (null = whole slide)"}), 400
        try:
            backend = get_backend(body.get("backend"))
        except KeyError as exc:
            return jsonify({"detail": str(exc)}), 400

        if app.config.get("PREDICT") is None:
            return jsonify({
                "detail": f"tissue segmentation needs the GPU worker "
                          f"({backend.weights_file} not loaded)",
            }), 503

        s = get_settings()
        # A whole slide is hundreds of cores and hundreds of MB. Filling the cache volume mid-job
        # leaves a half-written pyramid that renders as holes, so refuse up front and say the
        # number — a region job is small enough to let through.
        if bbox is None:
            free = _free_gb(s.cache_root)
            if free is not None and free < s.min_free_gb:
                return jsonify({
                    "detail": f"only {free:.1f} GB free on the tissue cache; a whole-slide map "
                              f"needs at least {s.min_free_gb:.0f} GB (a region job is fine)",
                }), 507

        ah = art_hash(seg_hash=seg_hash, backend=backend.name, store_mpp=s.store_mpp,
                      overlap=s.overlap)
        token = body.get("girder_token")

        def work(report):
            handle, reader = app.config["OPEN_SLIDE"](
                girder_base=s.girder_base, slide_ref=slide_ref, token=token,
                slides_root=s.slides_root,
            )
            tissue = app.config["TISSUE_TILES"](
                item=slide_ref, seg_hash=seg_hash,
                width=handle.width, height=handle.height, core=CORE,
            )
            if bbox is None and not tissue:
                raise RuntimeError(
                    "whole-slide analysis needs a ready tissue segmentation for this slide"
                )
            return run_region(
                root=artifact_dir(s.cache_root, slide_ref, ah), art=ah, backend=backend,
                slide=SlideInfo(handle.width, handle.height, handle.mpp),
                bbox=bbox, tissue_tiles=tissue,
                contours=app.config["CONTOURS"](item=slide_ref, seg_hash=seg_hash),
                read_window=reader, predict=app.config["PREDICT"],
                store_mpp=s.store_mpp, overlap=s.overlap, report=report,
            )

        job_id = app.config["JOBS"].submit(work)
        return jsonify({
            "art_hash": ah, "job_id": job_id, "status": "queued",
            "backend": backend.name,
            "scope": "slide" if bbox is None else "region",
        })

    @app.get("/tissue/status/<job_id>")
    def job_status(job_id: str):
        st = app.config["JOBS"].status(job_id)
        if st is None:
            return jsonify({"detail": "unknown job"}), 404
        return jsonify(st)

    @app.get("/tissue/<item>/<ahash>/meta")
    def artifact_meta(item: str, ahash: str):
        root = _root(item, ahash)
        meta = read_json(meta_path(root))
        if meta is None:
            return jsonify({"detail": "no tissue artifact for that hash"}), 404
        cov = Coverage.load(root)
        meta["coverage"] = {"core": cov.core, "n_tiles": len(cov.done),
                            "bounds": cov.bounds(), "done": sorted(cov.done)}
        meta["summary"] = read_json(summary_path(root)) or {}
        return jsonify(meta)

    @app.get("/tissue/<item>/<ahash>/tile/<layer>/<int:z>/<int:x>/<int:y>.png")
    def tile(item: str, ahash: str, layer: str, z: int, x: int, y: int):
        root = _root(item, ahash)
        meta = read_json(meta_path(root)) or {}
        rev = len(Coverage.load(root).done)
        try:
            backend = get_backend(meta.get("backend"))
        except KeyError:
            return jsonify({"detail": "artifact names a backend this service does not have"}), 400

        try:
            show = parse_show(request.args.get("show"), backend)
        except BadClassSpec as exc:
            return jsonify({"detail": str(exc)}), 400
        alpha = _f(request.args.get("alpha"), 1.0)

        if layer in ("classes", "outline"):
            idx = read_class_tile(root, z, x, y)
            if idx is None:
                return _png(TRANSPARENT_TILE, rev)
            if layer == "outline":
                rgba = outline_classes(idx, backend, show=show, alpha=alpha,
                                       width=int(_f(request.args.get("width"), 2)))
            else:
                conf = None
                if request.args.get("conf", "1") not in ("0", "false", "no"):
                    conf = max_prob(read_prob_tile(root, z, x, y, list(backend.classes)), backend)
                rgba = colourise_classes(idx, backend, show=show, alpha=alpha, conf=conf,
                                         conf_floor=_f(request.args.get("conf_floor"), 0.2))
            return _png(encode_png(rgba), rev)

        if layer == "probs":
            try:
                channels = parse_channels(request.args.get("ch", ""), backend)
            except BadClassSpec as exc:
                return jsonify({"detail": str(exc)}), 400
            if show is not None:
                channels = [c for c in channels if c[0] in set(show)]
            if not channels:
                return _png(TRANSPARENT_TILE, rev)
            planes = read_prob_tile(root, z, x, y, [n for n, _ in channels])
            if not planes:
                return _png(TRANSPARENT_TILE, rev)
            rgba = composite_probs(
                planes, channels,
                lo=_f(request.args.get("lo"), 0.0),
                hi=_f(request.args.get("hi"), 1.0),
                gamma=_f(request.args.get("gamma"), 1.0),
                alpha=alpha,
            )
            return _png(encode_png(rgba), rev)

        return jsonify({"detail": f"unknown layer {layer!r}"}), 400

    @app.get("/tissue/<item>/<ahash>/stats")
    def stats(item: str, ahash: str):
        """Class composition for a sub-rectangle, or the whole artifact when no bbox is given."""
        root = _root(item, ahash)
        meta = read_json(meta_path(root))
        if meta is None:
            return jsonify({"detail": "no tissue artifact for that hash"}), 404
        raw = request.args.get("bbox")
        if not raw:
            return jsonify({"scope": "artifact", **(read_json(summary_path(root)) or {})})
        try:
            bx, by, bw, bh = (int(float(v)) for v in raw.split(","))
        except (TypeError, ValueError):
            return jsonify({"detail": "bbox must be 'x,y,width,height' in slide pixels"}), 400
        backend = get_backend(meta.get("backend"))
        s = 1 << int(meta.get("layers", {}).get("classes", {}).get("level_offset", 0))
        counts = _count_region(root, backend, bx // s, by // s, bw // s, bh // s)
        total = max(1, sum(counts.values()))
        px_mm = float(meta.get("store_mpp", 1.0)) / 1000.0
        return jsonify({
            "scope": "region", "bbox": {"x": bx, "y": by, "width": bw, "height": bh},
            "pixels": counts,
            "fraction": {k: round(v / total, 4) for k, v in counts.items()},
            "tissue_px": total, "area_mm2": round(total * px_mm * px_mm, 4),
            "backend": backend.name,
        })


def _count_region(root: Path, backend, sx: int, sy: int, sw: int, sh: int) -> dict[str, int]:
    """Per-class pixel counts over a stored-resolution rectangle, read from level-0 tiles."""
    counts = {c: 0 for c in backend.classes}
    for ty in range(sy // TILE, (sy + max(1, sh) - 1) // TILE + 1):
        for tx in range(sx // TILE, (sx + max(1, sw) - 1) // TILE + 1):
            idx = read_class_tile(root, 0, tx, ty)
            if idx is None:
                continue
            x0 = max(0, sx - tx * TILE)
            y0 = max(0, sy - ty * TILE)
            x1 = min(TILE, sx + sw - tx * TILE)
            y1 = min(TILE, sy + sh - ty * TILE)
            if x1 <= x0 or y1 <= y0:
                continue
            sub = idx[y0:y1, x0:x1]
            for i, name in enumerate(backend.classes, start=1):
                counts[name] += int(np.count_nonzero(sub == i))
    return counts


def _free_gb(path: str) -> float | None:
    """Free space on the cache volume, or None when it cannot be determined (never a refusal)."""
    import shutil

    try:
        Path(path).mkdir(parents=True, exist_ok=True)
        return shutil.disk_usage(path).free / (1024 ** 3)
    except OSError:
        return None


def _root(item: str, ahash: str) -> Path:
    return artifact_dir(get_settings().cache_root, item, ahash)


def _f(v: str | None, default: float) -> float:
    try:
        return float(v) if v is not None else default
    except (TypeError, ValueError):
        return default


__all__ = ["register", "BACKGROUND_INDEX"]
