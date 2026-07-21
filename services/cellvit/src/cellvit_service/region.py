"""Read a slide region's pixels from Girder's large_image ``region`` endpoint (sync).

CellViT has no region API — it is WSI-centric. We extract the ROI ourselves at the slide's
native magnification (so 1 region pixel = 1 level-0 pixel, ``scale = 1.0``) and hand the
array to the model. The Girder token authenticates the read; it never reaches the model
(D3). Sync (httpx.Client) because the service is Flask.
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


def fetch_region(
    *,
    girder_base: str,
    slide_ref: str,
    bbox: dict,
    token: str | None,
    client: httpx.Client | None = None,
) -> RegionImage:
    """GET the ROI as a PNG from large_image and decode it to an RGB ndarray."""
    left = int(bbox["x"])
    top = int(bbox["y"])
    right = left + int(bbox["width"])
    bottom = top + int(bbox["height"])
    params = {"left": left, "top": top, "right": right, "bottom": bottom, "encoding": "PNG"}
    headers = {"Girder-Token": token} if token else {}
    path = f"/item/{slide_ref}/tiles/region"

    owns = client is None
    client = client or httpx.Client(base_url=girder_base, timeout=60)
    try:
        resp = client.get(path, params=params, headers=headers)
        resp.raise_for_status()
        image = Image.open(io.BytesIO(resp.content)).convert("RGB")
    finally:
        if owns:
            client.close()
    return RegionImage(pixels=np.asarray(image), mpp=None, scale=1.0)
