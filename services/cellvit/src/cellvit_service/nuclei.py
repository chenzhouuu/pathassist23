"""Run nuclei over a region, core tile by core tile, and store the rings (Inc 5, ticket 05).

The shape is ``tissue/wholeslide.py``'s: enumerate the core tiles a bbox covers, read each one with
a halo, run the model, keep what belongs to this core, persist, extend coverage, then draw. What
differs is what "keep" means. The tissue map crops a prediction to the core rectangle; a nucleus is
not a rectangle, so ownership is decided by the **centroid**:

    a nucleus belongs to the core its centroid falls in

which is exactly one core for every nucleus, so a cell straddling a seam is stored once, whole,
with the ring the halo let the model see in full. Cropping the ring instead would have produced two
half-cells and counted them twice.

Instance ids are assigned per artifact, densely, in the order tiles are computed. They are stable
across a resume because a tile that is already in coverage is not recomputed, and a tile's ids are
written in the same atomic write as its rings.
"""

import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .artifacts import (
    CORE,
    HALO,
    STORE_MPP,
    TILE,
    Coverage,
    cells_path,
    level_offset,
    meta_path,
    read_json,
    summary_path,
    write_cells,
    write_json,
)
from .geometry import offset_points, offset_rings
from .pannuke import TYPE_NAMES, color_for, name_for
from .pyramid import levels_for
from .raster import MAX_LEVEL_OFFSET, rasterise_artifact
from .tiling import clip_bbox_to_slide, core_tiles, haloed_read_window

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SlideInfo:
    width: int
    height: int
    mpp: float | None


def _owns(cx: float, cy: float, tx: int, ty: int, core: int) -> bool:
    """Whether the core tile (tx, ty) owns a nucleus centred at (cx, cy), in level-0 px."""
    return int(cx) // core == tx and int(cy) // core == ty


def _tile_area_mm2(n_tiles: int, core: int, mpp: float | None) -> float | None:
    """Area the covered cores span, in mm². None when the slide never reported an mpp — an area
    computed from an assumed resolution would be a number with no measurement behind it."""
    if not mpp or mpp <= 0:
        return None
    side_mm = core * mpp / 1000.0
    return n_tiles * side_mm * side_mm


def run_region(
    *,
    root: Path,
    art: str,
    slide: SlideInfo,
    bbox: dict | None,
    tiles: list[tuple[int, int]] | None,
    read_region,
    segment,
    backend: str,
    report=None,
    should_stop=None,
) -> dict:
    """Compute and store the nuclei for `bbox` (or for an explicit tile list).

    `read_region(bbox)` returns an object with `.pixels`, `.mpp` and `.scale` — the same seam the
    /segment route already reads through. `segment(pixels, mpp)` returns
    `(points, classes, contours)` in region-local pixels, which is CellViT's own output shape.

    Returns the summary the panel shows. Re-running an already-covered region is close to free:
    covered tiles are skipped, and the answer comes back off disk.
    """
    root.mkdir(parents=True, exist_ok=True)
    cov = Coverage.load(root)

    if tiles is None:
        clipped = clip_bbox_to_slide(bbox or {}, slide.width, slide.height)
        if clipped is None:
            raise ValueError("the requested region does not overlap the slide")
        tiles = core_tiles(clipped, CORE)

    todo = cov.missing(tiles)
    total = len(todo)
    stopped = False
    computed: list[tuple[int, int]] = []

    # Ids continue from what is already stored, so a resume never reissues an id that a previous
    # run gave to a different nucleus.
    next_inst = int((cov.totals or {}).get("next_inst", 1))
    counts = dict((cov.totals or {}).get("counts_by_class") or {})
    n_nuclei = int((cov.totals or {}).get("n_nuclei", 0))

    for i, (tx, ty) in enumerate(todo):
        if should_stop is not None and should_stop():
            stopped = True
            break
        win = haloed_read_window(tx, ty, slide.width, slide.height, CORE, HALO)
        if win is None:
            continue

        region = read_region({"x": win.x, "y": win.y, "width": win.width, "height": win.height})
        local_pts, local_cls, local_rings = segment(region.pixels, region.mpp)
        pts = offset_points(local_pts, win.x, win.y, region.scale)
        rings = offset_rings(local_rings, win.x, win.y, region.scale)

        keep = [k for k, (cx, cy) in enumerate(pts) if _owns(cx, cy, tx, ty, CORE)]
        xy = np.array([pts[k] for k in keep], dtype=np.float32).reshape(-1, 2)
        cls = np.array([local_cls[k] for k in keep], dtype=np.uint8).reshape(-1)
        kept_rings = [rings[k] for k in keep]
        inst = np.arange(next_inst, next_inst + len(keep), dtype=np.uint32)
        next_inst += len(keep)

        write_cells(
            cells_path(root, tx, ty),
            xy=xy, cls=cls, rings=kept_rings, inst=inst,
            origin=(tx * CORE, ty * CORE),
        )

        n_nuclei += len(keep)
        for c in cls.tolist():
            n = name_for(c)
            counts[n] = counts.get(n, 0) + 1

        # Coverage and the tallies it describes, in one atomic write, immediately after the tile
        # they account for. This is the boundary a stop is allowed to happen at.
        cov.add(tx, ty)
        cov.totals = {"n_nuclei": n_nuclei, "counts_by_class": counts, "next_inst": next_inst}
        cov.save(root)
        computed.append((tx, ty))

        if report is not None:
            report("nuclei", (i + 1) / total if total else 1.0)

    # Even a stopped job draws: the raster is what makes the covered area viewable at all, and it
    # costs a fraction of one core's inference. It is also where a core computed next to an older
    # one gets its seam filled in, so it runs after the loop rather than inside it (raster.py).
    if report is not None:
        report("raster", 0.98)
    offset = min(level_offset(slide.mpp or STORE_MPP, STORE_MPP), MAX_LEVEL_OFFSET)
    rasterise_artifact(root, cov=cov, offset=offset, width=slide.width, height=slide.height,
                       computed=computed)

    _write_meta(root, art=art, slide=slide, backend=backend, offset=offset)
    summary = _write_summary(root, cov, slide)
    summary["stopped"] = stopped
    summary["remaining"] = max(0, len(cov.missing(tiles)))
    summary["art_hash"] = art
    return summary


def _write_meta(root: Path, *, art: str, slide: SlideInfo, backend: str, offset: int) -> None:
    """Everything a later reader needs to interpret the vectors, and to draw them, without asking
    the slide again. The palette lives here rather than in the frontend so a recolour can never
    drift from the map it is describing."""
    s = 1 << offset
    n_levels = levels_for(-(-slide.width // s), -(-slide.height // s))
    write_json(meta_path(root), {
        "art_hash": art,
        "backend": backend,
        "slide": {"width": slide.width, "height": slide.height, "mpp": slide.mpp},
        # The resolution actually used, not the one asked for: an integer octave offset is what
        # keeps the tile grid aligned, and a 0.5 µm/px slide is stored at its own 0.5 rather than
        # being upsampled to 0.25.
        "store_mpp": round((slide.mpp or STORE_MPP) * s, 5),
        "level_offset": offset,
        "layers": {"classes": {"level_offset": offset, "levels": n_levels}},
        "tile": TILE,
        "core": CORE,
        "classes": [TYPE_NAMES[k] for k in sorted(TYPE_NAMES)],
        "colors": {TYPE_NAMES[k]: f"#{color_for(k)}" for k in sorted(TYPE_NAMES)},
        "class_ids": {str(k): v for k, v in TYPE_NAMES.items()},
    })


def _write_summary(root: Path, cov: Coverage, slide: SlideInfo) -> dict:
    """The numbers the panel reports, derived from coverage's tallies and nothing else."""
    totals = cov.totals or {}
    doc = {
        "n_nuclei": int(totals.get("n_nuclei", 0)),
        "counts_by_class": dict(totals.get("counts_by_class") or {}),
        "n_tiles": len(cov.done),
        "area_mm2": _tile_area_mm2(len(cov.done), cov.core, slide.mpp),
    }
    write_json(summary_path(root), doc)
    return dict(doc)


def load_summary(root: Path) -> dict | None:
    return read_json(summary_path(root))


__all__ = ["SlideInfo", "run_region", "load_summary"]
