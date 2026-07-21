import io

import httpx
from PIL import Image

from cellvit_service.region import fetch_region


def _png_bytes(w: int, h: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (128, 64, 200)).save(buf, format="PNG")
    return buf.getvalue()


def test_fetch_region_requests_bbox_and_decodes_pixels():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["token"] = request.headers.get("Girder-Token")
        return httpx.Response(200, content=_png_bytes(64, 48),
                              headers={"Content-Type": "image/png"})

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport, base_url="http://g") as client:
        region = fetch_region(
            girder_base="http://g", slide_ref="item1",
            bbox={"x": 100, "y": 200, "width": 64, "height": 48},
            token="tok", client=client,
        )

    assert region.pixels.shape == (48, 64, 3)  # (H, W, C)
    assert region.scale == 1.0
    assert seen["token"] == "tok"
    assert "/item/item1/tiles/region" in seen["url"]
    assert "left=100" in seen["url"] and "top=200" in seen["url"]
    assert "right=164" in seen["url"] and "bottom=248" in seen["url"]
