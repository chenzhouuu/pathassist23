"""The map's HTTP surface: enqueue a job, poll it, serve tiles (Inc 3b, design §6).

Everything expensive is reached through ``app.config`` seams so the whole surface is testable
with a Flask test client and no GPU, no CellViT and no slide:

    OPEN_SLIDE(girder_base, slide_ref, token, slides_root) -> (SlideHandle, reader)
    TILE_PREDICT(rgb)                                      -> [C, h, w] float32
    FETCH_NUCLEI_FACTORY(slide_ref, token)                 -> fetch_nuclei(bbox)
    TISSUE_TILES(item, seg_hash, width, height, core)      -> [(tx, ty), ...]
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
    read_json,
    summary_path,
)
from .config import get_settings
from .markers import (
    DAPI_COLOR,
    DAPI_DEFAULT_ALPHA,
    EQUIVALENTS,
    MARKER_CHANNELS,
    PHENOTYPE_COLORS,
    PHENOTYPE_ORDER,
    PRESETS,
)
from .pyramid import read_marker_tile, read_pheno_tile
from .tiles import (
    TRANSPARENT_TILE,
    BadChannelSpec,
    colourise_pheno,
    composite,
    encode_png,
    parse_channels,
)
from .wholeslide import SlideInfo, run_region

logger = logging.getLogger(__name__)

# Tiles are immutable for a given (art_hash, threshold_rev, query) — the browser and any proxy may
# hold them for a long time. A coverage change bumps the ETag via the revision in the header.
_TILE_CACHE = "public, max-age=86400"


def _png(body: bytes, rev: int = 0) -> Response:
    resp = Response(body, mimetype="image/png")
    resp.headers["Cache-Control"] = _TILE_CACHE
    resp.headers["ETag"] = f'W/"{rev}"'
    return resp


def register(app) -> None:  # noqa: C901 — a flat route table reads better than split helpers
    @app.get("/biomarker/catalog")
    def catalog():
        """Everything the panel needs to render its controls without hardcoding biology."""
        return jsonify({
            "presets": {k: [{"marker": m, "color": c} for m, c in v] for k, v in PRESETS.items()},
            "markers": MARKER_CHANNELS,
            "equivalents": EQUIVALENTS,
            "phenotypes": PHENOTYPE_ORDER,
            "phenotype_colors": PHENOTYPE_COLORS,
            "dapi_color": DAPI_COLOR,
            "core": CORE,
        })

    @app.post("/biomarker")
    def enqueue():
        body = request.get_json(force=True, silent=True) or {}
        slide_ref = body.get("slide_ref")
        seg_hash = body.get("seg_hash")
        bbox = body.get("bbox")
        if not slide_ref or not seg_hash:
            return jsonify({"detail": "slide_ref and seg_hash are required"}), 400
        if bbox is not None and not isinstance(bbox, dict):
            return jsonify({"detail": "bbox must be an object or null (null = whole slide)"}), 400

        # A phenotype is an attribute *of a nucleus*, so the nuclei have to exist before there is
        # anything to attribute it to. Refusing here, by name, is the same precondition shape the
        # patching and feature stages already use — and it is what stops a map job from paying for
        # a second whole-slide segmentation of cells that are already stored (Inc 5, D9).
        nuclei_hash = body.get("nuclei_hash")
        if not nuclei_hash:
            return jsonify({
                "detail": "this needs a nuclei artifact — segment the slide's nuclei first, then "
                          "the phenotype map is built on those cells rather than finding them "
                          "again",
            }), 400

        if app.config.get("TILE_PREDICT") is None:
            return jsonify({
                "detail": "biomarker analysis needs the GPU worker (GigaTIME-Flash weights)",
            }), 503

        s = get_settings()
        # The nuclei artifact is part of the identity, not just the provenance: different cells
        # give different phenotypes for the same pixels, so two maps built on two nuclei artifacts
        # are two different artifacts.
        ah = art_hash(
            seg_hash=seg_hash, marker_mpp=s.marker_mpp, pheno_mpp=s.pheno_mpp,
            nucleus_radius_um=s.nucleus_radius_um, nuclei_hash=nuclei_hash,
        )
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
                # Analysing a whole slide with no tissue mask would spend hours on background.
                raise RuntimeError(
                    "whole-slide analysis needs a ready tissue segmentation for this slide"
                )
            return run_region(
                root=artifact_dir(s.cache_root, slide_ref, ah), art=ah,
                slide=SlideInfo(handle.width, handle.height, handle.mpp),
                bbox=bbox, tissue_tiles=tissue,
                read_window=reader, tile_predict=app.config["TILE_PREDICT"],
                fetch_nuclei=app.config["FETCH_NUCLEI_FACTORY"](slide_ref, token, nuclei_hash),
                nucleus_radius_um=s.nucleus_radius_um, report=report,
                should_stop=getattr(report, "stopping", None),
            )

        job_id = app.config["JOBS"].submit(work)
        return jsonify({
            "art_hash": ah, "job_id": job_id, "status": "queued",
            "scope": "slide" if bbox is None else "region",
            "nuclei_hash": nuclei_hash,
        })

    @app.post("/biomarker/hash")
    def biomarker_artifact_hash():
        """The `art_hash` a marker map with these inputs would produce. Enqueues nothing.

        The same shape as the cellvit service's `POST /nuclei/hash` and the preprocess service's
        `POST /hash`, and for the same reason (Inc 6 · 05): since a run is dispatched onto a Celery
        queue and never comes back through the gateway, the gateway needs the content address
        *before* it dispatches. Computing it there would put a second copy of `artifacts.art_hash`
        in the tree, free to drift from this one — which is how `conch_v1` came to mean two
        different embeddings.

        The store resolutions and the nucleus radius are deployment settings and they are in the
        hash, which is the other half of why only this service can answer.
        """
        body = request.get_json(force=True, silent=True) or {}
        seg_hash = body.get("seg_hash")
        nuclei_hash = body.get("nuclei_hash")
        if not seg_hash or not nuclei_hash:
            return jsonify({"detail": "seg_hash and nuclei_hash are required"}), 400
        s = get_settings()
        return jsonify({
            "kind": "biomarker",
            "art_hash": art_hash(
                seg_hash=seg_hash, marker_mpp=s.marker_mpp, pheno_mpp=s.pheno_mpp,
                nucleus_radius_um=s.nucleus_radius_um, nuclei_hash=nuclei_hash,
            ),
            "nuclei_hash": nuclei_hash,
        })

    @app.get("/biomarker/status/<job_id>")
    def job_status(job_id: str):
        st = app.config["JOBS"].status(job_id)
        if st is None:
            return jsonify({"detail": "unknown job"}), 404
        return jsonify(st)

    @app.post("/biomarker/cancel/<job_id>")
    def job_cancel(job_id: str):
        """Ask a job to stop at its next core-tile boundary.

        Returns immediately with the job's *current* status — a running job is still running until
        it finishes the core it is on. Whatever it has already computed stays on disk and
        re-running the same request resumes from there.
        """
        st = app.config["JOBS"].cancel(job_id)
        if st is None:
            return jsonify({"detail": "unknown job"}), 404
        return jsonify(st)

    @app.get("/biomarker/<item>/<ahash>/meta")
    def artifact_meta(item: str, ahash: str):
        root = _root(item, ahash)
        meta = read_json(meta_path(root))
        if meta is None:
            return jsonify({"detail": "no biomarker artifact for that hash"}), 404
        cov = Coverage.load(root)
        meta["coverage"] = {"core": cov.core, "n_tiles": len(cov.done),
                            "bounds": cov.bounds(), "done": sorted(cov.done)}
        meta["summary"] = read_json(summary_path(root)) or {}
        return jsonify(meta)

    @app.delete("/biomarker/<item>/<ahash>")
    def delete_artifact(item: str, ahash: str):
        """Remove an artifact's whole directory (Inc 5, ticket 04).

        **Idempotent**: a directory that is already gone is a 204, not a 404. The gateway deletes
        the durable row first and this second, so a retry after a crash between the two must be
        able to finish the job rather than report a failure that has already happened.

        Only the gateway ever calls this, and only after it has established that nothing's
        ``parent_hash`` points here — this service has no view of the DAG and does not check.
        """
        try:
            root = _root(item, ahash)
        except ValueError as exc:                # a path segment that could escape the cache root
            return jsonify({"detail": str(exc)}), 400
        if root.is_dir():
            shutil.rmtree(root)
        return "", 204

    @app.get("/biomarker/<item>/<ahash>/usage")
    def usage(item: str, ahash: str):
        """What this artifact costs on disk, for the confirm dialog. 0 for one already gone."""
        try:
            root = _root(item, ahash)
        except ValueError as exc:
            return jsonify({"detail": str(exc)}), 400
        return jsonify({"bytes": _dir_bytes(root)})

    @app.get("/biomarker/<item>/<ahash>/tile/<layer>/<int:z>/<int:x>/<int:y>.png")
    def tile(item: str, ahash: str, layer: str, z: int, x: int, y: int):
        root = _root(item, ahash)
        rev = int((read_json(meta_path(root)) or {}).get("threshold_rev", 0))
        if layer == "markers":
            try:
                channels = parse_channels(request.args.get("ch", ""))
            except BadChannelSpec as exc:
                return jsonify({"detail": str(exc)}), 400
            dapi = request.args.get("dapi")
            if dapi:
                colour, _, weight = dapi.partition(":")
                try:
                    ch = parse_channels(f"DAPI:{colour or DAPI_COLOR}")
                except BadChannelSpec as exc:
                    return jsonify({"detail": str(exc)}), 400
                # DAPI is a *structural underlay*, not a marker: it is near-saturated across all
                # tissue, so at full weight it greys out every coloured channel painted over it.
                # The weight is folded into the colour, which is exactly equivalent under the
                # additive composite (v * colour) and needs no extra compositing parameter.
                w = _f(weight, DAPI_DEFAULT_ALPHA)
                channels = channels + [(n, tuple(int(c * w) for c in col)) for n, col in ch]
            if not channels:
                return _png(TRANSPARENT_TILE, rev)
            planes = read_marker_tile(root, z, x, y, [n for n, _ in channels])
            if not planes:
                return _png(TRANSPARENT_TILE, rev)
            rgba = composite(
                planes, channels,
                lo=_f(request.args.get("lo"), 0.15),
                hi=_f(request.args.get("hi"), 0.95),
                gamma=_f(request.args.get("gamma"), 0.8),
            )
            return _png(encode_png(rgba), rev)

        if layer == "pheno":
            idx = read_pheno_tile(root, z, x, y)
            if idx is None:
                return _png(TRANSPARENT_TILE, rev)
            show = request.args.get("show")
            rgba = colourise_pheno(
                idx, show=[s.strip() for s in show.split(",") if s.strip()] if show else None,
                alpha=_f(request.args.get("alpha"), 1.0),
            )
            return _png(encode_png(rgba), rev)

        return jsonify({"detail": f"unknown layer {layer!r}"}), 400

    @app.get("/biomarker/<item>/<ahash>/cells/<int:tx>/<int:ty>")
    def cells(item: str, tx: int, ty: int, ahash: str):
        """One core tile's per-cell records — hover, region stats and export read this."""
        import numpy as np

        path = cells_path(_root(item, ahash), tx, ty)
        if not path.is_file():
            return jsonify({"cells": [], "markers": MARKER_CHANNELS})
        with np.load(path) as zf:
            xy, ph, ok, mk = zf["xy"], zf["pheno"], zf["dapi_ok"], zf["markers"]
        out = []
        for i in range(len(ph)):
            name = PHENOTYPE_ORDER[int(ph[i]) - 1] if 0 < int(ph[i]) <= len(PHENOTYPE_ORDER) \
                else "Other"
            out.append({
                "x": float(xy[i][0]), "y": float(xy[i][1]),
                "phenotype": name, "dapi_ok": bool(ok[i]),
                # uint8 back to the presence PROBABILITY it always was — never an intensity
                "markers": {m: round(float(mk[i][j]) / 255.0, 3)
                            for j, m in enumerate(MARKER_CHANNELS)},
            })
        return jsonify({"cells": out, "markers": MARKER_CHANNELS})


def _root(item: str, ahash: str) -> Path:
    return artifact_dir(get_settings().cache_root, item, ahash)


def _dir_bytes(root: Path) -> int:
    """Bytes on disk under `root`, or 0 if it is not there. Walked rather than cached: an artifact
    grows while it builds, and a stale number in a delete dialog is worse than a slow one."""
    if not root.is_dir():
        return 0
    return sum(f.stat().st_size for f in root.rglob("*") if f.is_file())


def _f(v: str | None, default: float) -> float:
    try:
        return float(v) if v is not None else default
    except (TypeError, ValueError):
        return default
