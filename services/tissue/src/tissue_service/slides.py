"""Slide access and tissue-mask rasterisation (Inc 4).

Two jobs live here:

1. **Pixels.** A job reads hundreds of 2560² windows, so it prefers a local OpenSlide tier (the
   same trick preprocess and biomarker use) and falls back to Girder when the file is not on disk.
   OpenSlide is imported lazily and only exists in the GPU image.

2. **The tissue mask.** BCSS has no background class: run on glass, it will confidently call it
   something. Every pixel outside the parent segmentation's contours is forced to palette index 0,
   which is what keeps the area fractions honest.
"""

import logging
from dataclasses import dataclass
from pathlib import Path

import httpx
import numpy as np
from PIL import Image, ImageDraw

from .region import fetch_region

logger = logging.getLogger(__name__)

_SLIDE_SUFFIXES = (".svs", ".tif", ".tiff", ".ndpi", ".scn", ".mrxs", ".vms", ".bif")


@dataclass(frozen=True)
class SlideHandle:
    width: int
    height: int
    mpp: float
    source: str           # "openslide" | "girder"
    path: str | None = None


def girder_slide_info(
    *, girder_base: str, slide_ref: str, token: str | None,
    client: httpx.Client | None = None,
) -> tuple[int, int, float | None, str | None]:
    """(width, height, mpp, filename) from large_image's tile metadata."""
    headers = {"Girder-Token": token} if token else {}
    owns = client is None
    client = client or httpx.Client(base_url=girder_base, timeout=60)
    try:
        resp = client.get(f"/item/{slide_ref}/tiles", headers=headers)
        resp.raise_for_status()
        js = resp.json()
        name = None
        try:
            item = client.get(f"/item/{slide_ref}", headers=headers)
            item.raise_for_status()
            name = item.json().get("name")
        except (httpx.HTTPError, ValueError):
            pass
    finally:
        if owns:
            client.close()
    mm_x = js.get("mm_x")
    return int(js["sizeX"]), int(js["sizeY"]), float(mm_x) * 1000.0 if mm_x else None, name


def find_local_slide(root: str | None, name: str | None) -> Path | None:
    """A local file matching ``name`` under ``root``. Conservative: an ambiguous hit returns None,
    because analysing the wrong slide silently is worse than reading over the network."""
    if not root or not name:
        return None
    base = Path(root)
    if not base.is_dir():
        return None
    exact = base / name
    if exact.is_file():
        return exact
    stem = Path(name).stem
    hits = [p for p in base.rglob("*")
            if p.is_file() and p.suffix.lower() in _SLIDE_SUFFIXES and p.stem == stem]
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        logger.warning("ambiguous local slide match for %r (%d hits) — using Girder",
                       name, len(hits))
    return None


def open_slide_handle(
    *, girder_base: str, slide_ref: str, token: str | None, slides_root: str | None,
    default_mpp: float = 0.25,
) -> tuple[SlideHandle, object]:
    """Resolve a slide and return (handle, reader) where ``reader(x, y, w, h) -> HxWx3 uint8``."""
    width, height, mpp, name = girder_slide_info(
        girder_base=girder_base, slide_ref=slide_ref, token=token
    )
    mpp = mpp or default_mpp
    local = find_local_slide(slides_root, name)
    if local is not None:
        try:
            import openslide

            osr = openslide.OpenSlide(str(local))

            def read_local(x: int, y: int, w: int, h: int) -> np.ndarray:
                tile = osr.read_region((int(x), int(y)), 0, (int(w), int(h))).convert("RGB")
                return np.asarray(tile)

            logger.info("tissue job reading %s locally via OpenSlide", local.name)
            return SlideHandle(width, height, mpp, "openslide", str(local)), read_local
        except Exception:  # noqa: BLE001 — any local failure must fall back, never fail the job
            logger.warning("local OpenSlide open failed for %s; using Girder", local, exc_info=True)

    def read_girder(x: int, y: int, w: int, h: int) -> np.ndarray:
        return fetch_region(
            girder_base=girder_base, slide_ref=slide_ref,
            bbox={"x": int(x), "y": int(y), "width": int(w), "height": int(h)}, token=token,
        ).pixels

    return SlideHandle(width, height, mpp, "girder"), read_girder


# ── tissue contours ────────────────────────────────────────────────────────────────

def _rings(contours: dict | None) -> list[tuple[list, list[list]]]:
    """(exterior, [holes]) per polygon, in level-0 slide coordinates."""
    out: list[tuple[list, list[list]]] = []
    for feat in (contours or {}).get("features", []):
        geom = (feat or {}).get("geometry") or {}
        polys = []
        if geom.get("type") == "Polygon":
            polys = [geom.get("coordinates") or []]
        elif geom.get("type") == "MultiPolygon":
            polys = geom.get("coordinates") or []
        for poly in polys:
            if not poly or not poly[0]:
                continue
            out.append((poly[0], list(poly[1:])))
    return out


def tissue_core_tiles(
    contours: dict | None, width: int, height: int, core: int,
) -> list[tuple[int, int]]:
    """Core tiles whose square intersects any tissue polygon's bounding box.

    Bounding-box intersection, not exact containment: a false positive costs one extra tile of
    compute, a false negative silently drops real tissue from the map. With no contours the caller
    gets ``[]`` and decides (a region job falls back to the requested bbox; a whole-slide job
    refuses, because segmenting a whole slide of background is wasted GPU).
    """
    boxes: list[tuple[float, float, float, float]] = []
    for ext, _holes in _rings(contours):
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


def rasterise_tissue(
    contours: dict | None, *, x: int, y: int, width: int, height: int, scale: float,
) -> np.ndarray:
    """Boolean in-tissue mask for a level-0 rectangle, at ``1/scale`` of level-0 resolution.

    ``scale`` is level-0 px per output px (4.0 for a 0.25 µm/px slide stored at 1 µm/px). With no
    contours at all the mask is **all True** — the caller has already decided that running here is
    legitimate, and blanking the whole region would be a silent no-result.
    """
    out_w = max(1, int(round(width / scale)))
    out_h = max(1, int(round(height / scale)))
    rings = _rings(contours)
    if not rings:
        return np.ones((out_h, out_w), dtype=bool)

    im = Image.new("1", (out_w, out_h), 0)
    draw = ImageDraw.Draw(im)
    for ext, holes in rings:
        pts = [((float(px) - x) / scale, (float(py) - y) / scale) for px, py in ext]
        if len(pts) >= 3:
            draw.polygon(pts, fill=1)
        for hole in holes:
            hpts = [((float(px) - x) / scale, (float(py) - y) / scale) for px, py in hole]
            if len(hpts) >= 3:
                draw.polygon(hpts, fill=0)
    return np.array(im, dtype=bool)


def preprocess_contours_path(pcache_root: str, item: str, seg_hash: str) -> Path:
    """Where the preprocess DAG parked this slide's tissue contours (read-only mount)."""
    return Path(pcache_root) / item / "seg" / seg_hash / "contours.geojson"
