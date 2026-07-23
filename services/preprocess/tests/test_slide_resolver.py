import httpx
import pytest

from preprocess_service.config import Settings
from preprocess_service.girder_download import _validate_segment
from preprocess_service.slide_resolver import resolve_slide


def _files_transport(files):
    """MockTransport serving GET /item/{id}/files → `files`, and streaming a download body."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/files"):
            return httpx.Response(200, json=files)
        if "/download" in request.url.path:
            return httpx.Response(200, content=b"FAKE-SVS-BYTES")
        return httpx.Response(404)
    return httpx.MockTransport(handler)


def _raise_transport():
    def handler(request):  # proves a tier short-circuits before any Girder call
        raise AssertionError(f"unexpected Girder call: {request.url}")
    return httpx.MockTransport(handler)


def test_tier1_local_by_item_id(tmp_path):
    slide = tmp_path / "abc123.svs"
    slide.write_bytes(b"x" * 10)
    settings = Settings(slides_root=tmp_path)
    out = resolve_slide("abc123", tmp_path / "dl", settings, transport=_raise_transport())
    assert out == slide  # tier 1 short-circuits — no Girder call


def test_tier2_local_by_name_and_size(tmp_path):
    slide = tmp_path / "BRACS_1648.svs"
    slide.write_bytes(b"y" * 1234)
    settings = Settings(slides_root=tmp_path)
    files = [{"_id": "f1", "name": "BRACS_1648.svs", "size": 1234}]
    out = resolve_slide("itemXYZ", tmp_path / "dl", settings, transport=_files_transport(files))
    assert out == slide  # matched local by name + size, not downloaded


def test_size_mismatch_falls_through_to_download(tmp_path):
    slide = tmp_path / "BRACS_1648.svs"
    slide.write_bytes(b"y" * 1234)
    settings = Settings(slides_root=tmp_path)
    files = [{"_id": "f1", "name": "BRACS_1648.svs", "size": 9999}]  # size differs
    dest = tmp_path / "dl"
    out = resolve_slide("itemXYZ", dest, settings, transport=_files_transport(files))
    assert out == dest / "BRACS_1648.svs"  # downloaded, not the local mismatch
    assert out.read_bytes() == b"FAKE-SVS-BYTES"


def test_download_tier_when_no_slides_root(tmp_path):
    settings = Settings(slides_root=None)  # skip local tiers entirely
    files = [{"_id": "f1", "name": "slide.svs", "size": 5}]
    dest = tmp_path / "dl"
    out = resolve_slide("item1", dest, settings, transport=_files_transport(files))
    assert out == dest / "slide.svs" and out.read_bytes() == b"FAKE-SVS-BYTES"


def test_largest_wsi_is_chosen(tmp_path):
    settings = Settings(slides_root=None)
    files = [
        {"_id": "small", "name": "a.svs", "size": 5},
        {"_id": "big", "name": "b.svs", "size": 500},
        {"_id": "label", "name": "notes.txt", "size": 9000},  # non-WSI ignored
    ]
    seen = {}

    def handler(request):
        if request.url.path.endswith("/files"):
            return httpx.Response(200, json=files)
        seen["download"] = request.url.path
        return httpx.Response(200, content=b"BIG")
    out = resolve_slide("i", tmp_path, settings, transport=httpx.MockTransport(handler))
    assert out.name == "b.svs" and "big" in seen["download"]


@pytest.mark.parametrize("bad", ["../evil", "a/b", "/etc/passwd", "..", ""])
def test_injection_is_rejected(bad):
    with pytest.raises(ValueError):
        _validate_segment(bad)
