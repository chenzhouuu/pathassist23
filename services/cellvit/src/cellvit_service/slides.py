"""Where a whole-slide run is worth looking: the preprocess DAG's tissue contours (Inc 5, 07).

Copied from ``tissue/slides.py`` — the tile-selection half of it, not the slide reader, which this
service does not need because it reads pixels through Girder's region endpoint. Fourth copy of a
small piece of the map machinery, and knowingly so (plan R2). Keep it a copy.

What it is used for differs from the tissue map's, and the difference matters. The tissue map masks
its *output* with the contours, because BCSS has no background class and would confidently label
glass. Nuclei need no such mask: CellViT finds nothing on glass, so an off-tissue core produces an
empty result rather than a wrong one. Here the contours only decide **which cores are worth the
GPU** — which is coverage, not identity, and is why the segmentation stays out of the artifact hash.
"""

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def preprocess_contours_path(pcache_root: Path | str, item: str, seg_hash: str) -> Path:
    """Where the preprocess DAG parked this slide's tissue contours (read-only mount)."""
    return Path(pcache_root) / item / "seg" / seg_hash / "contours.geojson"


def read_contours(pcache_root: Path | str, item: str, seg_hash: str) -> dict | None:
    path = preprocess_contours_path(pcache_root, item, seg_hash)
    if not path.is_file():
        logger.warning("no tissue contours at %s", path)
        return None
    with open(path) as fh:
        return json.load(fh)


def _rings(contours: dict | None) -> list[list]:
    """Every polygon's exterior ring, in level-0 slide coordinates. Holes are irrelevant here:
    a hole inside a tissue polygon still sits inside its bounding box, and the cost of running a
    core that turns out to be empty is one core of GPU, not a wrong answer."""
    out: list[list] = []
    for feat in (contours or {}).get("features", []):
        geom = (feat or {}).get("geometry") or {}
        polys = []
        if geom.get("type") == "Polygon":
            polys = [geom.get("coordinates") or []]
        elif geom.get("type") == "MultiPolygon":
            polys = geom.get("coordinates") or []
        for poly in polys:
            if poly and poly[0]:
                out.append(poly[0])
    return out


def tissue_core_tiles(
    contours: dict | None, width: int, height: int, core: int,
) -> list[tuple[int, int]]:
    """Core tiles whose square intersects any tissue polygon's bounding box.

    Bounding-box intersection, not exact containment: a false positive costs one extra core of
    compute, a false negative silently drops real tissue from the artifact. With no contours the
    caller gets ``[]`` and decides — for nuclei, a whole-slide run refuses, because segmenting an
    entire slide of background is hours of the only GPU worker spent finding nothing.
    """
    boxes = []
    for ext in _rings(contours):
        xs = [float(p[0]) for p in ext]
        ys = [float(p[1]) for p in ext]
        boxes.append((min(xs), min(ys), max(xs), max(ys)))
    if not boxes:
        return []
    out: list[tuple[int, int]] = []
    for ty in range((height + core - 1) // core):
        for tx in range((width + core - 1) // core):
            x0, y0 = tx * core, ty * core
            x1, y1 = x0 + core, y0 + core
            if any(bx0 < x1 and bx1 > x0 and by0 < y1 and by1 > y0
                   for bx0, by0, bx1, by1 in boxes):
                out.append((tx, ty))
    return out


__all__ = ["preprocess_contours_path", "read_contours", "tissue_core_tiles"]
