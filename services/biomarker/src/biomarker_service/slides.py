"""Slide access for the long job: metadata + a windowed pixel reader (Inc 3b, review S5).

The interactive `/phenotype` route reads one ROI over Girder and that is fine. A job reads
hundreds of 2560² windows, and every one of those is a PNG encode on the Girder side plus a
decode here. So the job prefers a **local OpenSlide** tier — the same trick `preprocess`'s
`slide_resolver` uses — and falls back to Girder when the file is not on disk.

OpenSlide is imported lazily and only exists in the GPU image, so the base/CI env exercises the
Girder path and never needs the native library.
"""

import logging
import os
from dataclasses import dataclass
from pathlib import Path

import httpx
import numpy as np

from .region import fetch_region

logger = logging.getLogger(__name__)

_SLIDE_SUFFIXES = (".svs", ".tif", ".tiff", ".ndpi", ".scn", ".mrxs", ".vms", ".bif")


@dataclass(frozen=True)
class SlideHandle:
    """Everything the job needs about a slide, plus how to read pixels from it."""

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
    return (
        int(js["sizeX"]), int(js["sizeY"]),
        float(mm_x) * 1000.0 if mm_x else None,
        name,
    )


def find_local_slide(root: str | None, name: str | None) -> Path | None:
    """A local file matching ``name`` under ``root`` (exact name, then stem match).

    Deliberately conservative: name-based only. A wrong match would silently analyse the wrong
    slide, so anything less than an unambiguous hit returns None and the job uses Girder.
    """
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

            logger.info("biomarker job reading %s locally via OpenSlide", local.name)
            return SlideHandle(width, height, mpp, "openslide", str(local)), read_local
        except Exception:  # noqa: BLE001 — any local failure must fall back, never fail the job
            logger.warning("local OpenSlide open failed for %s; using Girder", local, exc_info=True)

    def read_girder(x: int, y: int, w: int, h: int) -> np.ndarray:
        return fetch_region(
            girder_base=girder_base, slide_ref=slide_ref,
            bbox={"x": int(x), "y": int(y), "width": int(w), "height": int(h)}, token=token,
        ).pixels

    return SlideHandle(width, height, mpp, "girder"), read_girder


def tissue_core_tiles(
    contours: dict | None, width: int, height: int, core: int,
) -> list[tuple[int, int]]:
    """Core tiles whose square intersects any tissue polygon's bounding box.

    Bounding-box intersection, not exact polygon containment: a false positive costs one extra
    tile of compute, a false negative silently drops real tissue from the map. With no contours at
    all the caller gets ``[]`` and decides (the region path falls back to "whatever was asked
    for"; the whole-slide path refuses, since analysing a whole slide of background is hours of
    wasted GPU).
    """
    if not contours:
        return []
    boxes: list[tuple[float, float, float, float]] = []
    for feat in contours.get("features", []):
        geom = (feat or {}).get("geometry") or {}
        polys = []
        if geom.get("type") == "Polygon":
            polys = [geom.get("coordinates") or []]
        elif geom.get("type") == "MultiPolygon":
            polys = geom.get("coordinates") or []
        for poly in polys:
            ring = (poly or [None])[0]
            if not ring:
                continue
            xs = [float(p[0]) for p in ring]
            ys = [float(p[1]) for p in ring]
            boxes.append((min(xs), min(ys), max(xs), max(ys)))
    if not boxes:
        return []
    out: list[tuple[int, int]] = []
    n_x = (width + core - 1) // core
    n_y = (height + core - 1) // core
    for ty in range(n_y):
        for tx in range(n_x):
            x0, y0 = tx * core, ty * core
            x1, y1 = x0 + core, y0 + core
            if any(bx0 < x1 and bx1 > x0 and by0 < y1 and by1 > y0
                   for bx0, by0, bx1, by1 in boxes):
                out.append((tx, ty))
    return out


def preprocess_contours_path(pcache_root: str, item: str, seg_hash: str) -> Path:
    """Where the preprocess DAG parked this slide's tissue contours (read-only mount)."""
    return Path(pcache_root) / item / "seg" / seg_hash / "contours.geojson"


def slides_root_default() -> str | None:
    return os.getenv("BIOMARKER_SLIDES_ROOT") or None
