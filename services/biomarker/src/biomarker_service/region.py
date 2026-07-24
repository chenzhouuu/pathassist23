"""Read a slide region's pixels from Girder's large_image ``region`` endpoint (sync).

Mirrors the CellViT reader: extract the ROI at the slide's native magnification (so 1 region
pixel = 1 level-0 pixel, ``scale = 1.0``) and hand the RGB array to GigaTIME-Flash, which the
reference pipeline feeds native-resolution tiles with NO pre-resize. The Girder token
authenticates the read and never reaches the model (D3). Sync (httpx.Client) because the
service is Flask.
"""

import io
from dataclasses import dataclass

import httpx
import numpy as np
from PIL import Image


@dataclass(frozen=True)
class RegionImage:
    """An extracted slide region: RGB pixels + the level-0→region scale used to read it."""

    pixels: np.ndarray  # (H, W, 3), uint8
    mpp: float | None
    scale: float


def _fetch_mpp(client: httpx.Client, slide_ref: str, headers: dict) -> float | None:
    """The slide's native µm/px from large_image tile metadata (``mm_x`` → µm), or None."""
    try:
        resp = client.get(f"/item/{slide_ref}/tiles", headers=headers)
        resp.raise_for_status()
        mm_x = resp.json().get("mm_x")
    except (httpx.HTTPError, ValueError):
        return None
    return float(mm_x) * 1000.0 if mm_x else None


def fetch_region(
    *,
    girder_base: str,
    slide_ref: str,
    bbox: dict,
    token: str | None,
    client: httpx.Client | None = None,
) -> RegionImage:
    """GET the ROI as a PNG from large_image and decode it to an RGB ndarray (native scale 1.0)."""
    left = int(bbox["x"])
    top = int(bbox["y"])
    right = left + int(bbox["width"])
    bottom = top + int(bbox["height"])
    params = {"left": left, "top": top, "right": right, "bottom": bottom, "encoding": "PNG"}
    headers = {"Girder-Token": token} if token else {}
    path = f"/item/{slide_ref}/tiles/region"

    owns = client is None
    client = client or httpx.Client(base_url=girder_base, timeout=120)
    try:
        mpp = _fetch_mpp(client, slide_ref, headers)
        resp = client.get(path, params=params, headers=headers)
        resp.raise_for_status()
        image = Image.open(io.BytesIO(resp.content)).convert("RGB")
    finally:
        if owns:
            client.close()
    return RegionImage(pixels=np.asarray(image), mpp=mpp, scale=1.0)
