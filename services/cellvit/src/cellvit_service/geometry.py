"""Coordinate re-offset: region-local centroids → level-0 slide pixels (D8).

CellViT sees only the extracted region and returns coordinates local to it. This maps
them back to the slide's level-0 frame: ``level0 = local * scale + origin``. ``scale`` is
1.0 when the region was read at native magnification (the v1 path).
"""


def offset_points(
    points: list[list[float]], origin_x: float, origin_y: float, scale: float = 1.0
) -> list[list[float]]:
    """Map region-local ``[x, y]`` centroids to level-0 slide pixels."""
    return [[x * scale + origin_x, y * scale + origin_y] for x, y in points]


def offset_rings(
    rings: list[list[list[float]]], origin_x: float, origin_y: float, scale: float = 1.0
) -> list[list[list[float]]]:
    """Same mapping, applied to each nucleus contour ring (Inc 3b).

    A ring is a list of ``[x, y]`` vertices, so this is :func:`offset_points` one level deeper —
    kept as its own function so the nesting is explicit at every call site.
    """
    return [offset_points(ring, origin_x, origin_y, scale) for ring in rings]
