"""The biomarker stage: a bbox (or a whole slide) → two tile pyramids + per-cell sidecars.

One pipeline serves both scopes (D5) — `bbox=None` simply means "every tissue core tile". Work is
done core tile by core tile (see `tiling`, review B1), and everything expensive is injected so the
whole orchestration is testable with no GPU, no CellViT and no slide:

    read_window(x, y, w, h)   -> uint8 [H, W, 3]
    tile_predict(rgb)         -> float32 [C, h, w] in [0, 1]      (GigaTIME-Flash, or a stub)
    fetch_nuclei(bbox)        -> (centroids, classes, contours)   all level-0 px

The mIF is held as **uint8** for the duration of one window. That is the pyramid's own storage
precision, so nothing is lost that would have survived to disk, and it is what keeps a 2560²
window at 151 MB instead of 2 GB.
"""

import logging
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from .artifacts import (
    CORE,
    HALO,
    LAYER_LEVEL_OFFSET,
    PIPELINE_VERSION,
    TILE,
    Coverage,
    cells_path,
    meta_path,
    read_json,
    summary_path,
    write_json,
)
from .markers import CHANNEL_NAMES, DAPI_CHANNEL, MARKER_CHANNELS, PHENOTYPE_ORDER
from .phenotype import dapi_ok, gate, pool_cells
from .pyramid import (
    BACKGROUND_INDEX,
    downsample_marker,
    downsample_pheno,
    levels_for,
    phenotype_index,
    read_marker_tile,
    read_pheno_tile,
    write_marker_tile,
    write_pheno_tile,
)
from .thresholds import MarkerHistograms, positive_markers_for, sample_tiles
from .tiling import ReadWindow, clip_bbox_to_slide, core_tiles, haloed_read_window, owns

logger = logging.getLogger(__name__)

# Sub-tile fed to the model at a time, and how much consecutive sub-tiles overlap.
#
# This is a seam control, not just a memory knob. `predict_tile` feathers its own 256-px windows,
# but consecutive CHUNKS were butt-jointed, so the chunk boundary printed a grid across the map at
# exactly this spacing — measured at ~7x the local gradient on real tissue, and plainly visible.
# Sizing the chunk to cover a whole haloed core (CORE + 2*HALO = 2560) means a core is ONE call
# and has no internal chunk seam at all; the overlap+feather below only matters for a read window
# larger than that. GPU cost of the one-call path is the accumulator: 23 x 2560² float32 ≈ 600 MB.
PREDICT_CHUNK = 2560
CHUNK_OVERLAP = 256

# Marker planes are stored at 1 µm/px; at a 0.25 µm/px slide that is a 4x box reduction.
MARKER_DOWNSCALE = 4


@dataclass(frozen=True)
class SlideInfo:
    width: int
    height: int
    mpp: float


def _chunk_starts(extent: int, chunk: int, overlap: int) -> list[int]:
    """Chunk origins covering ``extent``, overlapping by ``overlap``, last one flush to the end."""
    if extent <= chunk:
        return [0]
    stride = max(chunk - overlap, 1)
    starts = list(range(0, extent - chunk + 1, stride))
    if starts[-1] != extent - chunk:
        starts.append(extent - chunk)
    return starts


def _chunk_feather(h: int, w: int, overlap: int) -> np.ndarray:
    """Separable ramp that fades a chunk in over ``overlap`` at each edge, flat in the middle."""
    def ramp(n: int) -> np.ndarray:
        r = np.ones(n, dtype=np.float32)
        k = min(overlap, n // 2)
        if k > 0:
            edge = np.linspace(1.0 / (k + 1), 1.0 - 1.0 / (k + 1), k, dtype=np.float32)
            r[:k] = edge
            r[n - k:] = edge[::-1]
        return r
    return ramp(h)[:, None] * ramp(w)[None, :]


def predict_window(rgb: np.ndarray, tile_predict) -> np.ndarray:
    """Stream ``rgb`` through the model → uint8 ``[C, H, W]``, with no visible chunk seam.

    Chunks OVERLAP and are cross-faded. Butt-joining them printed a grid across the map at the
    chunk pitch: each call pads and windows independently, so two neighbouring chunks disagree
    along their shared edge, and that disagreement repeats over the whole slide.

    Quantising to uint8 at the end (rather than keeping float32) is what bounds memory; the
    pyramid stores uint8 anyway, so nothing that would have reached disk is lost.
    """
    h, w = rgb.shape[:2]
    ys = _chunk_starts(h, min(PREDICT_CHUNK, h), CHUNK_OVERLAP)
    xs = _chunk_starts(w, min(PREDICT_CHUNK, w), CHUNK_OVERLAP)
    ch = min(PREDICT_CHUNK, h)
    cw = min(PREDICT_CHUNK, w)

    if len(ys) == 1 and len(xs) == 1:            # the common case: one call, no seam to hide
        mif = tile_predict(rgb)
        return np.clip(mif * 255.0, 0, 255).astype(np.uint8)

    acc = np.zeros((len(CHANNEL_NAMES), h, w), dtype=np.float32)
    wsum = np.zeros((h, w), dtype=np.float32)
    weight = _chunk_feather(ch, cw, CHUNK_OVERLAP)
    for y0 in ys:
        for x0 in xs:
            mif = tile_predict(rgb[y0:y0 + ch, x0:x0 + cw])
            acc[:, y0:y0 + ch, x0:x0 + cw] += mif * weight
            wsum[y0:y0 + ch, x0:x0 + cw] += weight
    acc /= np.maximum(wsum, 1e-6)
    return np.clip(acc * 255.0, 0, 255).astype(np.uint8)


def _box_reduce(plane: np.ndarray, factor: int) -> np.ndarray:
    """Exact NxN box mean; edge-pads so a ragged last block still reduces."""
    h, w = plane.shape
    ph = (-h) % factor
    pw = (-w) % factor
    if ph or pw:
        plane = np.pad(plane, ((0, ph), (0, pw)), mode="edge")
    h, w = plane.shape
    return (plane.astype(np.uint16)
            .reshape(h // factor, factor, w // factor, factor)
            .mean(axis=(1, 3))).astype(np.uint8)


def _write_marker_tiles_for_core(root: Path, win: ReadWindow, mif: np.ndarray) -> None:
    """Crop the core out of the window, reduce 4x, and cut it into 256² marker tiles."""
    dy, dx = win.core_dy, win.core_dx
    core = mif[:, dy:dy + win.core_h, dx:dx + win.core_w]
    reduced = {m: _box_reduce(core[CHANNEL_NAMES.index(m)], MARKER_DOWNSCALE)
               for m in MARKER_CHANNELS}
    reduced[DAPI_CHANNEL] = _box_reduce(core[CHANNEL_NAMES.index(DAPI_CHANNEL)], MARKER_DOWNSCALE)

    # The core's origin in the marker layer's own pixel grid, then in its tile grid.
    ox = win.core_x // MARKER_DOWNSCALE
    oy = win.core_y // MARKER_DOWNSCALE
    any_plane = next(iter(reduced.values()))
    rh, rw = any_plane.shape
    for ty0 in range(0, rh, TILE):
        for tx0 in range(0, rw, TILE):
            tile_planes = {}
            for name, plane in reduced.items():
                chunk = plane[ty0:ty0 + TILE, tx0:tx0 + TILE]
                buf = np.zeros((TILE, TILE), dtype=np.uint8)
                buf[:chunk.shape[0], :chunk.shape[1]] = chunk
                tile_planes[name] = buf
            write_marker_tile(root, 0, (ox + tx0) // TILE, (oy + ty0) // TILE, tile_planes)


def _rasterise_phenotypes(
    win: ReadWindow, cells: list[dict], contours: list[list[list[float]]],
    slide: "SlideInfo",
) -> tuple[int, int, np.ndarray]:
    """Paint each owned nucleus's **full** contour into a halo-padded raster.

    Returns ``(origin_x, origin_y, raster)`` in level-0 slide pixels. The raster deliberately
    extends past the core by up to ``HALO``, because a nucleus owned by this core can straddle the
    boundary: cropping to the core here would draw it flat-sided, which is precisely the chopped
    grid review B1 exists to prevent. The overflow is merged into the neighbouring tiles by
    :func:`_write_pheno_rect`, and since ownership is a partition those pixels belong to nobody
    else.
    """
    ox = max(0, win.core_x - HALO)
    oy = max(0, win.core_y - HALO)
    ex = min(slide.width, win.core_x + win.core_w + HALO)
    ey = min(slide.height, win.core_y + win.core_h + HALO)
    canvas = Image.new("L", (ex - ox, ey - oy), BACKGROUND_INDEX)
    draw = ImageDraw.Draw(canvas)
    for cell, ring in zip(cells, contours, strict=True):
        idx = phenotype_index(cell["phenotype"])
        pts = [(float(px) - ox, float(py) - oy) for px, py in ring]
        if len(pts) >= 3:
            draw.polygon(pts, fill=idx)
        else:                       # degenerate contour → a small disc so the cell is still visible
            cx, cy = pts[0]
            draw.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=idx)
    return ox, oy, np.array(canvas, dtype=np.uint8)


def _write_pheno_rect(root: Path, ox: int, oy: int, idx: np.ndarray) -> None:
    """Blit a level-0 raster at ``(ox, oy)`` into the 256² tile grid, **merging** foreground.

    Merging (rather than overwriting) is what lets one core's halo overflow coexist with its
    neighbour's own nuclei in the shared border tile, whichever runs first.
    """
    h, w = idx.shape
    for ty in range(oy // TILE, (oy + h - 1) // TILE + 1):
        for tx in range(ox // TILE, (ox + w - 1) // TILE + 1):
            gx, gy = tx * TILE, ty * TILE
            sx0, sy0 = max(0, gx - ox), max(0, gy - oy)
            sx1, sy1 = min(w, gx + TILE - ox), min(h, gy + TILE - oy)
            if sx1 <= sx0 or sy1 <= sy0:
                continue
            chunk = idx[sy0:sy1, sx0:sx1]
            existing = read_pheno_tile(root, 0, tx, ty)
            buf = (existing.copy() if existing is not None
                   else np.full((TILE, TILE), BACKGROUND_INDEX, dtype=np.uint8))
            dx, dy = sx0 + ox - gx, sy0 + oy - gy
            dest = buf[dy:dy + chunk.shape[0], dx:dx + chunk.shape[1]]
            np.copyto(dest, chunk, where=chunk != BACKGROUND_INDEX)
            write_pheno_tile(root, 0, tx, ty, buf)


def build_levels(root: Path, layer: str, width: int, height: int) -> int:
    """Build every coarse level of ``layer`` from the level-0 tiles that exist.

    A parent tile is assembled from its four children, each reduced to TILE/2; missing children
    stay empty, so a partially-covered slide simply has holes rather than a broken pyramid.
    """
    n_levels = levels_for(width, height)
    half = TILE // 2
    for z in range(1, n_levels):
        parents: set[tuple[int, int]] = set()
        child_dir = root / layer / str(z - 1)
        if not child_dir.is_dir():
            break
        for f in child_dir.iterdir():
            if f.suffix not in (".npz", ".png"):
                continue
            cx, _, cy = f.stem.partition("_")
            try:
                parents.add((int(cx) // 2, int(cy) // 2))
            except ValueError:
                continue
        for px, py in sorted(parents):
            if layer == "markers":
                _merge_marker_parent(root, z, px, py, half)
            else:
                _merge_pheno_parent(root, z, px, py, half)
    return n_levels


def _merge_marker_parent(root: Path, z: int, px: int, py: int, half: int) -> None:
    names = MARKER_CHANNELS + [DAPI_CHANNEL]
    out = {n: np.zeros((TILE, TILE), dtype=np.uint8) for n in names}
    found = False
    for dy in (0, 1):
        for dx in (0, 1):
            child = read_marker_tile(root, z - 1, px * 2 + dx, py * 2 + dy, names)
            if not child:
                continue
            found = True
            small = downsample_marker(child)
            for n, plane in small.items():
                out[n][dy * half:dy * half + half, dx * half:dx * half + half] = plane
    if found:
        write_marker_tile(root, z, px, py, out)


def _merge_pheno_parent(root: Path, z: int, px: int, py: int, half: int) -> None:
    out = np.full((TILE, TILE), BACKGROUND_INDEX, dtype=np.uint8)
    found = False
    for dy in (0, 1):
        for dx in (0, 1):
            child = read_pheno_tile(root, z - 1, px * 2 + dx, py * 2 + dy)
            if child is None:
                continue
            found = True
            out[dy * half:dy * half + half, dx * half:dx * half + half] = downsample_pheno(child)
    if found:
        write_pheno_tile(root, z, px, py, out)


def ensure_thresholds(
    root: Path, *, art: str, slide: SlideInfo, tissue_tiles: list[tuple[int, int]],
    read_window, tile_predict, report=None,
) -> dict[str, float | None]:
    """Slide-level thresholds, computed once and cached in meta.json (D9).

    Needs GigaTIME only — positivity is a property of the mIF, not of the nuclei — so this costs
    minutes, not the hours a CellViT pass would.
    """
    meta = read_json(meta_path(root)) or {}
    if meta.get("thresholds"):
        return {k: v for k, v in meta["thresholds"].items()}

    picks = sample_tiles(tissue_tiles, seed=art)
    hist = MarkerHistograms()
    for i, (tx, ty) in enumerate(picks):
        win = haloed_read_window(tx, ty, slide.width, slide.height, halo=0)
        if win is None:
            continue
        rgb = read_window(win.x, win.y, win.width, win.height)
        mif = predict_window(rgb, tile_predict).astype(np.float32) / 255.0
        hist.add(mif)
        if report:
            report("sampling", 0.05 * (i + 1) / max(len(picks), 1))
    thr = hist.thresholds()
    meta.update({
        "thresholds": thr, "threshold_rev": 1, "threshold_scope": "slide",
        "n_sampled_tiles": hist.n_tiles,
    })
    write_json(meta_path(root), meta)
    return thr


def run_region(
    *, root: Path, art: str, slide: SlideInfo, bbox: dict | None,
    tissue_tiles: list[tuple[int, int]], read_window, tile_predict, fetch_nuclei,
    nucleus_radius_um: float = 4.0, report=None, core: int = CORE,
) -> dict:
    """Compute (or extend) this artifact over ``bbox``; ``None`` ⇒ every tissue tile."""
    root.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    if bbox is None:
        targets = list(tissue_tiles)
    else:
        clipped = clip_bbox_to_slide(bbox, slide.width, slide.height)
        if clipped is None:
            raise ValueError("bbox does not overlap the slide")
        wanted = set(core_tiles(clipped, core))
        tissue = set(tissue_tiles)
        targets = sorted(wanted & tissue) if tissue else sorted(wanted)

    cov = Coverage.load(root)
    todo = cov.missing(targets)
    logger.info("biomarker %s: %d target tiles, %d already covered",
                art, len(targets), len(targets) - len(todo))

    thr = ensure_thresholds(
        root, art=art, slide=slide, tissue_tiles=tissue_tiles or targets,
        read_window=read_window, tile_predict=tile_predict, report=report,
    )

    radius_px = max(1.0, nucleus_radius_um / max(slide.mpp, 1e-6))
    n_cells_total = 0
    for i, (tx, ty) in enumerate(todo):
        win = haloed_read_window(tx, ty, slide.width, slide.height, core=core, halo=HALO)
        if win is None:
            continue
        n_cells_total += _process_core(
            root=root, win=win, slide=slide, thresholds=thr, radius_px=radius_px,
            read_window=read_window, tile_predict=tile_predict, fetch_nuclei=fetch_nuclei,
        )
        cov.add(tx, ty)
        cov.save(root)                       # crash-resumable: coverage is durable per tile
        if report:
            report("tiles", 0.05 + 0.85 * (i + 1) / max(len(todo), 1))

    if report:
        report("pyramid", 0.92)
    build_levels(root, "markers", slide.width // MARKER_DOWNSCALE, slide.height // MARKER_DOWNSCALE)
    build_levels(root, "pheno", slide.width, slide.height)

    summary = _write_summary(root, cov, slide, core)
    meta = read_json(meta_path(root)) or {}
    meta.update({
        "version": PIPELINE_VERSION, "art_hash": art,
        "slide": {"width": slide.width, "height": slide.height, "mpp": slide.mpp},
        "tile": TILE, "core": core,
        "layers": {
            "markers": {
                "level_offset": LAYER_LEVEL_OFFSET["markers"],
                "levels": levels_for(slide.width // MARKER_DOWNSCALE,
                                     slide.height // MARKER_DOWNSCALE),
            },
            "pheno": {
                "level_offset": LAYER_LEVEL_OFFSET["pheno"],
                "levels": levels_for(slide.width, slide.height),
            },
        },
        "marker_names": MARKER_CHANNELS,
        "phenotype_order": PHENOTYPE_ORDER,
    })
    write_json(meta_path(root), meta)
    if report:
        report("done", 1.0)

    return {
        "art_hash": art, "n_tiles": len(cov.done), "n_new_tiles": len(todo),
        "n_cells": summary["n_cells"], "seconds": round(time.time() - t0, 1),
    }


def _process_core(
    *, root: Path, win: ReadWindow, slide: SlideInfo, thresholds: dict,
    radius_px: float, read_window, tile_predict, fetch_nuclei,
) -> int:
    rgb = read_window(win.x, win.y, win.width, win.height)
    mif = predict_window(rgb, tile_predict)

    _write_marker_tiles_for_core(root, win, mif)

    centroids, classes, contours = fetch_nuclei(
        {"x": win.x, "y": win.y, "width": win.width, "height": win.height}
    )
    kept = [i for i, (cx, cy) in enumerate(centroids) if owns(cx, cy, win)]
    if not kept:
        # An empty core still gets its (blank) phenotype tiles so the layer has no ragged holes
        # where tissue genuinely has no nuclei, and still counts as covered.
        _write_pheno_rect(root, win.core_x, win.core_y,
                          np.full((win.core_h, win.core_w), BACKGROUND_INDEX, dtype=np.uint8))
        _write_cells(root, win, [], np.zeros((0, len(CHANNEL_NAMES)), dtype=np.float32))
        return 0

    colrows = [(centroids[i][0] - win.x, centroids[i][1] - win.y) for i in kept]
    vectors = pool_cells(mif.astype(np.float32) / 255.0, colrows, radius_px)
    ok = dapi_ok(vectors)

    cells: list[dict] = []
    for k, i in enumerate(kept):
        pos = positive_markers_for(vectors[k], thresholds)
        lineage, flags = gate(pos)
        cells.append({
            "x": float(centroids[i][0]), "y": float(centroids[i][1]),
            "phenotype": lineage, "flags": flags, "dapi_ok": bool(ok[k]),
            "pannuke": classes[i] if i < len(classes) else None,
        })
    ox, oy, idx = _rasterise_phenotypes(win, cells, [contours[i] for i in kept], slide)
    _write_pheno_rect(root, ox, oy, idx)
    _write_cells(root, win, cells, vectors)
    return len(cells)


def _write_cells(root: Path, win: ReadWindow, cells: list[dict], vectors: np.ndarray) -> None:
    """Per-core-tile cell sidecar (review S3 — a byproduct, written from phase 1)."""
    path = cells_path(root, win.core_x // CORE, win.core_y // CORE)
    path.parent.mkdir(parents=True, exist_ok=True)
    marker_idx = [CHANNEL_NAMES.index(m) for m in MARKER_CHANNELS]
    probs = (np.clip(vectors[:, marker_idx], 0, 1) * 255).astype(np.uint8) \
        if vectors.size else np.zeros((0, len(MARKER_CHANNELS)), dtype=np.uint8)
    tmp = path.with_suffix(".npz.tmp")
    with open(tmp, "wb") as fh:
        np.savez_compressed(
            fh,
            xy=np.array([[c["x"], c["y"]] for c in cells], dtype=np.float32).reshape(-1, 2),
            pheno=np.array([phenotype_index(c["phenotype"]) for c in cells], dtype=np.uint8),
            dapi_ok=np.array([c["dapi_ok"] for c in cells], dtype=bool),
            markers=probs,
        )
    tmp.replace(path)


def _write_summary(root: Path, cov: Coverage, slide: SlideInfo, core: int) -> dict:
    """Recompute whole-artifact counts from every sidecar (cheap: ~30 B/cell)."""
    counts = {name: 0 for name in PHENOTYPE_ORDER}
    n_cells = 0
    for tx, ty in sorted(cov.done):
        path = cells_path(root, tx, ty)
        if not path.is_file():
            continue
        with np.load(path) as z:
            ph = z["pheno"]
        n_cells += int(ph.size)
        for i, name in enumerate(PHENOTYPE_ORDER, start=1):
            counts[name] += int((ph == i).sum())
    area_mm2 = len(cov.done) * (core * slide.mpp / 1000.0) ** 2
    doc = {
        "n_cells": n_cells,
        "counts_by_phenotype": {k: v for k, v in counts.items() if v},
        "n_tiles": len(cov.done),
        "area_mm2": round(area_mm2, 3),
    }
    write_json(summary_path(root), doc)
    return doc
