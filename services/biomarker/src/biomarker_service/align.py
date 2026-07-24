"""Level-0 centroid → region-local mIF pixel (review S4).

CellViT returns nuclei centroids in **level-0** slide pixels (it re-offsets by the bbox origin
and its own read scale). The mIF raster this service predicts is **region-local**, read at the
bbox at some ``read_scale`` (native ⇒ 1.0). The inverse map is therefore

    (col, row) = ((cx - origin_x) / read_scale, (cy - origin_y) / read_scale)

A silent half-patch offset here mis-phenotypes every cell, so the mapping is one small, tested
function and out-of-bounds centroids are **dropped**, never clamped.
"""


def to_region_pixel(
    cx: float, cy: float, origin_x: float, origin_y: float, read_scale: float = 1.0
) -> tuple[float, float]:
    """Map a level-0 ``(cx, cy)`` centroid to region-local ``(col, row)`` mIF pixels."""
    return (cx - origin_x) / read_scale, (cy - origin_y) / read_scale


def in_bounds(col: float, row: float, width: int, height: int) -> bool:
    return 0.0 <= col < width and 0.0 <= row < height


def region_pixels(
    centroids: list[list[float]],
    origin_x: float,
    origin_y: float,
    read_scale: float,
    width: int,
    height: int,
) -> list[tuple[int, float, float]]:
    """Map every level-0 centroid into the region raster, keeping only in-bounds cells.

    Returns ``(index, col, row)`` triples (index into the input list) so the caller keeps each
    kept cell aligned with its CellViT class; out-of-bounds centroids are dropped.
    """
    out: list[tuple[int, float, float]] = []
    for i, c in enumerate(centroids):
        col, row = to_region_pixel(float(c[0]), float(c[1]), origin_x, origin_y, read_scale)
        if in_bounds(col, row, width, height):
            out.append((i, col, row))
    return out
