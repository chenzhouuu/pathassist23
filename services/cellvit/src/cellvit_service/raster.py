"""Draw the stored rings into the class raster (Inc 5, ticket 06).

The picture is derived, always, from `cells/`. Nothing here is a source of truth: delete the whole
`classes/` tree and the next job redraws it from the vectors, with the same nuclei and the same
classes. That is what makes the acceptance criterion checkable — the count in the report and the
shape on screen cannot come from two different objects, because there is only one object (D3).

Two things make this less trivial than "fill each polygon":

**Seams.** A core owns the nuclei whose *centroid* falls inside it, so a nucleus near a seam is
stored whole by one core and overhangs its neighbour. Painting only the cores' own nuclei would
therefore cut every straddling nucleus off at a straight line, and those lines would form a visible
2048 px grid. So a core is drawn from the vector truth of its 3x3 neighbourhood and then cropped:
whatever overhangs into it gets painted, whoever owns it. Nothing is written twice, no tile is
read-modify-written, and the result does not depend on the order the cores were computed in.

**Staleness.** Because a core's picture depends on its neighbours' vectors, computing a new core
invalidates the pictures of the covered neighbours around it. The redraw set is therefore the new
cores, plus their already-covered neighbours, plus any covered core with no picture at all — the
last clause is what makes this self-healing: an artifact built before the raster existed, or one
whose job died mid-redraw, gets its picture on the next run without anybody having to notice.
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
    read_cell_arrays,
)
from .pannuke import class_ids
from .pyramid import (
    build_levels,
    build_levels_above,
    levels_for,
    pad_tile,
    write_class_tile,
    write_cover_tile,
    write_instance_tile,
)

logger = logging.getLogger(__name__)

# Class ids that have a palette entry, and therefore a picture.
DRAWABLE = frozenset(class_ids())

# Above this the stored core (CORE >> offset) stops being a whole number of TILE px tiles, and
# cores would start sharing tiles. Nuclei are stored at 0.25 µm/px, so real slides use 0 or 1.
MAX_LEVEL_OFFSET = 3


def scale_for(offset: int) -> int:
    """Level-0 px per stored px, refusing an offset that would put two cores in one tile."""
    if offset > MAX_LEVEL_OFFSET:
        raise RuntimeError(f"level offset {offset} would put more than one core in a tile")
    return 1 << offset


def draw_one_core(root: Path, tx: int, ty: int, *, s: int, n_levels: int) -> None:
    """Draw a core and refresh the pyramid above it — the *live* picture, during a run.

    A whole-slide run is hours long, so a picture that only appeared at the end would not be a
    picture of anything you could watch. This draws each core as it lands and pushes it up the
    pyramid along its own ancestor chain, which is bounded work per core.

    It is a preview, and knowingly incomplete: the cores to this one's right and below have not
    been computed yet, so the nuclei that will overhang from them are missing and this core's
    right and bottom seams are provisional. The finalisation pass in `rasterise_artifact` redraws
    them once the neighbours exist, which is what makes the finished artifact seamless.
    """
    tiles = rasterise_core(root, tx, ty, s=s)
    build_levels_above(root, n_levels, tiles)


def rasterise_artifact(
    root: Path, *, cov: Coverage, offset: int, width: int, height: int,
    computed: list[tuple[int, int]] | None = None,
) -> int:
    """Redraw whatever the new cores invalidated, then rebuild the pyramid. Returns cores drawn.

    Run once at the end of a job. Every core here has already been drawn as it landed; what this
    fixes is the seams, where a core drawn before its neighbour existed is missing that
    neighbour's overhang. It also picks up any covered core with no picture at all — an artifact
    built before the raster existed, or a job that died mid-redraw.
    """
    s = scale_for(offset)

    todo = _needs_redraw(root, cov=cov, s=s, computed=computed or [])
    for tx, ty in todo:
        rasterise_core(root, tx, ty, s=s)
    if todo:
        logger.info("nuclei raster: redrew %d core(s)", len(todo))

    build_levels(root, levels_for(_ceil_div(width, s), _ceil_div(height, s)))
    return len(todo)


def _needs_redraw(root: Path, *, cov: Coverage, s: int,
                  computed: list[tuple[int, int]]) -> list[tuple[int, int]]:
    dirty: set[tuple[int, int]] = set()
    for core in computed:
        dirty.add(core)
        dirty.update(n for n in _neighbours(core) if cov.has(*n))
    dirty.update(c for c in cov.done if not _has_picture(root, c, s))
    return sorted(dirty)


def _neighbours(core: tuple[int, int]) -> list[tuple[int, int]]:
    tx, ty = core
    return [(tx + dx, ty + dy)
            for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dx or dy]


def _has_picture(root: Path, core: tuple[int, int], s: int) -> bool:
    """Whether this core's rasters exist, judged by its first level-0 tile of each.

    Both planes, not just the class one: an artifact drawn before the instance raster existed has
    class tiles and no ids, and it should be redrawn rather than left half-pictured. The same
    clause that made the raster self-healing in the first place (see the module docstring) is what
    picks that up, with no migration.
    """
    tx, ty = core
    side = CORE // s
    x, y = tx * side // TILE, ty * side // TILE
    return (class_tile_path(root, 0, x, y).is_file()
            and instance_tile_path(root, 0, x, y).is_file())


def rasterise_core(root: Path, tx: int, ty: int, *, s: int) -> list[tuple[int, int]]:
    """Draw one core's picture from its own rings and every neighbour's that reaches into it.

    **One drawing pass, two rasters.** What gets filled is the nucleus's *instance id*; the class
    raster is then a lookup from id to class over that array. Drawing twice would be the obvious
    alternative and is worse in both directions: it doubles the polygon fills, and where two nuclei
    overlap it leaves the two rasters free to disagree about which one owns a pixel. Derived this
    way they cannot — the shapes are the same shapes, because they are the same array (D3 again,
    one level down).

    Returns the level-0 tile coordinates it wrote, so the caller can refresh their ancestors.
    """
    side = CORE // s
    # "I" is PIL's 32-bit integer mode: ids go in directly, with no palette to run out of.
    canvas = Image.new("I", (side, side), 0)
    draw = ImageDraw.Draw(canvas)
    origin = np.array([tx * CORE, ty * CORE], dtype=np.float64)
    cls_of: dict[int, int] = {}

    for nx, ny in [(tx, ty), *_neighbours((tx, ty))]:
        cells = read_cell_arrays(cells_path(root, nx, ny))
        if cells is None:
            continue
        off, ring_xy = cells["ring_off"], (cells["ring_xy"] - origin) / s
        for i, (c, ident) in enumerate(zip(cells["cls"].tolist(), cells["inst"].tolist(),
                                           strict=True)):
            if c not in DRAWABLE:
                # An id the taxonomy does not name has no colour, and filling it with 0 would
                # erase whatever neighbour was already drawn there. It stays out of the picture
                # and stays in the counts, where it is reported as "Unknown".
                continue
            pts = ring_xy[off[i]:off[i + 1]]
            if len(pts) < 3 or not _touches(pts, side):
                continue
            draw.polygon([(float(px), float(py)) for px, py in pts], fill=int(ident))
            cls_of[int(ident)] = c

    ids = np.asarray(canvas, dtype=np.uint32)
    return _write_core_tiles(root, tx, ty, side, ids, _class_raster(ids, cls_of))


def _class_raster(ids: np.ndarray, cls_of: dict[int, int]) -> np.ndarray:
    """Instance raster → class raster, through a lookup table indexed by id.

    A table rather than a loop over the ids present: a dense core holds thousands of nuclei, and
    masking the array once per nucleus would be thousands of passes over four million pixels. The
    table is one byte per id up to the largest one drawn here, which is a few MB at whole-slide
    scale.
    """
    if not cls_of:
        return np.zeros(ids.shape, dtype=np.uint8)
    lut = np.zeros(max(cls_of) + 1, dtype=np.uint8)
    for ident, c in cls_of.items():
        lut[ident] = c
    return lut[np.clip(ids, 0, len(lut) - 1)]


def _touches(pts: np.ndarray, side: int) -> bool:
    """Whether a ring's bounding box reaches the core at all — the cheap reject for the 8 in 9
    neighbouring nuclei that do not."""
    lo = pts.min(axis=0)
    hi = pts.max(axis=0)
    return bool(hi[0] >= 0 and hi[1] >= 0 and lo[0] <= side and lo[1] <= side)


def _write_core_tiles(root: Path, tx: int, ty: int, side: int, ids: np.ndarray,
                      idx: np.ndarray) -> list[tuple[int, int]]:
    """Split a core's rasters onto the global TILE px grid.

    Cores are aligned to that grid (``side`` is a whole number of tiles), so no two cores share a
    tile and each is written outright.
    """
    ox, oy = tx * side, ty * side
    if ox % TILE or oy % TILE:
        raise RuntimeError(f"core origin ({ox},{oy}) is not tile-aligned")
    written: list[tuple[int, int]] = []
    for dy in range(0, side, TILE):
        for dx in range(0, side, TILE):
            sub = pad_tile(idx[dy:dy + TILE, dx:dx + TILE])
            x, y = (ox + dx) // TILE, (oy + dy) // TILE
            write_class_tile(root, 0, x, y, sub)
            write_instance_tile(root, 0, x, y, pad_tile(ids[dy:dy + TILE, dx:dx + TILE]))
            # At level 0 a pixel is nucleus or it is not; coverage only becomes a fraction on the
            # way up the pyramid. Written anyway so every level has the same set of planes and
            # the renderer needs no special case for the finest one.
            write_cover_tile(root, 0, x, y, ((sub != 0) * 255).astype(np.uint8))
            written.append((x, y))
    return written


def _ceil_div(a: int, b: int) -> int:
    return (a + b - 1) // b


__all__ = ["MAX_LEVEL_OFFSET", "draw_one_core", "rasterise_artifact", "rasterise_core"]
