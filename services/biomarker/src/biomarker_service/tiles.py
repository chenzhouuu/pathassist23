"""Server-side tile compositing — the virtual-mIF picture itself (Inc 3b, design §6, D3).

Disk holds 20 single-channel probability planes; the *selection*, the colours and the display
transfer function all ride in the tile URL. That is what makes toggling a marker, recolouring it
or re-stretching the contrast free: they change the URL, not the data. The browser therefore
mounts exactly one marker layer regardless of how many channels are shown.

Compositing is additive with saturation, which is what makes the result read as fluorescence
rather than as a stack of translucent overlays:

    v_c = clip((p_c - lo) / (hi - lo), 0, 1) ** gamma
    RGB = clip(sum_c  v_c * colour_c, 0, 255)
"""

import io
import re

import numpy as np
from PIL import Image

from .artifacts import TILE
from .markers import CHANNEL_INDEX, PHENOTYPE_COLORS, PHENOTYPE_ORDER

_HEX = re.compile(r"^[0-9a-fA-F]{6}$")


class BadChannelSpec(ValueError):
    """A malformed or unknown `ch=` spec — a 400, never a silently-dropped channel."""


def parse_channels(spec: str) -> list[tuple[str, tuple[int, int, int]]]:
    """``"CK:00ffff,CD8:8000ff"`` → ``[("CK", (0,255,255)), ("CD8", (128,0,255))]``.

    Order is preserved (it is the compositing order, which matters only for saturation ties).
    Unknown markers and malformed colours raise rather than being skipped: a typo that silently
    dropped a channel would look like "this marker is negative here", which is a wrong scientific
    reading, not a cosmetic bug.
    """
    out: list[tuple[str, tuple[int, int, int]]] = []
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        name, _, colour = part.partition(":")
        name = name.strip()
        colour = colour.strip() or "ffffff"
        if name not in CHANNEL_INDEX:
            raise BadChannelSpec(f"unknown marker {name!r}")
        if not _HEX.match(colour):
            raise BadChannelSpec(f"colour for {name!r} must be 6 hex digits, got {colour!r}")
        out.append((name, tuple(int(colour[i:i + 2], 16) for i in (0, 2, 4))))  # type: ignore[misc]
    return out


def transfer(plane: np.ndarray, lo: float, hi: float, gamma: float) -> np.ndarray:
    """uint8 probability plane → float [0,1] after window + gamma."""
    p = plane.astype(np.float32) / 255.0
    span = max(hi - lo, 1e-6)
    v = np.clip((p - lo) / span, 0.0, 1.0)
    if gamma != 1.0:
        v = np.power(v, max(gamma, 1e-3))
    return v


def composite(
    planes: dict[str, np.ndarray],
    channels: list[tuple[str, tuple[int, int, int]]],
    lo: float = 0.15, hi: float = 0.95, gamma: float = 0.8,
    tile: int = TILE,
) -> np.ndarray:
    """Additive pseudo-colour composite → uint8 RGBA [tile, tile, 4].

    Alpha is the per-pixel maximum channel response, so tissue with no signal stays transparent
    (letting a grey DAPI layer or a faded H&E read through) instead of painting a black square.
    """
    acc = np.zeros((tile, tile, 3), dtype=np.float32)
    amax = np.zeros((tile, tile), dtype=np.float32)
    for name, (r, g, b) in channels:
        plane = planes.get(name)
        if plane is None:
            continue
        v = transfer(plane, lo, hi, gamma)
        acc[..., 0] += v * r
        acc[..., 1] += v * g
        acc[..., 2] += v * b
        np.maximum(amax, v, out=amax)
    rgba = np.zeros((tile, tile, 4), dtype=np.uint8)
    rgba[..., :3] = np.clip(acc, 0, 255).astype(np.uint8)
    rgba[..., 3] = np.clip(amax * 255.0, 0, 255).astype(np.uint8)
    return rgba


def colourise_pheno(
    idx: np.ndarray, show: list[str] | None = None, alpha: float = 1.0,
) -> np.ndarray:
    """Palette-index raster → uint8 RGBA, optionally filtered to ``show`` lineages.

    Filtering is a palette operation, not a re-render: a hidden lineage's entry is simply made
    transparent. That is why "show only Cytotoxic T" costs a URL change (D3's symmetry).
    """
    lut = np.zeros((256, 4), dtype=np.uint8)
    keep = set(show) if show else None
    a = int(np.clip(alpha, 0.0, 1.0) * 255)
    for i, name in enumerate(PHENOTYPE_ORDER, start=1):
        if keep is not None and name not in keep:
            continue
        r, g, b = (int(PHENOTYPE_COLORS[name].lstrip("#")[j:j + 2], 16) for j in (0, 2, 4))
        lut[i] = (r, g, b, a)
    return lut[idx]


def encode_png(rgba: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _transparent_png(tile: int = TILE) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", (tile, tile), (0, 0, 0, 0)).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# An uncovered tile must be a real, fully transparent image — NOT a 204 (review B2). OSD 4.1.1
# loads tiles through an <img>, so a bodiless response fires onerror, marks the tile failed and
# enters retry/backoff: hundreds of failing requests per pan on a partially-covered slide. This
# renders as the same hole with none of that, and is built once at import.
TRANSPARENT_TILE: bytes = _transparent_png()
