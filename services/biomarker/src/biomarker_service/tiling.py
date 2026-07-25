"""Core + halo job tiling — the geometry that keeps nuclei whole at tile seams (review B1).

CellViT de-duplicates detections across its *internal* tiling, but a job that calls it once per
region cannot: a nucleus straddling two job tiles is detected twice, rasterised as two clipped
fragments, and pooled from a truncated disk. Over a slide that is ~12 000 seam-edges of chopped
nuclei — a visible grid, i.e. exactly the artefact this increment exists to remove.

The fix is not a de-duplication heuristic. Each job tile is *read* with a halo and *owns* only the
nuclei whose **centroid** lands in its core. Centroid ownership is a partition of the plane, so
every nucleus is claimed exactly once with no tunable proximity threshold, while the halo supplies
whole contours and complete pooling disks for nuclei sitting on the core boundary.

Pure integer geometry; no I/O, no numpy.
"""

from dataclasses import dataclass

from .artifacts import CORE, HALO


@dataclass(frozen=True)
class ReadWindow:
    """A core tile plus its halo, clamped to the slide.

    ``x``/``y``/``width``/``height`` are the level-0 rectangle to *read*. ``core_dx``/``core_dy``
    are the core's offset inside that rectangle, so a detection at window-local ``(u, v)`` is in
    the core iff ``core_dx <= u < core_dx + core_w``.
    """

    x: int
    y: int
    width: int
    height: int
    core_x: int
    core_y: int
    core_w: int
    core_h: int

    @property
    def core_dx(self) -> int:
        return self.core_x - self.x

    @property
    def core_dy(self) -> int:
        return self.core_y - self.y


def core_tiles(bbox: dict, core: int = CORE) -> list[tuple[int, int]]:
    """Core-tile indices covering ``bbox``, in row-major order.

    Indices are absolute on the slide's core grid (``tx = x // core``), never relative to the
    bbox — that is what lets two jobs with different bboxes share one coverage set (D6).
    """
    x0 = int(bbox["x"])
    y0 = int(bbox["y"])
    x1 = x0 + int(bbox["width"])
    y1 = y0 + int(bbox["height"])
    if x1 <= x0 or y1 <= y0:
        return []
    tiles: list[tuple[int, int]] = []
    for ty in range(y0 // core, (y1 - 1) // core + 1):
        for tx in range(x0 // core, (x1 - 1) // core + 1):
            tiles.append((tx, ty))
    return tiles


def haloed_read_window(
    tx: int, ty: int, slide_w: int, slide_h: int, core: int = CORE, halo: int = HALO,
) -> ReadWindow | None:
    """The read rectangle for core tile ``(tx, ty)``, clamped to the slide.

    Returns None when the core lies entirely off the slide (the last row/column of the grid can
    fall outside for a slide whose size is not a multiple of ``core``).
    """
    core_x, core_y = tx * core, ty * core
    core_w = min(core, slide_w - core_x)
    core_h = min(core, slide_h - core_y)
    if core_w <= 0 or core_h <= 0:
        return None
    x = max(0, core_x - halo)
    y = max(0, core_y - halo)
    x1 = min(slide_w, core_x + core_w + halo)
    y1 = min(slide_h, core_y + core_h + halo)
    return ReadWindow(
        x=x, y=y, width=x1 - x, height=y1 - y,
        core_x=core_x, core_y=core_y, core_w=core_w, core_h=core_h,
    )


def owns(cx: float, cy: float, win: ReadWindow) -> bool:
    """Does core tile ``win`` own the nucleus at level-0 centroid ``(cx, cy)``?

    Half-open on both axes, so adjacent cores partition the plane exactly: a centroid on the
    shared edge belongs to the tile to its right/below and to nothing else.
    """
    return (win.core_x <= cx < win.core_x + win.core_w
            and win.core_y <= cy < win.core_y + win.core_h)


def clip_bbox_to_slide(bbox: dict, slide_w: int, slide_h: int) -> dict | None:
    """Intersect a requested bbox with the slide; None when they do not overlap."""
    x0 = max(0, int(bbox["x"]))
    y0 = max(0, int(bbox["y"]))
    x1 = min(slide_w, int(bbox["x"]) + int(bbox["width"]))
    y1 = min(slide_h, int(bbox["y"]) + int(bbox["height"]))
    if x1 <= x0 or y1 <= y0:
        return None
    return {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}
