"""Tile pyramid I/O for the two raster layers (Inc 4, design §4.2/§5).

Two layers with different natures, and the difference decides how each is downsampled — the same
split Inc 3b made, for the same reason:

- **probs** — one continuous plane per class. Coarser levels are the plain 2x2 **mean**, the
  correct aggregate for a probability. Stored as one ``.npz`` per tile with **one named member per
  class**, so a two-class composite inflates only what it asks for.

- **classes** — a paletted nominal raster (0 = outside tissue, i = ``backend.classes[i-1]``).
  Averaging palette indices is meaningless, so coarser levels use **non-background first, then
  mode**: a pixel is outside-tissue only if all four children are, otherwise it takes the most
  common in-tissue child, ties resolved by the lowest palette index. Tissue regions are large
  enough that a plain mode would survive here, but this rule additionally guarantees the
  outside-tissue mask never grows as you zoom out — a hole that widened with each level would
  read as "the tissue shrank".
"""

from pathlib import Path

import numpy as np
from PIL import Image

from .artifacts import TILE, class_tile_path, prob_tile_path
from .classes import BACKGROUND_INDEX, Backend, palette_bytes


def levels_for(width: int, height: int, tile: int = TILE) -> int:
    """Number of pyramid levels so the top level fits in one tile. Level 0 is finest."""
    n = 1
    w, h = int(width), int(height)
    while w > tile or h > tile:
        w = (w + 1) // 2
        h = (h + 1) // 2
        n += 1
    return n


# ── probabilities ──────────────────────────────────────────────────────────────────

def write_prob_tile(root: Path, z: int, x: int, y: int, planes: dict[str, np.ndarray]) -> None:
    """Write one probability tile as named uint8 members (one per class)."""
    path = prob_tile_path(root, z, x, y)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {k: np.ascontiguousarray(v, dtype=np.uint8) for k, v in planes.items()}
    tmp = path.with_suffix(".npz.tmp")
    with open(tmp, "wb") as fh:
        np.savez_compressed(fh, **payload)
    tmp.replace(path)


def read_prob_tile(root: Path, z: int, x: int, y: int, names: list[str]) -> dict[str, np.ndarray]:
    """Read only ``names`` from a probability tile. Missing tile ⇒ {} (caller renders a hole)."""
    path = prob_tile_path(root, z, x, y)
    if not path.is_file():
        return {}
    out: dict[str, np.ndarray] = {}
    with np.load(path) as zf:
        available = set(zf.files)
        for n in names:
            if n in available:
                out[n] = zf[n]          # only this member is inflated
    return out


def downsample_prob(planes: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """2x2 mean per class — the correct aggregate for a probability."""
    out: dict[str, np.ndarray] = {}
    for k, v in planes.items():
        a = _pad_to_even(v).astype(np.uint16)
        h, w = a.shape
        out[k] = (a.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))).astype(np.uint8)
    return out


# ── classes ────────────────────────────────────────────────────────────────────────

def write_class_tile(root: Path, z: int, x: int, y: int, idx: np.ndarray,
                     backend: Backend) -> None:
    """Write a paletted PNG whose index 0 (outside tissue) is transparent."""
    path = class_tile_path(root, z, x, y)
    path.parent.mkdir(parents=True, exist_ok=True)
    im = Image.fromarray(np.ascontiguousarray(idx, dtype=np.uint8), mode="P")
    im.putpalette(palette_bytes(backend))
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


def downsample_class(idx: np.ndarray, n_classes: int) -> np.ndarray:
    """2x2 non-background-first, then mode (ties → lowest palette index)."""
    a = _pad_to_even(idx)
    h, w = a.shape
    quads = a.reshape(h // 2, 2, w // 2, 2).transpose(0, 2, 1, 3).reshape(h // 2, w // 2, 4)

    counts = np.zeros(quads.shape[:2] + (n_classes,), dtype=np.uint8)
    for k in range(1, n_classes + 1):
        counts[..., k - 1] = (quads == k).sum(axis=2)

    best = counts.argmax(axis=2).astype(np.uint8) + 1      # argmax ties → lowest index
    any_fg = counts.sum(axis=2) > 0
    return np.where(any_fg, best, BACKGROUND_INDEX).astype(np.uint8)


# ── shared ─────────────────────────────────────────────────────────────────────────

def _pad_to_even(a: np.ndarray) -> np.ndarray:
    """Edge-pad an odd side by one so a 2x2 reshape is exact (last row/col duplicated)."""
    ph = a.shape[0] % 2
    pw = a.shape[1] % 2
    if not ph and not pw:
        return a
    return np.pad(a, ((0, ph), (0, pw)), mode="edge")
