"""Draw the stored rings into the instance raster, and each naming into its own (Inc 5 · 06, Inc 7).

The picture is derived, always, from `cells/`. Nothing here is a source of truth: delete the whole
`instances/` and `labels/*/classes/` trees and the next job redraws them from the vectors, with the
same nuclei and the same classes. That is what makes the acceptance criterion checkable — the count
in the report and the shape on screen cannot come from two different objects, because there is only
one object (D3).

**One drawing pass, N pictures.** What gets filled is the nucleus's *instance id*; a taxonomy's
class raster is then a lookup from id to class over that array. That was already true for PanNuke
in Inc 5; Inc 7 only notices that the expensive half — filling a million polygons — is the half
that does not depend on the naming. So classifying a slide with a fifth head costs a lookup table
applied to a raster that is already on disk (§5), not a redraw.

Three things make this less trivial than "fill each polygon":

**Seams.** A core owns the nuclei whose *centroid* falls inside it, so a nucleus near a seam is
stored whole by one core and overhangs its neighbour. Painting only the cores' own nuclei would
therefore cut every straddling nucleus off at a straight line, and those lines would form a visible
2048 px grid. So a core is drawn from the vector truth of its 3x3 neighbourhood and then cropped:
whatever overhangs into it gets painted, whoever owns it. Nothing is written twice, no tile is
read-modify-written, and the result does not depend on the order the cores were computed in. The
same neighbourhood rule governs a class lookup, which is why a taxonomy needs its neighbours'
labels and not only its own core's.

**Staleness.** Because a core's picture depends on its neighbours' vectors, computing a new core
invalidates the pictures of the covered neighbours around it. The redraw set is therefore the new
cores, plus their already-covered neighbours, plus any covered core with no picture at all — the
last clause is what makes this self-healing: an artifact whose job died mid-redraw gets its picture
on the next run without anybody having to notice.

**Every nucleus is drawn.** Inc 5 skipped a nucleus whose PanNuke class had no palette entry, which
kept it out of the picture and in the counts. That is no longer a decision PanNuke gets to make for
five other taxonomies: the instance raster is the shared substrate now, and a nucleus PanNuke
declined to name must still be there for NuCLS to name. A nucleus a *given* taxonomy has no class
for is background in that taxonomy's plane alone.
"""

import logging
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from .artifacts import (
    CORE,
    TILE,
    Coverage,
    cells_path,
    class_tile_path,
    instance_tile_path,
    label_dir,
    labels_path,
    read_cell_arrays,
    read_labels,
    stored_taxonomies,
)
from .pyramid import (
    build_class_levels,
    build_class_levels_above,
    build_levels,
    build_levels_above,
    levels_for,
    pad_tile,
    read_instance_tile,
    write_class_tile,
    write_cover_tile,
    write_instance_tile,
)
from .taxonomy import DEFAULT

logger = logging.getLogger(__name__)

# Above this the stored core (CORE >> offset) stops being a whole number of TILE px tiles, and
# cores would start sharing tiles. Nuclei are stored at 0.25 µm/px, so real slides use 0 or 1.
MAX_LEVEL_OFFSET = 3


def scale_for(offset: int) -> int:
    """Level-0 px per stored px, refusing an offset that would put two cores in one tile."""
    if offset > MAX_LEVEL_OFFSET:
        raise RuntimeError(f"level offset {offset} would put more than one core in a tile")
    return 1 << offset


# ── step 1: the drawing pass ────────────────────────────────────────────────────────


def draw_one_core(
    root: Path, tx: int, ty: int, *, s: int, n_levels: int, taxonomies: list[str] | None = None,
) -> None:
    """Draw a core and refresh the pyramid above it — the *live* picture, during a run.

    A whole-slide run is hours long, so a picture that only appeared at the end would not be a
    picture of anything you could watch. This draws each core as it lands and pushes it up the
    pyramid along its own ancestor chain, which is bounded work per core.

    It is a preview, and knowingly incomplete: the cores to this one's right and below have not
    been computed yet, so the nuclei that will overhang from them are missing and this core's
    right and bottom seams are provisional. The finalisation pass in `rasterise_artifact` redraws
    them once the neighbours exist, which is what makes the finished artifact seamless.
    """
    taxes = [DEFAULT] if taxonomies is None else list(taxonomies)
    tiles = rasterise_core(root, tx, ty, s=s, taxonomies=taxes)
    build_levels_above(root, n_levels, tiles)
    for tax in taxes:
        build_class_levels_above(root, tax, n_levels, tiles)


def rasterise_core(
    root: Path, tx: int, ty: int, *, s: int, taxonomies: list[str] | None = None,
) -> list[tuple[int, int]]:
    """Fill one core's instance raster from its 3x3 neighbourhood, and derive what it is asked for.

    `taxonomies` are the namings whose class plane this core should carry — the caller's business,
    because it is the one that knows which of them have reached this core. Passing none writes only
    the shared planes.

    Returns the level-0 tile coordinates it wrote, so the caller can refresh their ancestors.
    """
    side = CORE // s
    # "I" is PIL's 32-bit integer mode: ids go in directly, with no palette to run out of.
    canvas = Image.new("I", (side, side), 0)
    draw = ImageDraw.Draw(canvas)
    origin = np.array([tx * CORE, ty * CORE], dtype=np.float64)

    for nx, ny in _neighbourhood(tx, ty):
        cells = read_cell_arrays(cells_path(root, nx, ny))
        if cells is None:
            continue
        off, ring_xy = cells["ring_off"], (cells["ring_xy"] - origin) / s
        for i, ident in enumerate(cells["inst"].tolist()):
            pts = ring_xy[off[i]:off[i + 1]]
            if len(pts) < 3 or not _touches(pts, side):
                continue
            draw.polygon([(float(px), float(py)) for px, py in pts], fill=int(ident))

    ids = np.asarray(canvas, dtype=np.uint32)
    written = _write_shared_tiles(root, tx, ty, side, ids)
    for tax in (taxonomies or []):
        _write_class_tiles(root, tax, tx, ty, side,
                           _class_raster(ids, _class_lut(root, tx, ty, tax)))
    return written


def rasterise_artifact(
    root: Path, *, cov: Coverage, offset: int, width: int, height: int,
    computed: list[tuple[int, int]] | None = None,
) -> int:
    """Redraw whatever the new cores invalidated, then rebuild the pyramids. Returns cores drawn.

    Run once at the end of a segmentation job. Every core here has already been drawn as it landed;
    what this fixes is the seams, where a core drawn before its neighbour existed is missing that
    neighbour's overhang. It also picks up any covered core with no picture at all.

    A redrawn core's class planes are rewritten for **every taxonomy that already covers it**, not
    just PanNuke: the overhang that moved is the same overhang in all of them.

    Self-healing is per plane, because the planes can go missing separately. A core whose outlines
    are drawn but whose *naming* has no picture — a classify job that died mid-redraw, or a
    `labels/{tax}/classes` somebody deleted — needs no polygon work at all: its instance raster is
    intact, so the lookup path puts the colour back.
    """
    s = scale_for(offset)
    taxes = stored_taxonomies(root)
    tax_cov = {t: Coverage.load(label_dir(root, t)) for t in taxes}

    todo = _needs_redraw(root, cov=cov, s=s, computed=computed or [])
    for tx, ty in todo:
        rasterise_core(root, tx, ty, s=s,
                       taxonomies=[t for t in taxes if tax_cov[t].has(tx, ty)])
    if todo:
        logger.info("nuclei raster: redrew %d core(s)", len(todo))

    redrawn = set(todo)
    for tax in taxes:
        gaps = [c for c in sorted(tax_cov[tax].done)
                if c not in redrawn and not _has_class_picture(root, tax, c, s)]
        for tx, ty in gaps:
            rasterise_class_core(root, tx, ty, s=s, taxonomy=tax)
        if gaps:
            logger.info("nuclei raster: relooked %d core(s) for %s", len(gaps), tax)

    n_levels = levels_for(_ceil_div(width, s), _ceil_div(height, s))
    build_levels(root, n_levels)
    for tax in taxes:
        build_class_levels(root, tax, n_levels)
    return len(todo)


# ── step 2: the lookup pass ─────────────────────────────────────────────────────────


def draw_one_class_core(
    root: Path, tx: int, ty: int, *, s: int, n_levels: int, taxonomy: str,
) -> None:
    """One taxonomy's live picture for a core, during a classify job. The cheap path."""
    tiles = rasterise_class_core(root, tx, ty, s=s, taxonomy=taxonomy)
    build_class_levels_above(root, taxonomy, n_levels, tiles)


def rasterise_class_core(
    root: Path, tx: int, ty: int, *, s: int, taxonomy: str,
) -> list[tuple[int, int]]:
    """One taxonomy's class raster for a core, from the instance raster already on disk.

    No polygon is filled and no ring is read. This is what makes a fifth naming of a whole slide
    cost seconds: the shapes were drawn once, in step 1, and a naming is a lookup table over them.
    """
    side = CORE // s
    ids = _read_core_ids(root, tx, ty, side)
    if ids is None:
        # No instance raster for this core: it has vectors but was never drawn, which the
        # segmentation job's self-healing clause is what fixes. Nothing to look up over.
        return []
    return _write_class_tiles(
        root, taxonomy, tx, ty, side, _class_raster(ids, _class_lut(root, tx, ty, taxonomy)),
    )


def rasterise_labels(
    root: Path, *, cov: Coverage, offset: int, width: int, height: int, taxonomy: str,
    computed: list[tuple[int, int]] | None = None,
) -> int:
    """Finalise one taxonomy's plane: fix the seams the new cores invalidated, rebuild its pyramid.

    `cov` is *this taxonomy's* coverage, not the artifact's — a neighbour that has outlines but no
    labels yet contributes nothing to look up, and redrawing on its account would be work for a
    picture that cannot change.
    """
    s = scale_for(offset)
    todo = _needs_redraw(root, cov=cov, s=s, computed=computed or [],
                         has_picture=lambda c: _has_class_picture(root, taxonomy, c, s))
    for tx, ty in todo:
        rasterise_class_core(root, tx, ty, s=s, taxonomy=taxonomy)
    if todo:
        logger.info("nuclei raster: redrew %d core(s) for %s", len(todo), taxonomy)

    build_class_levels(root, taxonomy,
                       levels_for(_ceil_div(width, s), _ceil_div(height, s)))
    return len(todo)


# ── the lookup itself ───────────────────────────────────────────────────────────────


def _class_lut(root: Path, tx: int, ty: int, taxonomy: str) -> dict[int, int]:
    """instance id → stored class id, over this core's 3x3 neighbourhood.

    The neighbourhood, not the core, for the reason the seam rule gives: a nucleus owned by the
    core next door is painted into this one, so its class has to come from next door's labels.

    A core with vectors and no labels contributes nothing, and its nuclei then look up to 0 — which
    is "no nucleus here" in this taxonomy's plane and exactly right: it has not named them yet.
    """
    out: dict[int, int] = {}
    for nx, ny in _neighbourhood(tx, ty):
        cells = read_cell_arrays(cells_path(root, nx, ny))
        if cells is None:
            continue
        lab = read_labels(labels_path(root, taxonomy, nx, ny))
        if lab is None:
            continue
        for ident, c in zip(cells["inst"].tolist(), lab["cls"].tolist(), strict=True):
            out[int(ident)] = int(c)
    return out


def _class_raster(ids: np.ndarray, cls_of: dict[int, int]) -> np.ndarray:
    """Instance raster → class raster, through a lookup table indexed by id.

    A table rather than a loop over the ids present: a dense core holds thousands of nuclei, and
    masking the array once per nucleus would be thousands of passes over four million pixels. The
    table is one byte per id up to the largest one *in the raster*, which is a few MB at
    whole-slide scale.

    Sized by the raster and not by `cls_of`, which matters now that the two can disagree: an
    unclassified neighbour puts ids in the picture that the lookup has no entry for, and clamping
    them into the table's range would hand them whichever class happened to sit at the end of it.
    They read 0 instead — absent from this naming, present in the outlines.
    """
    hi = int(ids.max(initial=0))
    if not cls_of or hi == 0:
        return np.zeros(ids.shape, dtype=np.uint8)
    lut = np.zeros(max(hi, max(cls_of)) + 1, dtype=np.uint8)
    for ident, c in cls_of.items():
        lut[ident] = c
    return lut[ids]


# ── tiles on disk ───────────────────────────────────────────────────────────────────


def _write_shared_tiles(
    root: Path, tx: int, ty: int, side: int, ids: np.ndarray,
) -> list[tuple[int, int]]:
    """Split a core's instance and coverage rasters onto the global TILE px grid.

    Cores are aligned to that grid (``side`` is a whole number of tiles), so no two cores share a
    tile and each is written outright.
    """
    written: list[tuple[int, int]] = []
    for (x, y), sl in _tiles_of(tx, ty, side):
        sub = pad_tile(ids[sl])
        write_instance_tile(root, 0, x, y, sub)
        # At level 0 a pixel is nucleus or it is not; coverage only becomes a fraction on the way
        # up the pyramid. Written anyway so every level has the same set of planes and the renderer
        # needs no special case for the finest one. Derived from the ids and not from a class
        # raster: how much of a pixel is nucleus is not a question a naming gets to answer.
        write_cover_tile(root, 0, x, y, ((sub != 0) * 255).astype(np.uint8))
        written.append((x, y))
    return written


def _write_class_tiles(
    root: Path, taxonomy: str, tx: int, ty: int, side: int, idx: np.ndarray,
) -> list[tuple[int, int]]:
    written: list[tuple[int, int]] = []
    for (x, y), sl in _tiles_of(tx, ty, side):
        write_class_tile(root, taxonomy, 0, x, y, pad_tile(idx[sl]))
        written.append((x, y))
    return written


def _read_core_ids(root: Path, tx: int, ty: int, side: int) -> np.ndarray | None:
    """Reassemble a core's level-0 instance raster from its stored tiles. None when undrawn."""
    out = np.zeros((side, side), dtype=np.uint32)
    found = False
    for (x, y), sl in _tiles_of(tx, ty, side):
        tile = read_instance_tile(root, 0, x, y)
        if tile is None:
            continue
        found = True
        out[sl] = tile[:sl[0].stop - sl[0].start, :sl[1].stop - sl[1].start]
    return out if found else None


def _tiles_of(tx: int, ty: int, side: int):
    """The level-0 tile coordinates a core spans, paired with their slice of a core-sized array."""
    ox, oy = tx * side, ty * side
    if ox % TILE or oy % TILE:
        raise RuntimeError(f"core origin ({ox},{oy}) is not tile-aligned")
    for dy in range(0, side, TILE):
        for dx in range(0, side, TILE):
            yield ((ox + dx) // TILE, (oy + dy) // TILE), (
                slice(dy, min(dy + TILE, side)), slice(dx, min(dx + TILE, side)),
            )


# ── what needs redrawing ────────────────────────────────────────────────────────────


def _needs_redraw(
    root: Path, *, cov: Coverage, s: int, computed: list[tuple[int, int]], has_picture=None,
) -> list[tuple[int, int]]:
    seen = has_picture or (lambda c: _has_picture(root, c, s))
    dirty: set[tuple[int, int]] = set()
    for core in computed:
        dirty.add(core)
        dirty.update(n for n in _neighbours(core) if cov.has(*n))
    dirty.update(c for c in cov.done if not seen(c))
    return sorted(dirty)


def _neighbours(core: tuple[int, int]) -> list[tuple[int, int]]:
    tx, ty = core
    return [(tx + dx, ty + dy) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dx or dy]


def _neighbourhood(tx: int, ty: int) -> list[tuple[int, int]]:
    """A core and its eight neighbours — everything whose nuclei can reach into it."""
    return [(tx, ty), *_neighbours((tx, ty))]


def _has_picture(root: Path, core: tuple[int, int], s: int) -> bool:
    """Whether this core's shared raster exists, judged by its first level-0 instance tile."""
    return instance_tile_path(root, 0, *_first_tile(core, s)).is_file()


def _has_class_picture(root: Path, taxonomy: str, core: tuple[int, int], s: int) -> bool:
    """The same question for one taxonomy's plane — a classify job that died mid-redraw."""
    return class_tile_path(root, taxonomy, 0, *_first_tile(core, s)).is_file()


def _first_tile(core: tuple[int, int], s: int) -> tuple[int, int]:
    tx, ty = core
    side = CORE // s
    return tx * side // TILE, ty * side // TILE


def _touches(pts: np.ndarray, side: int) -> bool:
    """Whether a ring's bounding box reaches the core at all — the cheap reject for the 8 in 9
    neighbouring nuclei that do not."""
    lo = pts.min(axis=0)
    hi = pts.max(axis=0)
    return bool(hi[0] >= 0 and hi[1] >= 0 and lo[0] <= side and lo[1] <= side)


def _ceil_div(a: int, b: int) -> int:
    return (a + b - 1) // b


__all__ = [
    "MAX_LEVEL_OFFSET", "draw_one_class_core", "draw_one_core", "rasterise_artifact",
    "rasterise_class_core", "rasterise_core", "rasterise_labels", "scale_for",
]
