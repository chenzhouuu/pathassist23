import io

import httpx
from PIL import Image

from pathvlm_service.region import fetch_region_at_mag


def _png_bytes(w=8, h=8):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (128, 64, 32)).save(buf, format="PNG")
    return buf.getvalue()


def test_reads_tiles_meta_then_region_at_clamped_magnification():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tiles/region"):
            seen["params"] = dict(request.url.params)
            seen["region_token"] = request.headers.get("Girder-Token")
            return httpx.Response(200, content=_png_bytes(), headers={"Content-Type": "image/png"})
        if request.url.path.endswith("/tiles"):
            return httpx.Response(200, json={"magnification": 40, "mm_x": 0.0005})
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://g/api/v1")
    img = fetch_region_at_mag(
        girder_base="http://g/api/v1", slide_ref="item9",
        bbox={"x": 100, "y": 200, "width": 512, "height": 512},
        magnification=80, out_px=512, default_mag=20, token="tok", client=client,
    )

    p = seen["params"]
    assert p["units"] == "base_pixels"
    assert p["left"] == "100" and p["top"] == "200"
    assert p["regionWidth"] == "512" and p["regionHeight"] == "512"
    assert p["magnification"] == "40"                    # 80 clamped to native 40
    assert p["width"] == "512" and p["height"] == "512"  # output cap
    assert seen["region_token"] == "tok" and "token" not in p  # D3: token in header only
    assert img.magnification == 40 and img.mpp == 0.5    # 0.0005 mm -> 0.5 µm/px
    assert img.pixels.shape == (8, 8, 3)


def test_missing_tile_metadata_defaults_native_to_40x():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tiles/region"):
            return httpx.Response(200, content=_png_bytes())
        return httpx.Response(500, json={"message": "no metadata"})  # /tiles fails

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://g/api/v1")
    img = fetch_region_at_mag(
        girder_base="http://g/api/v1", slide_ref="x",
        bbox={"x": 0, "y": 0, "width": 512, "height": 512},
        magnification=None, out_px=512, default_mag=20, token=None, client=client,
    )
    assert img.magnification == 20 and img.mpp is None   # default native 40 → 20x default holds
