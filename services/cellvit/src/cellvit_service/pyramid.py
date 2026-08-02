"""Tile pyramid I/O for the nuclei raster (Inc 5 ticket 06, split by taxonomy in Inc 7).

Three planes, and which of them belongs to whom is the whole of Inc 7's storage change:

- **instances** — one nucleus, one id. Shared: an outline is an outline whatever it is called.
- **cover**     — how much of each pixel is nucleus, 0..255. Shared, for the same reason.
- **classes**   — a paletted nominal raster (0 = no nucleus, i = a *stored* class id). One per
  taxonomy, under `labels/{taxonomy}/classes/`, because this is the only plane a naming changes.

Why a coverage plane at all. A nucleus is ~40 px across at 0.25 µm/px and the pyramid runs to a
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

from collections.abc import Callable
from pathlib import Path

import numpy as np
from PIL import Image

from .artifacts import (
    TILE,
    class_tile_path,
    cover_tile_path,
    instance_tile_path,
    label_dir,
)
from .taxonomy import BACKGROUND_INDEX
from .taxonomy import get as get_taxonomy


def levels_for(width: int, height: int, tile: int = TILE) -> int:
    """Number of pyramid levels so the top level fits in one tile. Level 0 is finest."""
    n = 1
    w, h = int(width), int(height)
    while w > tile or h > tile:
        w = (w + 1) // 2
        h = (h + 1) // 2
        n += 1
    return n


# ── classes (one plane per taxonomy) ────────────────────────────────────────────────

def write_class_tile(root: Path, taxonomy: str, z: int, x: int, y: int, idx: np.ndarray) -> None:
    """Write a paletted PNG whose index 0 (no nucleus) is transparent.

    The palette is the taxonomy's own, so the bytes on disk already carry the colour language and
    a recolour cannot drift from the map it describes.
    """
    path = class_tile_path(root, taxonomy, z, x, y)
    path.parent.mkdir(parents=True, exist_ok=True)
    im = Image.fromarray(np.ascontiguousarray(idx, dtype=np.uint8), mode="P")
    im.putpalette(get_taxonomy(taxonomy).palette_bytes())
    tmp = path.with_suffix(".png.tmp")
    im.save(tmp, format="PNG", transparency=BACKGROUND_INDEX, optimize=True)
    tmp.replace(path)


def read_class_tile(root: Path, taxonomy: str, z: int, x: int, y: int) -> np.ndarray | None:
    """The raw palette-index array for a tile, or None when it was never written."""
    path = class_tile_path(root, taxonomy, z, x, y)
    if not path.is_file():
        return None
    with Image.open(path) as im:
        return np.array(im.convert("P"), dtype=np.uint8)


def downsample_class(idx: np.ndarray, ids: list[int]) -> np.ndarray:
    """2x2 mode over the *non-background* children (ties → lowest class id); 0 if all background.

    Deliberately not weighted by area: at a level where two classes share a pixel, the question
    the colour answers is "which kind of nucleus is this", and the amount is the cover plane's job.
    """
    a = _pad_to_even(idx)
    h, w = a.shape
    quads = a.reshape(h // 2, 2, w // 2, 2).transpose(0, 2, 1, 3).reshape(h // 2, w // 2, 4)

    counts = np.zeros(quads.shape[:2] + (len(ids),), dtype=np.uint8)
    for k, cid in enumerate(ids):
        counts[..., k] = (quads == cid).sum(axis=2)

    best = np.take(np.array(ids, dtype=np.uint8), counts.argmax(axis=2))
    any_fg = counts.sum(axis=2) > 0
    return np.where(any_fg, best, BACKGROUND_INDEX).astype(np.uint8)


# ── instances (shared) ─────────────────────────────────────────────────────────────
#
# One nucleus, one id, packed little-endian into RGB with alpha as the mask — the OME-NGFF
# `labels` convention carried in the format a tile server can actually send. 24 bits is ~16.7 M
# nuclei per slide against a real whole slide's ~1–10 M, and keeping alpha out of the number is
# what lets a reader tell "id 0" from "no nucleus" without a second plane.
#
# The stored value is exact. Making neighbouring ids *look* different is the renderer's job
# (tiles.colourise_instances), because consecutive ids differ by one and would otherwise paint a
# smooth gradient across a field of separate cells.

_ID_MAX = (1 << 24) - 1


def pack_instances(ids: np.ndarray) -> np.ndarray:
    """uint32 label raster → uint8 RGBA. 0 stays fully transparent."""
    a = np.ascontiguousarray(ids, dtype=np.uint32)
    if a.max(initial=0) > _ID_MAX:
        raise RuntimeError(f"instance id {int(a.max())} does not fit in 24 bits")
    rgba = np.zeros(a.shape + (4,), dtype=np.uint8)
    rgba[..., 0] = a & 0xFF
    rgba[..., 1] = (a >> 8) & 0xFF
    rgba[..., 2] = (a >> 16) & 0xFF
    rgba[..., 3] = np.where(a > 0, 255, 0)
    return rgba


def unpack_instances(rgba: np.ndarray) -> np.ndarray:
    """The inverse. Alpha is the mask, so a transparent pixel reads back as id 0."""
    a = rgba.astype(np.uint32)
    ids = a[..., 0] | (a[..., 1] << 8) | (a[..., 2] << 16)
    return np.where(a[..., 3] > 0, ids, 0).astype(np.uint32)


def write_instance_tile(root: Path, z: int, x: int, y: int, ids: np.ndarray) -> None:
    path = instance_tile_path(root, z, x, y)
    path.parent.mkdir(parents=True, exist_ok=True)
    im = Image.fromarray(pack_instances(ids), mode="RGBA")
    tmp = path.with_suffix(".png.tmp")
    im.save(tmp, format="PNG", optimize=True)
    tmp.replace(path)


def read_instance_tile(root: Path, z: int, x: int, y: int) -> np.ndarray | None:
    path = instance_tile_path(root, z, x, y)
    if not path.is_file():
        return None
    with Image.open(path) as im:
        return unpack_instances(np.array(im.convert("RGBA"), dtype=np.uint8))


def downsample_instance(ids: np.ndarray) -> np.ndarray:
    """2x2 mode over the non-background children; ties → lowest id.

    The same rule as the class plane and for the same reason: an id is nominal, and the mean of
    two ids is a third nucleus that does not exist. What is lost going up is which of two touching
    cells won a pixel, which is not a question anyone asks at a zoom where a cell is one pixel.
    """
    a = _pad_to_even(ids).astype(np.uint32)
    h, w = a.shape
    quads = a.reshape(h // 2, 2, w // 2, 2).transpose(0, 2, 1, 3).reshape(h // 2, w // 2, 4)
    quads = np.sort(quads, axis=2)                       # ties resolve to the lowest id

    best = np.zeros(quads.shape[:2], dtype=np.uint32)
    best_n = np.zeros(quads.shape[:2], dtype=np.uint8)
    for k in range(4):
        v = quads[..., k]
        n = (quads == v[..., None]).sum(axis=2).astype(np.uint8)
        take = (v > 0) & (n > best_n)
        best = np.where(take, v, best)
        best_n = np.where(take, n, best_n)
    return best


# ── coverage (shared) ───────────────────────────────────────────────────────────────

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
#
# Four entry points from two shapes. *Full* rebuilds run once at the end of a job, for the reason
# the tissue map's copy of this gives: a coarse tile can have children from more than one job, and
# the arithmetic that works out which parents a new core touched is exactly the kind of thing that
# is wrong once and then wrong forever in the picture. *Above* rebuilds run per core during a job,
# because the whole pyramid every core would be quadratic and a whole-slide run would then show
# nothing until it finished. Both build a parent by reading all four children off disk, so neither
# can miss a sibling another core wrote.

_Build = Callable[[int, int, int], None]


def _rebuild_all(child_dir: Callable[[int], Path], build: _Build, n_levels: int) -> None:
    for z in range(1, n_levels):
        d = child_dir(z - 1)
        if not d.is_dir():
            break
        parents: set[tuple[int, int]] = set()
        for p in d.glob("*.png"):
            cx, _, cy = p.stem.partition("_")
            parents.add((int(cx) // 2, int(cy) // 2))
        for px, py in sorted(parents):
            build(z, px, py)


def _rebuild_above(build: _Build, n_levels: int, tiles: list[tuple[int, int]]) -> None:
    live = {(int(x), int(y)) for x, y in tiles}
    for z in range(1, n_levels):
        parents = {(x // 2, y // 2) for x, y in live}
        for px, py in sorted(parents):
            build(z, px, py)
        live = parents


def build_levels(root: Path, n_levels: int) -> None:
    """Rebuild every coarse level of the **shared** planes — instances and cover."""
    _rebuild_all(lambda z: root / "cover" / str(z),
                 lambda z, px, py: _build_shared_parent(root, z, px, py), n_levels)


def build_levels_above(root: Path, n_levels: int, tiles: list[tuple[int, int]]) -> None:
    """Rebuild the shared planes' ancestors of `tiles` (level-0 coordinates), to the top."""
    _rebuild_above(lambda z, px, py: _build_shared_parent(root, z, px, py), n_levels, tiles)


def build_class_levels(root: Path, taxonomy: str, n_levels: int) -> None:
    """Rebuild every coarse level of one taxonomy's class plane."""
    base = label_dir(root, taxonomy) / "classes"
    _rebuild_all(lambda z: base / str(z),
                 lambda z, px, py: _build_class_parent(root, taxonomy, z, px, py), n_levels)


def build_class_levels_above(
    root: Path, taxonomy: str, n_levels: int, tiles: list[tuple[int, int]],
) -> None:
    """Rebuild one taxonomy's class-plane ancestors of `tiles`, to the top."""
    _rebuild_above(lambda z, px, py: _build_class_parent(root, taxonomy, z, px, py),
                   n_levels, tiles)


def _build_shared_parent(root: Path, z: int, px: int, py: int) -> None:
    cov = np.zeros((TILE * 2, TILE * 2), dtype=np.uint8)
    ids = np.zeros((TILE * 2, TILE * 2), dtype=np.uint32)
    found = False
    for dy in (0, 1):
        for dx in (0, 1):
            child_cov = read_cover_tile(root, z - 1, px * 2 + dx, py * 2 + dy)
            if child_cov is None:
                continue
            found = True
            sl = (slice(dy * TILE, (dy + 1) * TILE), slice(dx * TILE, (dx + 1) * TILE))
            cov[sl] = pad_tile(child_cov)
            child_ids = read_instance_tile(root, z - 1, px * 2 + dx, py * 2 + dy)
            if child_ids is not None:
                ids[sl] = pad_tile(child_ids)
    if not found:
        return
    write_cover_tile(root, z, px, py, downsample_cover(cov))
    if ids.any():
        write_instance_tile(root, z, px, py, downsample_instance(ids))


def _build_class_parent(root: Path, taxonomy: str, z: int, px: int, py: int) -> None:
    cls = np.zeros((TILE * 2, TILE * 2), dtype=np.uint8)
    found = False
    for dy in (0, 1):
        for dx in (0, 1):
            child = read_class_tile(root, taxonomy, z - 1, px * 2 + dx, py * 2 + dy)
            if child is None:
                continue
            found = True
            sl = (slice(dy * TILE, (dy + 1) * TILE), slice(dx * TILE, (dx + 1) * TILE))
            cls[sl] = pad_tile(child)
    if not found:
        return
    write_class_tile(root, taxonomy, z, px, py,
                     downsample_class(cls, get_taxonomy(taxonomy).class_ids))


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
    "build_class_levels", "build_class_levels_above", "build_levels", "build_levels_above",
    "downsample_class", "downsample_cover", "downsample_instance", "levels_for", "pack_instances",
    "pad_tile", "read_class_tile", "read_cover_tile", "read_instance_tile", "unpack_instances",
    "write_class_tile", "write_cover_tile", "write_instance_tile",
]
