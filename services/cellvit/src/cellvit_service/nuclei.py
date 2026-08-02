"""Run nuclei over a region, core tile by core tile, and store the rings (Inc 5 · 05, Inc 7 §6).

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

Since Inc 7 a core lands as three things rather than one: its outlines (`cells/`), the encoder's
per-nucleus tokens (`tokens/`), and PanNuke's naming of them (`labels/pannuke/`). PanNuke is not
privileged here — it is written through the same sidecar the five classifier heads write through,
and is only produced at this moment because the decoder produces it at this moment.
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
    label_dir,
    labels_path,
    level_offset,
    meta_path,
    read_json,
    stored_taxonomies,
    summary_path,
    tokens_path,
    write_cells,
    write_json,
    write_labels,
    write_tokens,
)
from .geometry import offset_points, offset_rings
from .pyramid import levels_for
from .raster import draw_one_core, rasterise_artifact, scale_for
from .taxonomy import DEFAULT, TAXONOMIES
from .taxonomy import get as get_taxonomy
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
    /segment route already reads through. `segment(pixels, mpp)` returns an `infer.Segmented`:
    centroids, PanNuke classes, rings, tokens and PanNuke's per-nucleus agreement, all
    index-aligned, in region-local pixels.

    Returns the summary the panel shows. Re-running an already-covered region is close to free:
    covered tiles are skipped, and the answer comes back off disk.
    """
    root.mkdir(parents=True, exist_ok=True)
    cov = Coverage.load(root)
    pan_root = label_dir(root, DEFAULT)
    pan = Coverage.load(pan_root)

    if tiles is None:
        clipped = clip_bbox_to_slide(bbox or {}, slide.width, slide.height)
        if clipped is None:
            raise ValueError("the requested region does not overlap the slide")
        tiles = core_tiles(clipped, CORE)

    todo = cov.missing(tiles)
    total = len(todo)
    stopped = False
    computed: list[tuple[int, int]] = []

    # Fixed for the whole job, so the picture a core is drawn into is the one the artifact will
    # keep — derived from the slide, never assumed.
    offset = level_offset(slide.mpp or STORE_MPP, STORE_MPP)
    s = scale_for(offset)
    n_levels = levels_for(-(-slide.width // s), -(-slide.height // s))

    # Ids continue from what is already stored, so a resume never reissues an id that a previous
    # run gave to a different nucleus.
    next_inst = int((cov.totals or {}).get("next_inst", 1))
    n_nuclei = int((cov.totals or {}).get("n_nuclei", 0))
    counts = dict((pan.totals or {}).get("counts_by_class") or {})
    pan_nuclei = int((pan.totals or {}).get("n_nuclei", 0))
    pannuke = get_taxonomy(DEFAULT)

    for i, (tx, ty) in enumerate(todo):
        if should_stop is not None and should_stop():
            stopped = True
            break
        win = haloed_read_window(tx, ty, slide.width, slide.height, CORE, HALO)
        if win is None:
            continue

        region = read_region({"x": win.x, "y": win.y, "width": win.width, "height": win.height})
        seg = segment(region.pixels, region.mpp)
        pts = offset_points(seg.points, win.x, win.y, region.scale)
        rings = offset_rings(seg.contours, win.x, win.y, region.scale)

        keep = [k for k, (cx, cy) in enumerate(pts) if _owns(cx, cy, tx, ty, CORE)]
        xy = np.array([pts[k] for k in keep], dtype=np.float32).reshape(-1, 2)
        cls = np.array([seg.classes[k] for k in keep], dtype=np.uint8).reshape(-1)
        prob = np.array([seg.probs[k] for k in keep], dtype=np.float16).reshape(-1)
        kept_rings = [rings[k] for k in keep]
        inst = np.arange(next_inst, next_inst + len(keep), dtype=np.uint32)
        next_inst += len(keep)

        write_cells(
            cells_path(root, tx, ty),
            xy=xy, rings=kept_rings, inst=inst, origin=(tx * CORE, ty * CORE),
        )
        write_tokens(tokens_path(root, tx, ty), seg.tokens[keep] if len(seg.tokens) else seg.tokens)
        write_labels(labels_path(root, DEFAULT, tx, ty), cls=cls, prob=prob)

        n_nuclei += len(keep)
        pan_nuclei += len(keep)
        for c in cls.tolist():
            n = pannuke.name(c)
            counts[n] = counts.get(n, 0) + 1

        # Coverage and the tallies it describes, in one atomic write, immediately after the tile
        # they account for. This is the boundary a stop is allowed to happen at.
        #
        # PanNuke's coverage is saved *before* the artifact's, and the order is not arbitrary: a
        # crash between the two must leave a core that has no outlines yet rather than one that has
        # outlines nobody will ever name. The first is redone by the next run; the second would
        # need somebody to notice.
        pan.add(tx, ty)
        pan.totals = {"n_nuclei": pan_nuclei, "counts_by_class": counts}
        pan.save(pan_root)

        cov.add(tx, ty)
        cov.totals = {"n_nuclei": n_nuclei, "next_inst": next_inst}
        cov.save(root)
        computed.append((tx, ty))

        # Draw it now, so a whole-slide run fills in on screen as it goes instead of showing
        # nothing for an hour. The seams against cores that do not exist yet are fixed below.
        # Only PanNuke: no other taxonomy can have reached a core that did not exist until now.
        draw_one_core(root, tx, ty, s=s, n_levels=n_levels, taxonomies=[DEFAULT])

        if report is not None:
            # The counts go out alongside the fraction. They were always here — until Inc 6 the
            # signature had nowhere to put them, so a whole-slide run could only say "42 %" when
            # it knew perfectly well it was on core tile 142 of 338.
            report("nuclei", (i + 1) / total if total else 1.0, i + 1, total or None)

    # Even a stopped job finalises: this is where a core drawn before its neighbour existed gets
    # that neighbour's overhang, and it costs a fraction of one core's inference.
    if report is not None:
        report("raster", 0.98)
    rasterise_artifact(root, cov=cov, offset=offset, width=slide.width, height=slide.height,
                       computed=computed)

    _write_meta(root, art=art, slide=slide, backend=backend, offset=offset)
    summary = write_label_summary(root, DEFAULT, pan, slide.mpp)
    summary["stopped"] = stopped
    summary["remaining"] = max(0, len(cov.missing(tiles)))
    summary["art_hash"] = art
    return summary


def _write_meta(root: Path, *, art: str, slide: SlideInfo, backend: str, offset: int) -> None:
    """Everything a later reader needs to interpret the vectors, and to draw them, without asking
    the slide again. The palette lives here rather than in the frontend so a recolour can never
    drift from the map it is describing.

    Every taxonomy stored on this artifact is described, PanNuke first — the class list, the
    colours and the display names for each. Which of them is *drawn* is the viewer's business; what
    is here is what could be.
    """
    s = 1 << offset
    n_levels = levels_for(-(-slide.width // s), -(-slide.height // s))
    stored = stored_taxonomies(root) or [DEFAULT]
    write_json(meta_path(root), {
        "art_hash": art,
        "backend": backend,
        "slide": {"width": slide.width, "height": slide.height, "mpp": slide.mpp},
        # The resolution actually used, not the one asked for: an integer octave offset is what
        # keeps the tile grid aligned, and a 0.5 µm/px slide is stored at its own 0.5 rather than
        # being upsampled to 0.25.
        "store_mpp": round((slide.mpp or STORE_MPP) * s, 5),
        "level_offset": offset,
        # Every plane shares a grid and a pyramid depth — a class plane is a lookup over the
        # instance one (raster.rasterise_core) — so the viewer mounts any of them at one geometry.
        "layers": {"classes": {"level_offset": offset, "levels": n_levels},
                   "instances": {"level_offset": offset, "levels": n_levels}},
        "tile": TILE,
        "core": CORE,
        "default_taxonomy": DEFAULT,
        "taxonomies": [
            TAXONOMIES[t].as_dict() for t in _ordered(stored) if t in TAXONOMIES
        ],
    })


def refresh_meta(root: Path) -> None:
    """Rewrite `meta.json`'s taxonomy list from what is on disk.

    A classify run adds a naming to an artifact whose meta was written by a segmentation run that
    had never heard of it. Everything else in meta is a property of the slide and the model, so it
    is read back and written out unchanged — this is a re-listing, not a re-derivation.
    """
    doc = read_json(meta_path(root))
    if not doc:
        return
    slide = SlideInfo(
        width=int(doc["slide"]["width"]),
        height=int(doc["slide"]["height"]),
        mpp=doc["slide"].get("mpp"),
    )
    _write_meta(root, art=doc.get("art_hash", ""), slide=slide,
                backend=doc.get("backend", ""), offset=int(doc.get("level_offset", 0)))


def _ordered(stored: list[str]) -> list[str]:
    """Stored taxonomies with PanNuke first — the order a selector is built in."""
    return [DEFAULT, *sorted(t for t in stored if t != DEFAULT)] if DEFAULT in stored \
        else sorted(stored)


def summary_from_coverage(cov: Coverage, mpp: float | None) -> dict:
    """The numbers the panel reports, derived from coverage's tallies and nothing else.

    Kept as a function so the meta route can call it too. `summary.json` is written once, at the
    end of a job; coverage is written after every core. A reader mid-job that took its counts from
    the file and its tile list from coverage would see one artifact giving two accounts of itself —
    exactly what the atomic tally exists to prevent. So the live answer is computed from coverage,
    and the file is a durable copy of the same arithmetic.

    Since Inc 7 the `cov` handed in is a **taxonomy's**, not the artifact's: the counts and the
    tile list they describe have to come out of one file, and a naming reaches its own set of
    cores.
    """
    totals = cov.totals or {}
    return {
        "n_nuclei": int(totals.get("n_nuclei", 0)),
        "counts_by_class": dict(totals.get("counts_by_class") or {}),
        "n_tiles": len(cov.done),
        "area_mm2": _tile_area_mm2(len(cov.done), cov.core, mpp),
    }


def write_label_summary(root: Path, taxonomy: str, cov: Coverage, mpp: float | None) -> dict:
    doc = summary_from_coverage(cov, mpp)
    write_json(summary_path(root, taxonomy), doc)
    return dict(doc)


def load_summary(root: Path, taxonomy: str = DEFAULT) -> dict | None:
    return read_json(summary_path(root, taxonomy))


__all__ = [
    "SlideInfo", "load_summary", "refresh_meta", "run_region", "summary_from_coverage",
    "write_label_summary",
]
