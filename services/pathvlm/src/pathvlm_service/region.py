"""Read a slide region's pixels from Girder large_image at a target magnification (sync).

Unlike the cellvit reader (native-only, ``scale=1.0``), the Perceptor needs the region at a
chosen objective power: large_image downsamples server-side from the right pyramid level. We
adopt the frontend's ``getRegionImageBlob`` recipe (``units=base_pixels`` + ``magnification`` +
an output cap) and clamp the request to the slide's native power. The Girder token authenticates
the read and never reaches the model (D3). Sync (``httpx.Client``) because the service is Flask.
"""

import io
from dataclasses import dataclass

import httpx
import numpy as np
from PIL import Image

from .perceptor import effective_magnification, read_plan


@dataclass(frozen=True)
class RegionImage:
    """An extracted slide region: RGB pixels + the objective power actually delivered."""

    pixels: np.ndarray  # (H, W, 3), uint8
    magnification: float  # objective power delivered (post clamp + out_px cap)
    mpp: float | None  # slide native µm/px (informational)


def _fetch_native(
    client: httpx.Client, slide_ref: str, headers: dict
) -> tuple[float, float | None]:
    """Native objective magnification + µm/px from tile metadata; ``(40.0, None)`` on miss.

    40x is the frontend's default when a slide omits ``magnification`` (``wsiAnalysis``,
    ``ViewerPanel``), so the reader never fails on absent metadata.
    """
    try:
        resp = client.get(f"/item/{slide_ref}/tiles", headers=headers)
        resp.raise_for_status()
        meta = resp.json()
    except (httpx.HTTPError, ValueError):
        return 40.0, None
    native_mag = float(meta.get("magnification") or 40.0)
    mm_x = meta.get("mm_x")
    return native_mag, (float(mm_x) * 1000.0 if mm_x else None)


def fetch_region_at_mag(
    *,
    girder_base: str,
    slide_ref: str,
    bbox: dict,
    magnification: int | None,
    out_px: int,
    default_mag: int,
    token: str | None,
    client: httpx.Client | None = None,
) -> RegionImage:
    """GET the ROI at a clamped target magnification and decode it to an RGB ndarray."""
    headers = {"Girder-Token": token} if token else {}
    owns = client is None
    client = client or httpx.Client(base_url=girder_base, timeout=60)
    try:
        native_mag, mpp = _fetch_native(client, slide_ref, headers)
        target = effective_magnification(native_mag, magnification, default_mag)
        plan = read_plan(native_mag, target, out_px, bbox)
        params = {
            "left": int(bbox["x"]),
            "top": int(bbox["y"]),
            "regionWidth": int(bbox["width"]),
            "regionHeight": int(bbox["height"]),
            "units": "base_pixels",
            "magnification": plan.magnification,
            "width": plan.out_px,  # output cap (max), preserves aspect; never upscales
            "height": plan.out_px,
            "encoding": "PNG",
        }
        resp = client.get(f"/item/{slide_ref}/tiles/region", params=params, headers=headers)
        resp.raise_for_status()
        image = Image.open(io.BytesIO(resp.content)).convert("RGB")
    finally:
        if owns:
            client.close()
    return RegionImage(pixels=np.asarray(image), magnification=plan.effective_mag, mpp=mpp)
