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

from .artifacts import CORE, TILE, Coverage, cells_path, class_tile_path, read_cells
from .pannuke import class_ids
from .pyramid import build_levels, levels_for, pad_tile, write_class_tile, write_cover_tile

logger = logging.getLogger(__name__)

# Class ids that have a palette entry, and therefore a picture.
DRAWABLE = frozenset(class_ids())

# Above this the stored core (CORE >> offset) stops being a whole number of TILE px tiles, and
# cores would start sharing tiles. Nuclei are stored at 0.25 µm/px, so real slides use 0 or 1.
MAX_LEVEL_OFFSET = 3


def rasterise_artifact(
    root: Path, *, cov: Coverage, offset: int, width: int, height: int,
    computed: list[tuple[int, int]] | None = None,
) -> int:
    """Redraw whatever the new cores invalidated, then rebuild the pyramid. Returns cores drawn.

    Called once at the end of a job rather than per core, because a core drawn before its
    neighbour existed would have to be drawn again anyway.
    """
    if offset > MAX_LEVEL_OFFSET:
        raise RuntimeError(f"level offset {offset} would put more than one core in a tile")
    s = 1 << offset

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
    """Whether this core's raster exists, judged by its first level-0 tile."""
    tx, ty = core
    side = CORE // s
    return class_tile_path(root, 0, tx * side // TILE, ty * side // TILE).is_file()


def rasterise_core(root: Path, tx: int, ty: int, *, s: int) -> None:
    """Draw one core's picture from its own rings and every neighbour's that reaches into it."""
    side = CORE // s
    canvas = Image.new("L", (side, side), 0)
    draw = ImageDraw.Draw(canvas)
    origin = np.array([tx * CORE, ty * CORE], dtype=np.float64)

    for nx, ny in [(tx, ty), *_neighbours((tx, ty))]:
        cells = read_cells(cells_path(root, nx, ny))
        if cells is None:
            continue
        for ring, cls in zip(cells["rings"], cells["cls"].tolist(), strict=True):
            if int(cls) not in DRAWABLE:
                # An id the taxonomy does not name has no colour, and filling it with 0 would
                # erase whatever neighbour was already drawn there. It stays out of the picture
                # and stays in the counts, where it is reported as "Unknown".
                continue
            pts = (np.asarray(ring, dtype=np.float64) - origin) / s
            if len(pts) < 3 or not _touches(pts, side):
                continue
            draw.polygon([(float(px), float(py)) for px, py in pts], fill=int(cls))

    idx = np.asarray(canvas, dtype=np.uint8)
    _write_core_tiles(root, tx, ty, side, idx)


def _touches(pts: np.ndarray, side: int) -> bool:
    """Whether a ring's bounding box reaches the core at all — the cheap reject for the 8 in 9
    neighbouring nuclei that do not."""
    lo = pts.min(axis=0)
    hi = pts.max(axis=0)
    return bool(hi[0] >= 0 and hi[1] >= 0 and lo[0] <= side and lo[1] <= side)


def _write_core_tiles(root: Path, tx: int, ty: int, side: int, idx: np.ndarray) -> None:
    """Split a core's raster onto the global TILE px grid.

    Cores are aligned to that grid (``side`` is a whole number of tiles), so no two cores share a
    tile and each is written outright.
    """
    ox, oy = tx * side, ty * side
    if ox % TILE or oy % TILE:
        raise RuntimeError(f"core origin ({ox},{oy}) is not tile-aligned")
    for dy in range(0, side, TILE):
        for dx in range(0, side, TILE):
            sub = pad_tile(idx[dy:dy + TILE, dx:dx + TILE])
            write_class_tile(root, 0, (ox + dx) // TILE, (oy + dy) // TILE, sub)
            # At level 0 a pixel is nucleus or it is not; coverage only becomes a fraction on the
            # way up the pyramid. Written anyway so every level has the same pair of planes and
            # the renderer needs no special case for the finest one.
            write_cover_tile(root, 0, (ox + dx) // TILE, (oy + dy) // TILE,
                             ((sub != 0) * 255).astype(np.uint8))


def _ceil_div(a: int, b: int) -> int:
    return (a + b - 1) // b


__all__ = ["MAX_LEVEL_OFFSET", "rasterise_artifact", "rasterise_core"]
