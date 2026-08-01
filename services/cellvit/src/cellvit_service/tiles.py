"""Server-side tile rendering for the nuclei mask (Inc 5, ticket 06).

Disk holds a class index and a coverage fraction; the *selection*, the colours and the opacity ride
in the tile URL. Hiding a class or dragging opacity therefore costs a URL change, not a recompute,
and the browser mounts exactly one nuclei layer whatever the controls say.

Alpha is ``opacity x coverage``. At level 0 coverage is 1 inside a nucleus and 0 outside, so the
picture is a crisp filled outline; further up the pyramid coverage carries how much of the pixel
was nucleus, so a dense field reads strong and a sparse one reads faint — the density is in the
picture rather than lost to whichever rule won the downsample (see pyramid.py).
"""

import io
import re

import numpy as np
from PIL import Image

from .artifacts import TILE
from .pannuke import TYPE_NAMES, class_ids, color_for

_HEX = re.compile(r"^[0-9a-fA-F]{6}$")


class BadClassSpec(ValueError):
    """A malformed or unknown class spec — a 400, never a silently-dropped class."""


def parse_show(spec: str | None) -> list[str] | None:
    """``"Neoplastic,Dead"`` → validated class names; ``None`` (or empty) means "all".

    A typo raises rather than being skipped: a class silently dropped from the picture would read
    as "there are none of these here", which is a wrong finding rather than a cosmetic bug.
    """
    if not spec:
        return None
    names = [s.strip() for s in spec.split(",") if s.strip()]
    known = set(TYPE_NAMES.values())
    unknown = [n for n in names if n not in known]
    if unknown:
        raise BadClassSpec(f"unknown class(es) {unknown}; known: {sorted(known)}")
    return names


def parse_colors(spec: str | None) -> dict[int, str]:
    """``"Neoplastic:d55e00"`` → {class id: 'RRGGBB'}, defaulting to the PanNuke palette."""
    out = {cid: color_for(cid) for cid in class_ids()}
    if not spec:
        return out
    by_name = {name: cid for cid, name in TYPE_NAMES.items()}
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        name, _, colour = part.partition(":")
        cid = by_name.get(name.strip())
        if cid is None:
            raise BadClassSpec(f"unknown class {name.strip()!r}")
        colour = colour.strip().lstrip("#")
        if not _HEX.match(colour):
            raise BadClassSpec(f"colour for {name.strip()!r} must be 6 hex digits, got {colour!r}")
        out[cid] = colour
    return out


def _rgb(hexed: str) -> tuple[int, int, int]:
    h = hexed.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def colourise(
    idx: np.ndarray, cover: np.ndarray | None, *,
    show: list[str] | None = None, alpha: float = 1.0,
    colors: dict[int, str] | None = None,
) -> np.ndarray:
    """Class-index raster → uint8 RGBA, filtered to ``show`` and faded by coverage.

    Filtering is a palette operation rather than a re-render: a hidden class's entry is simply made
    transparent, so its pixels stop being drawn without anything being recomputed.
    """
    colors = colors or {cid: color_for(cid) for cid in class_ids()}
    keep = set(show) if show else None
    a = int(np.clip(alpha, 0.0, 1.0) * 255)

    lut = np.zeros((256, 4), dtype=np.uint8)
    for cid in class_ids():
        if keep is not None and TYPE_NAMES[cid] not in keep:
            continue
        r, g, b = _rgb(colors.get(cid, color_for(cid)))
        lut[cid] = (r, g, b, a)

    rgba = lut[idx]
    if cover is not None:
        scale = cover.astype(np.float32) / 255.0
        rgba[..., 3] = (rgba[..., 3].astype(np.float32) * scale).astype(np.uint8)
    return rgba


# zlib effort for a *served* tile. The same trade the tissue map measured: `optimize=True` costs an
# order of magnitude more time to save a few percent of the bytes, and a tile is generated on
# demand and cached for a day rather than archived.
PNG_LEVEL = 6


def encode_png(rgba: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", compress_level=PNG_LEVEL)
    return buf.getvalue()


def _transparent_png(tile: int = TILE) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", (tile, tile), (0, 0, 0, 0)).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# An uncovered tile must be a real, fully transparent image — NOT a 204. OSD loads tiles through an
# <img>, so a bodiless response fires onerror, marks the tile failed and enters retry/backoff:
# hundreds of failing requests per pan on a partially-covered slide (Inc 3b review B2).
TRANSPARENT_TILE: bytes = _transparent_png()


__all__ = [
    "TRANSPARENT_TILE", "BadClassSpec", "colourise", "encode_png", "parse_colors", "parse_show",
]
