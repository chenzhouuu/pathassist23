"""Read a slide region's pixels from Girder's large_image ``region`` endpoint (sync).

Mirrors the biomarker/cellvit readers: extract the ROI at the slide's native magnification (so one
region pixel is one level-0 pixel) and hand the RGB array on. The Girder token authenticates the
read and never reaches the model. Sync (httpx.Client) because the service is Flask.
"""

import io
from dataclasses import dataclass

import httpx
import numpy as np
from PIL import Image


@dataclass(frozen=True)
class RegionImage:
    pixels: np.ndarray  # (H, W, 3), uint8
    mpp: float | None
    scale: float


def _fetch_mpp(client: httpx.Client, slide_ref: str, headers: dict) -> float | None:
    try:
        resp = client.get(f"/item/{slide_ref}/tiles", headers=headers)
        resp.raise_for_status()
        mm_x = resp.json().get("mm_x")
    except (httpx.HTTPError, ValueError):
        return None
    return float(mm_x) * 1000.0 if mm_x else None


def fetch_region(
    *, girder_base: str, slide_ref: str, bbox: dict, token: str | None,
    client: httpx.Client | None = None,
) -> RegionImage:
    """GET the ROI as a PNG from large_image and decode it to an RGB ndarray (native scale 1.0)."""
    left = int(bbox["x"])
    top = int(bbox["y"])
    params = {"left": left, "top": top,
              "right": left + int(bbox["width"]), "bottom": top + int(bbox["height"]),
              "encoding": "PNG"}
    headers = {"Girder-Token": token} if token else {}
    owns = client is None
    client = client or httpx.Client(base_url=girder_base, timeout=300)
    try:
        mpp = _fetch_mpp(client, slide_ref, headers)
        resp = client.get(f"/item/{slide_ref}/tiles/region", params=params, headers=headers)
        resp.raise_for_status()
        image = Image.open(io.BytesIO(resp.content)).convert("RGB")
    finally:
        if owns:
            client.close()
    return RegionImage(pixels=np.asarray(image), mpp=mpp, scale=1.0)
