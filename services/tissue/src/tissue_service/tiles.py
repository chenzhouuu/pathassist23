"""Server-side tile rendering — three looks over one storage (Inc 4, design §6, D7).

Disk holds a class raster and per-class probability planes; the *selection*, the colours, the
opacity and the render mode all ride in the tile URL. Toggling a class or switching look therefore
costs a URL change, not a recompute, and the browser mounts exactly one tissue layer regardless.

- ``classes``  paletted argmax, alpha optionally scaled by max-probability. **The default (D7):**
  uncertainty becomes visible without a control, so an out-of-focus or ambiguous field renders
  faint instead of looking as decided as a clean one.
- ``probs``    additive composite ``RGB = Σ v_c · colour_c`` — a continuous painted map.
- ``outline``  class boundaries only, so the H&E underneath stays fully readable.
"""

import io
import re

import numpy as np
from PIL import Image

from .artifacts import TILE
from .classes import Backend

_HEX = re.compile(r"^[0-9a-fA-F]{6}$")


class BadClassSpec(ValueError):
    """A malformed or unknown class spec — a 400, never a silently-dropped class."""


def parse_show(spec: str | None, backend: Backend) -> list[str] | None:
    """``"Tumour,Stroma"`` → validated class names; ``None`` (or empty) means "all"."""
    if not spec:
        return None
    names = [s.strip() for s in spec.split(",") if s.strip()]
    unknown = [n for n in names if n not in backend.classes]
    if unknown:
        raise BadClassSpec(f"unknown class(es) {unknown}; known: {list(backend.classes)}")
    return names


def parse_channels(spec: str, backend: Backend) -> list[tuple[str, tuple[int, int, int]]]:
    """``"Tumour:d55e00,Stroma:0072b2"`` → [(name, rgb)]; defaults to the backend palette.

    Unknown classes and malformed colours raise rather than being skipped: a typo that silently
    dropped a class would read as "this class is absent here", which is a wrong finding rather
    than a cosmetic bug.
    """
    if not spec:
        return [(c, _rgb(col)) for c, col in zip(backend.classes, backend.colors, strict=True)]
    out: list[tuple[str, tuple[int, int, int]]] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        name, _, colour = part.partition(":")
        name = name.strip()
        if name not in backend.classes:
            raise BadClassSpec(f"unknown class {name!r}")
        colour = (colour.strip() or backend.colors[backend.classes.index(name)]).lstrip("#")
        if not _HEX.match(colour):
            raise BadClassSpec(f"colour for {name!r} must be 6 hex digits, got {colour!r}")
        out.append((name, _rgb(colour)))
    return out


def _rgb(hexed: str) -> tuple[int, int, int]:
    h = hexed.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def transfer(plane: np.ndarray, lo: float, hi: float, gamma: float) -> np.ndarray:
    """uint8 probability plane → float [0,1] after window + gamma."""
    p = plane.astype(np.float32) / 255.0
    span = max(hi - lo, 1e-6)
    v = np.clip((p - lo) / span, 0.0, 1.0)
    if gamma != 1.0:
        v = np.power(v, max(gamma, 1e-3))
    return v


def colourise_classes(
    idx: np.ndarray, backend: Backend, *, show: list[str] | None = None,
    alpha: float = 1.0, conf: np.ndarray | None = None, conf_floor: float = 0.2,
) -> np.ndarray:
    """Palette-index raster → uint8 RGBA, filtered to ``show`` and optionally faded by confidence.

    Filtering is a palette operation, not a re-render: a hidden class's entry is simply made
    transparent. ``conf`` is the per-pixel max class probability (uint8); when supplied, alpha is
    scaled by it so the picture shows *where the model is sure*. ``conf_floor`` keeps a confident
    region from being invisible at low certainty rather than clipping it to nothing.
    """
    lut = np.zeros((256, 4), dtype=np.uint8)
    keep = set(show) if show else None
    a = int(np.clip(alpha, 0.0, 1.0) * 255)
    for i, name in enumerate(backend.classes, start=1):
        if keep is not None and name not in keep:
            continue
        r, g, b = _rgb(backend.colors[i - 1])
        lut[i] = (r, g, b, a)
    rgba = lut[idx]
    if conf is not None:
        scale = conf_floor + (1.0 - conf_floor) * (conf.astype(np.float32) / 255.0)
        rgba[..., 3] = (rgba[..., 3].astype(np.float32) * scale).astype(np.uint8)
    return rgba


def composite_probs(
    planes: dict[str, np.ndarray],
    channels: list[tuple[str, tuple[int, int, int]]],
    lo: float = 0.0, hi: float = 1.0, gamma: float = 1.0,
    alpha: float = 1.0, tile: int = TILE,
) -> np.ndarray:
    """Additive pseudo-colour composite → uint8 RGBA. Alpha is the per-pixel max response."""
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
    rgba[..., 3] = np.clip(amax * 255.0 * float(np.clip(alpha, 0, 1)), 0, 255).astype(np.uint8)
    return rgba


def outline_classes(
    idx: np.ndarray, backend: Backend, *, show: list[str] | None = None,
    alpha: float = 1.0, width: int = 2,
) -> np.ndarray:
    """Class boundaries only — everything else transparent, so the H&E reads through.

    A pixel is a boundary if any 4-neighbour carries a different index. ``width`` thickens the
    line by dilating that mask, because a 1 px line disappears the moment the viewer downsamples.
    """
    a = idx.astype(np.int16)
    diff = np.zeros(a.shape, dtype=bool)
    diff[:-1, :] |= a[:-1, :] != a[1:, :]
    diff[1:, :] |= a[:-1, :] != a[1:, :]
    diff[:, :-1] |= a[:, :-1] != a[:, 1:]
    diff[:, 1:] |= a[:, :-1] != a[:, 1:]
    for _ in range(max(0, int(width) - 1)):
        d = diff.copy()
        d[:-1, :] |= diff[1:, :]
        d[1:, :] |= diff[:-1, :]
        d[:, :-1] |= diff[:, 1:]
        d[:, 1:] |= diff[:, :-1]
        diff = d
    rgba = colourise_classes(idx, backend, show=show, alpha=alpha)
    rgba[~diff] = 0
    return rgba


def max_prob(planes: dict[str, np.ndarray], backend: Backend) -> np.ndarray | None:
    """Per-pixel maximum class probability as uint8 — the confidence channel for the alpha ramp."""
    stack = [planes[c] for c in backend.classes if c in planes]
    if not stack:
        return None
    return np.max(np.stack(stack, axis=0), axis=0)


# zlib effort for a *served* tile. `optimize=True` (max effort plus a palette search) is the wrong
# trade here and was measured as the dominant cost of mounting the map: on a confidence-shaded tile
# it took 184 ms against 14 ms at this level, to save 6.7% of the bytes. The alpha ramp is what
# makes it expensive — it turns ~6 distinct RGBA values into ~640, so there is real entropy to
# chew on. A tile is generated on demand and cached for a day; it is not an archive.
PNG_LEVEL = 6                      # Pillow's own default


def encode_png(rgba: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", compress_level=PNG_LEVEL)
    return buf.getvalue()


def _transparent_png(tile: int = TILE) -> bytes:
    # Encoded once at import and then served for every uncovered tile, so here the effort is
    # worth it: it buys a smaller constant forever rather than per request.
    buf = io.BytesIO()
    Image.new("RGBA", (tile, tile), (0, 0, 0, 0)).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# An uncovered tile must be a real, fully transparent image — NOT a 204. OSD loads tiles through
# an <img>, so a bodiless response fires onerror, marks the tile failed and enters retry/backoff:
# hundreds of failing requests per pan on a partially-covered slide (Inc 3b review B2).
TRANSPARENT_TILE: bytes = _transparent_png()
