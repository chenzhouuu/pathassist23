"""The nuclei artifact's HTTP surface: enqueue a job, poll it, read it back, serve its tiles.

Registered beside the existing `/segment`, which is unchanged — that route is the agent's
stateless "what is in this box" call and keeps working exactly as it did. What is new is the
artifact control plane: a job that stores rings on disk, addressed by a content hash, which the
Workspace lists and the viewer draws (Inc 5, tickets 05 and 06).

Everything expensive is reached through `app.config` seams, so the whole surface is testable with a
Flask test client and no GPU, no weights and no slide:

    READ_REGION(girder_base, slide_ref, bbox, token) -> RegionImage
    SLIDE_INFO(girder_base, slide_ref, token)        -> (width, height, mpp)
    SEGMENT(pixels, mpp)                             -> (points, classes, contours)
"""

import logging
import shutil
from pathlib import Path

from flask import Response, jsonify, request

from .artifacts import (
    CORE,
    Coverage,
    art_hash,
    artifact_dir,
    cells_path,
    meta_path,
    read_cells,
    read_json,
    summary_path,
)
from .config import get_settings
from .nuclei import SlideInfo, run_region, summary_from_coverage
from .pannuke import name_for
from .pyramid import read_class_tile, read_cover_tile, read_instance_tile
from .tiles import (
    TRANSPARENT_TILE,
    BadClassSpec,
    colourise,
    colourise_instances,
    encode_png,
    parse_colors,
    parse_show,
)

logger = logging.getLogger(__name__)

# A tile is immutable for a given (art_hash, coverage revision, query).
_TILE_CACHE = "public, max-age=86400"


def _png(body: bytes, rev: int = 0) -> Response:
    resp = Response(body, mimetype="image/png")
    resp.headers["Cache-Control"] = _TILE_CACHE
    resp.headers["ETag"] = f'W/"{rev}"'
    return resp


def _f(raw: str | None, default: float) -> float:
    try:
        return float(raw) if raw is not None else default
    except (TypeError, ValueError):
        return default

# The only backend today. Named rather than implied so the artifact hash, the meta and the panel
# all say which model produced a nucleus, and a future decoder can coexist instead of invalidating
# what is already stored.
DEFAULT_BACKEND = "cellvit-sam-h"


def register(app) -> None:
    @app.post("/nuclei")
    def enqueue_nuclei():
        """Start (or extend) a slide's nuclei artifact.

        ``bbox`` is a rectangle for a region run and ``null`` for the whole slide — the same route,
        the same pipeline, the same artifact, differing only in which cores are enumerated (the
        shape Inc 3b settled on and Inc 4 inherited). A whole-slide run additionally needs a
        ``seg_hash``, because running every core of a slide that is mostly glass is hours of the
        only GPU worker spent finding nothing.
        """
        body = request.get_json(force=True, silent=True) or {}
        slide_ref = body.get("slide_ref")
        bbox = body.get("bbox")
        seg_hash = body.get("seg_hash")
        if not slide_ref:
            return jsonify({"detail": "slide_ref is required"}), 400
        if bbox is not None and not isinstance(bbox, dict):
            return jsonify({
                "detail": "bbox must be an object or null (null = whole slide)",
            }), 400

        s = get_settings()
        if app.config.get("SEGMENT") is None:
            return jsonify({"detail": "nuclei segmentation needs the GPU worker"}), 503
        if bbox is None:
            if not seg_hash:
                return jsonify({
                    "detail": "a whole-slide run needs seg_hash — segment the slide first so the "
                              "job knows which tiles hold tissue",
                }), 400
            free = _free_gb(s.artifact_cache)
            if free is not None and free < s.min_free_gb:
                return jsonify({
                    "detail": f"only {free:.1f} GB free on the nuclei cache; a whole-slide run "
                              f"needs at least {s.min_free_gb:.0f} GB (a region run is fine)",
                }), 507

        backend = DEFAULT_BACKEND if s.model == "cellvit" else "stub"
        ah = art_hash(backend=backend)
        token = body.get("girder_token")

        def work(report):
            width, height, mpp = app.config["SLIDE_INFO"](
                girder_base=s.girder_base, slide_ref=slide_ref, token=token,
            )
            tiles = None
            if bbox is None:
                tiles = app.config["TISSUE_TILES"](
                    item=slide_ref, seg_hash=seg_hash, width=width, height=height, core=CORE,
                )
                if not tiles:
                    raise RuntimeError(
                        "a whole-slide run needs a ready tissue segmentation for this slide"
                    )

            def read(window):
                return app.config["READ_REGION"](
                    girder_base=s.girder_base, slide_ref=slide_ref, bbox=window, token=token,
                )

            return run_region(
                root=artifact_dir(s.artifact_cache, slide_ref, ah), art=ah,
                slide=SlideInfo(width, height, mpp),
                bbox=bbox, tiles=tiles,
                read_region=read, segment=app.config["SEGMENT"], backend=backend,
                report=report, should_stop=getattr(report, "stopping", None),
            )

        job_id = app.config["JOBS"].submit(work)
        return jsonify({
            "art_hash": ah, "job_id": job_id, "status": "queued",
            "backend": backend, "scope": "region" if bbox is not None else "slide",
        })

    @app.post("/nuclei/hash")
    def nuclei_artifact_hash():
        """The `art_hash` a nuclei run on this box would produce. Enqueues nothing.

        Copied in shape from the preprocess service's `POST /hash` (`preprocess_service/app.py`),
        and for its reason: since Inc 6 · 05 the gateway has to know the content address *before*
        it dispatches, because a dispatched run goes onto a Celery queue and never comes back
        through the gateway. Computing the hash there would put a second copy of
        `artifacts.art_hash` in the tree, free to drift from this one — which is exactly how
        `conch_v1` came to mean two different embeddings.

        `backend` is the other half of why the answer has to come from the service: which model
        this box actually has is a deployment fact, and it is in the hash.
        """
        s = get_settings()
        backend = DEFAULT_BACKEND if s.model == "cellvit" else "stub"
        return jsonify({
            "kind": "nuclei", "art_hash": art_hash(backend=backend), "backend": backend,
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
        # Both halves of this answer come from the same file, and therefore the same atomic write:
        # the counts always describe exactly the tiles listed beside them, including halfway
        # through a running job. summary.json is written only at the end, so reading it here would
        # pair a live tile list with stale counts.
        meta["summary"] = (
            summary_from_coverage(cov, (meta.get("slide") or {}).get("mpp"))
            if cov.totals is not None else (read_json(summary_path(root)) or {})
        )
        return jsonify(meta)

    @app.get("/nuclei/<item>/<ahash>/cells")
    def nuclei_cells(item: str, ahash: str):
        """The nuclei inside a level-0 rectangle, read back from the artifact (Inc 5, ticket 09).

        The shape another service can consume: centroids in level-0 slide pixels, PanNuke class
        names, per-nucleus rings and the artifact's own instance ids. Deliberately the same fields
        `/segment` returns, so a consumer switching from segmenting-again to reading-what-is-stored
        changes where it asks and not what it does with the answer.

        Ownership is by centroid, so a nucleus is returned by exactly one core and asking for a
        window that spans several cannot double-count. A window is not clipped to the cores it
        touches: a cell whose centroid is inside is returned whole, ring and all.
        """
        root = _root(item, ahash)
        if not meta_path(root).is_file():
            return jsonify({"detail": "no nuclei artifact for that hash"}), 404
        try:
            box = _bbox(request.args.get("bbox"))
        except ValueError as exc:
            return jsonify({"detail": str(exc)}), 400

        cov = Coverage.load(root)
        centroids: list[list[float]] = []
        classes: list[str] = []
        contours: list[list[list[float]]] = []
        inst: list[int] = []
        for tx, ty in sorted(cov.done):
            if not _core_meets(tx, ty, cov.core, box):
                continue
            cells = read_cells(cells_path(root, tx, ty))
            if cells is None:
                continue
            for i, (cx, cy) in enumerate(cells["xy"].tolist()):
                if not (box[0] <= cx < box[0] + box[2] and box[1] <= cy < box[1] + box[3]):
                    continue
                centroids.append([float(cx), float(cy)])
                classes.append(name_for(int(cells["cls"][i])))
                contours.append(cells["rings"][i])
                inst.append(int(cells["inst"][i]))
        return jsonify({
            "count": len(centroids), "centroids": centroids, "classes": classes,
            "contours": contours, "instances": inst,
            "covered": all(_core_covered(tx, ty, cov) for tx, ty in _cores_of(box, cov.core)),
        })

    @app.get("/nuclei/<item>/<ahash>/tile/<layer>/<int:z>/<int:x>/<int:y>.png")
    def nuclei_tile(item: str, ahash: str, layer: str, z: int, x: int, y: int):
        """One rendered tile of the nuclei mask.

        Colours, class selection and opacity are query parameters, so changing any of them is a
        URL change rather than a rebuild — the picture on disk is just an index and a coverage
        fraction (tiles.py).
        """
        if layer not in ("classes", "instances"):
            return jsonify({"detail": f"unknown layer {layer!r}"}), 400
        root = _root(item, ahash)
        rev = len(Coverage.load(root).done)
        alpha = _f(request.args.get("alpha"), 1.0)

        if layer == "instances":
            ids = read_instance_tile(root, z, x, y)
            if ids is None:
                return _png(TRANSPARENT_TILE, rev)
            # `raw=1` serves the stored packing byte for byte — the form a future picker reads to
            # turn a click into a nucleus. Without it the ids are scrambled into distinguishable
            # colours, which is the only way a field of consecutive ids reads as separate cells.
            raw = request.args.get("raw") in ("1", "true", "yes")
            rgba = colourise_instances(ids, read_cover_tile(root, z, x, y), alpha=alpha, raw=raw)
            return _png(encode_png(rgba), rev)

        try:
            show = parse_show(request.args.get("show"))
            colors = parse_colors(request.args.get("ch"))
        except BadClassSpec as exc:
            return jsonify({"detail": str(exc)}), 400

        idx = read_class_tile(root, z, x, y)
        if idx is None:
            return _png(TRANSPARENT_TILE, rev)
        rgba = colourise(idx, read_cover_tile(root, z, x, y), show=show, alpha=alpha,
                         colors=colors)
        return _png(encode_png(rgba), rev)

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


def _bbox(spec: str | None) -> tuple[int, int, int, int]:
    """``"x,y,w,h"`` → ints. Required: a consumer that forgot it would silently get the whole
    slide's nuclei, which on a built-out artifact is millions of polygons."""
    if not spec:
        raise ValueError("bbox=x,y,width,height is required")
    try:
        x, y, w, h = (int(float(v)) for v in spec.split(","))
    except ValueError as exc:
        raise ValueError(f"bbox must be four numbers, got {spec!r}") from exc
    if w <= 0 or h <= 0:
        raise ValueError("bbox width and height must be positive")
    return x, y, w, h


def _cores_of(box: tuple[int, int, int, int], core: int) -> list[tuple[int, int]]:
    x, y, w, h = box
    return [(tx, ty)
            for ty in range(y // core, (y + h - 1) // core + 1)
            for tx in range(x // core, (x + w - 1) // core + 1)]


def _core_meets(tx: int, ty: int, core: int, box: tuple[int, int, int, int]) -> bool:
    x, y, w, h = box
    return tx * core < x + w and (tx + 1) * core > x and ty * core < y + h and (ty + 1) * core > y


def _core_covered(tx: int, ty: int, cov: Coverage) -> bool:
    return cov.has(tx, ty)


def _free_gb(path: Path | str) -> float | None:
    """Free space on the cache volume, or None when it cannot be determined (never a refusal)."""
    try:
        Path(path).mkdir(parents=True, exist_ok=True)
        return shutil.disk_usage(path).free / (1024 ** 3)
    except OSError:
        return None


def _dir_bytes(root: Path) -> int:
    """Bytes on disk under `root`, or 0 if it is not there."""
    if not root.is_dir():
        return 0
    return sum(f.stat().st_size for f in root.rglob("*") if f.is_file())


__all__ = ["register", "DEFAULT_BACKEND"]
