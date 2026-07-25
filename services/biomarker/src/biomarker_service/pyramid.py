"""Tile pyramid I/O for the two raster layers (Inc 3b, design §5).

Two layers with different natures, and the difference decides how each is downsampled:

- **markers** — 20 continuous probability planes. Coarser levels are the plain 2x2 **mean**, which
  is the correct aggregate for a probability. Stored as one ``.npz`` per tile with **one named
  member per channel**, so a 4-marker composite inflates ~260 KB instead of the 1.3 MB a stacked
  ``[20,256,256]`` array would force (review S2). This is the hottest path in the service.

- **pheno** — a paletted nominal raster (0 = background, i = PHENOTYPE_ORDER[i-1]). Averaging
  palette indices is meaningless, and averaging *presence* would dissolve nuclei into grey haze,
  because at 0.25 µm/px a nucleus is ~10 % of its tile's pixels: four levels of mean-downsampling
  and every nucleus is gone. Coarser levels therefore use **non-background first, then mode** —
  a pixel is background only if all four children are, otherwise it takes the most common
  non-background child. That is what makes the zoomed-out map a phenotype density field rather
  than an empty screen.
"""

from pathlib import Path

import numpy as np
from PIL import Image

from .artifacts import TILE, marker_tile_path, pheno_tile_path
from .markers import MARKER_CHANNELS, PHENOTYPE_COLORS, PHENOTYPE_ORDER

# Palette index 0 is background/transparent; lineage i sits at index i+1.
BACKGROUND_INDEX = 0


def phenotype_index(name: str) -> int:
    try:
        return PHENOTYPE_ORDER.index(name) + 1
    except ValueError:
        return PHENOTYPE_ORDER.index("Other") + 1


def palette_bytes() -> bytes:
    """A 256*3 PIL palette: index 0 black (made transparent), then the fixed lineage colours."""
    pal = bytearray(768)
    for i, name in enumerate(PHENOTYPE_ORDER, start=1):
        hexed = PHENOTYPE_COLORS[name].lstrip("#")
        pal[i * 3: i * 3 + 3] = bytes.fromhex(hexed)
    return bytes(pal)


def levels_for(width: int, height: int, tile: int = TILE) -> int:
    """Number of pyramid levels so the top level fits in one tile. Level 0 is finest."""
    n = 1
    w, h = int(width), int(height)
    while w > tile or h > tile:
        w = (w + 1) // 2
        h = (h + 1) // 2
        n += 1
    return n


# ── markers ────────────────────────────────────────────────────────────────────────

def write_marker_tile(root: Path, z: int, x: int, y: int, planes: dict[str, np.ndarray]) -> None:
    """Write one marker tile as named uint8 members (one per channel)."""
    path = marker_tile_path(root, z, x, y)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {k: np.ascontiguousarray(v, dtype=np.uint8) for k, v in planes.items()}
    tmp = path.with_suffix(".npz.tmp")
    with open(tmp, "wb") as fh:
        np.savez_compressed(fh, **payload)
    tmp.replace(path)


def read_marker_tile(root: Path, z: int, x: int, y: int, names: list[str]) -> dict[str, np.ndarray]:
    """Read only ``names`` from a marker tile. Missing tile ⇒ {} (caller renders a hole)."""
    path = marker_tile_path(root, z, x, y)
    if not path.is_file():
        return {}
    out: dict[str, np.ndarray] = {}
    with np.load(path) as z_:
        available = set(z_.files)
        for n in names:
            if n in available:
                out[n] = z_[n]          # only this member is inflated
    return out


def downsample_marker(planes: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """2x2 mean per channel — the correct aggregate for a probability."""
    out: dict[str, np.ndarray] = {}
    for k, v in planes.items():
        a = _pad_to_even(v).astype(np.uint16)
        h, w = a.shape
        out[k] = (a.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))).astype(np.uint8)
    return out


# ── phenotype ──────────────────────────────────────────────────────────────────────

def write_pheno_tile(root: Path, z: int, x: int, y: int, idx: np.ndarray) -> None:
    """Write a paletted PNG whose index 0 is transparent."""
    path = pheno_tile_path(root, z, x, y)
    path.parent.mkdir(parents=True, exist_ok=True)
    im = Image.fromarray(np.ascontiguousarray(idx, dtype=np.uint8), mode="P")
    im.putpalette(palette_bytes())
    tmp = path.with_suffix(".png.tmp")
    im.save(tmp, format="PNG", transparency=BACKGROUND_INDEX, optimize=True)
    tmp.replace(path)


def read_pheno_tile(root: Path, z: int, x: int, y: int) -> np.ndarray | None:
    """The raw palette-index array for a tile, or None when it was never written."""
    path = pheno_tile_path(root, z, x, y)
    if not path.is_file():
        return None
    with Image.open(path) as im:
        return np.array(im.convert("P"), dtype=np.uint8)


def downsample_pheno(idx: np.ndarray) -> np.ndarray:
    """2x2 **non-background-first, then mode** (design §5).

    A parent pixel is background only when all four children are. Otherwise it takes the most
    common non-background child, ties resolved by the lowest palette index (i.e. by
    ``PHENOTYPE_ORDER``, so Tumour beats Other deterministically). A plain mean or a plain mode
    would erase nuclei within two or three levels.
    """
    a = _pad_to_even(idx)
    h, w = a.shape
    quads = a.reshape(h // 2, 2, w // 2, 2).transpose(0, 2, 1, 3).reshape(h // 2, w // 2, 4)

    n_pheno = len(PHENOTYPE_ORDER)
    # counts[..., k] = how many of the 4 children carry palette index k+1
    counts = np.zeros(quads.shape[:2] + (n_pheno,), dtype=np.uint8)
    for k in range(1, n_pheno + 1):
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


def empty_marker_planes(tile: int = TILE) -> dict[str, np.ndarray]:
    return {n: np.zeros((tile, tile), dtype=np.uint8) for n in MARKER_CHANNELS}
