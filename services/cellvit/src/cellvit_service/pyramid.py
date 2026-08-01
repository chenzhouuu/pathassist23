"""Tile pyramid I/O for the nuclei raster (Inc 5, ticket 06).

Two planes per tile, and the pair is the whole design:

- **classes** — a paletted nominal raster (0 = no nucleus, i = the PanNuke class id).
- **cover**   — how much of each pixel is nucleus, 0..255. At level 0 it is binary; it stops being
  binary the moment you zoom out.

Why a second plane at all. A nucleus is ~40 px across at 0.25 µm/px and the pyramid runs to a
single tile, so by level 5 one stored pixel spans several whole nuclei. Neither of the obvious
downsampling rules survives that:

- *non-background first* (what the tissue map uses, so that a tissue hole never widens as you zoom
  out) would make a densely nucleated field render as a solid slab of colour by level 3 — nuclei
  would appear to fill tissue they occupy a third of.
- *plain mode* would do the opposite: below ~50 % density the background wins every 2x2 and the
  nuclei simply evaporate, so packed tumour and empty stroma both come out blank.

Splitting the two questions fixes both. **Which class** is answered by the mode over the
non-background children, so class identity survives; **how much** is answered by the mean of the
children's coverage, so density survives. The renderer multiplies alpha by coverage, and zooming
out turns a field of discrete nuclei into a continuous density of the right colour instead of
either a slab or a blank.
"""

from pathlib import Path

import numpy as np
from PIL import Image

from .artifacts import TILE, class_tile_path, cover_tile_path
from .pannuke import BACKGROUND_INDEX, class_ids, palette_bytes


def levels_for(width: int, height: int, tile: int = TILE) -> int:
    """Number of pyramid levels so the top level fits in one tile. Level 0 is finest."""
    n = 1
    w, h = int(width), int(height)
    while w > tile or h > tile:
        w = (w + 1) // 2
        h = (h + 1) // 2
        n += 1
    return n


# ── classes ────────────────────────────────────────────────────────────────────────

def write_class_tile(root: Path, z: int, x: int, y: int, idx: np.ndarray) -> None:
    """Write a paletted PNG whose index 0 (no nucleus) is transparent."""
    path = class_tile_path(root, z, x, y)
    path.parent.mkdir(parents=True, exist_ok=True)
    im = Image.fromarray(np.ascontiguousarray(idx, dtype=np.uint8), mode="P")
    im.putpalette(palette_bytes())
    tmp = path.with_suffix(".png.tmp")
    im.save(tmp, format="PNG", transparency=BACKGROUND_INDEX, optimize=True)
    tmp.replace(path)


def read_class_tile(root: Path, z: int, x: int, y: int) -> np.ndarray | None:
    """The raw palette-index array for a tile, or None when it was never written."""
    path = class_tile_path(root, z, x, y)
    if not path.is_file():
        return None
    with Image.open(path) as im:
        return np.array(im.convert("P"), dtype=np.uint8)


def downsample_class(idx: np.ndarray) -> np.ndarray:
    """2x2 mode over the *non-background* children (ties → lowest class id); 0 if all background.

    Deliberately not weighted by area: at a level where two classes share a pixel, the question
    the colour answers is "which kind of nucleus is this", and the amount is the cover plane's job.
    """
    a = _pad_to_even(idx)
    h, w = a.shape
    quads = a.reshape(h // 2, 2, w // 2, 2).transpose(0, 2, 1, 3).reshape(h // 2, w // 2, 4)

    ids = class_ids()
    counts = np.zeros(quads.shape[:2] + (len(ids),), dtype=np.uint8)
    for k, cid in enumerate(ids):
        counts[..., k] = (quads == cid).sum(axis=2)

    best = np.take(np.array(ids, dtype=np.uint8), counts.argmax(axis=2))
    any_fg = counts.sum(axis=2) > 0
    return np.where(any_fg, best, BACKGROUND_INDEX).astype(np.uint8)


# ── coverage ───────────────────────────────────────────────────────────────────────

def write_cover_tile(root: Path, z: int, x: int, y: int, cover: np.ndarray) -> None:
    """Write the coverage plane as a plain 8-bit greyscale PNG."""
    path = cover_tile_path(root, z, x, y)
    path.parent.mkdir(parents=True, exist_ok=True)
    im = Image.fromarray(np.ascontiguousarray(cover, dtype=np.uint8), mode="L")
    tmp = path.with_suffix(".png.tmp")
    im.save(tmp, format="PNG", optimize=True)
    tmp.replace(path)


def read_cover_tile(root: Path, z: int, x: int, y: int) -> np.ndarray | None:
    path = cover_tile_path(root, z, x, y)
    if not path.is_file():
        return None
    with Image.open(path) as im:
        return np.array(im.convert("L"), dtype=np.uint8)


def downsample_cover(cover: np.ndarray) -> np.ndarray:
    """2x2 mean — coverage is a fraction, and the mean is what a fraction aggregates to."""
    a = _pad_to_even(cover).astype(np.uint16)
    h, w = a.shape
    return a.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3)).astype(np.uint8)


# ── the pyramid ────────────────────────────────────────────────────────────────────

def build_levels(root: Path, n_levels: int) -> None:
    """Rebuild every coarse level from the level below, for whatever tiles exist.

    A full rebuild rather than an incremental patch, for the reason the tissue map's copy of this
    gives: a coarse tile can have children from more than one job, and the arithmetic that works
    out which parents a new core touched is exactly the kind of thing that is wrong once and then
    wrong forever in the picture. Each level is a quarter of the one below, so it is cheap.
    """
    for z in range(1, n_levels):
        child_dir = root / "classes" / str(z - 1)
        if not child_dir.is_dir():
            break
        parents: set[tuple[int, int]] = set()
        for p in child_dir.glob("*.png"):
            cx, _, cy = p.stem.partition("_")
            parents.add((int(cx) // 2, int(cy) // 2))
        for px, py in sorted(parents):
            _build_parent(root, z, px, py)


def build_levels_above(root: Path, n_levels: int, tiles: list[tuple[int, int]]) -> None:
    """Rebuild only the ancestors of `tiles` (level-0 coordinates), all the way to the top.

    Exact, not an approximation: a parent is always built by reading all four of its children off
    disk, so refreshing one chain cannot miss a sibling that another core wrote. It exists beside
    the full rebuild because it is what a *running* job can afford — the whole pyramid every core
    would be quadratic, and then a whole-slide run would show nothing until it finished.
    """
    live = {(int(x), int(y)) for x, y in tiles}
    for z in range(1, n_levels):
        parents = {(x // 2, y // 2) for x, y in live}
        for px, py in sorted(parents):
            _build_parent(root, z, px, py)
        live = parents


def _build_parent(root: Path, z: int, px: int, py: int) -> None:
    cls = np.zeros((TILE * 2, TILE * 2), dtype=np.uint8)
    cov = np.zeros((TILE * 2, TILE * 2), dtype=np.uint8)
    found = False
    for dy in (0, 1):
        for dx in (0, 1):
            child = read_class_tile(root, z - 1, px * 2 + dx, py * 2 + dy)
            if child is None:
                continue
            found = True
            sl = (slice(dy * TILE, (dy + 1) * TILE), slice(dx * TILE, (dx + 1) * TILE))
            cls[sl] = pad_tile(child)
            child_cov = read_cover_tile(root, z - 1, px * 2 + dx, py * 2 + dy)
            # A class tile with no cover tile beside it can only be a half-written pair; treat the
            # nucleus pixels as fully covered rather than dropping the tile from the picture.
            cov[sl] = pad_tile(child_cov) if child_cov is not None else (cls[sl] != 0) * 255
    if not found:
        return
    write_class_tile(root, z, px, py, downsample_class(cls))
    write_cover_tile(root, z, px, py, downsample_cover(cov))


# ── shared ─────────────────────────────────────────────────────────────────────────

def pad_tile(a: np.ndarray, tile: int = TILE) -> np.ndarray:
    """Pad a partial edge tile out to the full tile with zeros (= no nucleus)."""
    if a.shape == (tile, tile):
        return a
    out = np.zeros((tile, tile), dtype=a.dtype)
    out[:a.shape[0], :a.shape[1]] = a
    return out


def _pad_to_even(a: np.ndarray) -> np.ndarray:
    """Edge-pad an odd side by one so a 2x2 reshape is exact (last row/col duplicated)."""
    ph = a.shape[0] % 2
    pw = a.shape[1] % 2
    if not ph and not pw:
        return a
    return np.pad(a, ((0, ph), (0, pw)), mode="edge")


__all__ = [
    "build_levels", "build_levels_above", "downsample_class", "downsample_cover", "levels_for",
    "pad_tile",
    "read_class_tile", "read_cover_tile", "write_class_tile", "write_cover_tile",
]
