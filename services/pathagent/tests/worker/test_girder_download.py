import httpx
import pytest
import respx


@respx.mock
def test_download_picks_largest_wsi(tmp_path):
    from pathagent.worker.girder_download import download_item_slide

    base = "http://g.test/api/v1"
    files_route = respx.get(f"{base}/item/ID/files").mock(
        return_value=httpx.Response(
            200,
            json=[
                {"_id": "f1", "name": "notes.txt", "size": 10},
                {"_id": "f2", "name": "slide.svs", "size": 999},
            ],
        )
    )
    download_route = respx.get(f"{base}/file/f2/download").mock(
        return_value=httpx.Response(200, content=b"SVSDATA")
    )

    dest = tmp_path / "dl"
    result = download_item_slide("ID", dest, base, girder_token="tok123")

    assert result == dest / "slide.svs"
    assert result.read_bytes() == b"SVSDATA"
    # atomic download leaves no partial ".part" file behind
    assert not (dest / "slide.svs.part").exists()
    assert files_route.called
    assert download_route.called
    assert files_route.calls.last.request.headers["Girder-Token"] == "tok123"


@respx.mock
def test_download_empty_file_list_raises(tmp_path):
    from pathagent.worker.girder_download import download_item_slide

    base = "http://g.test/api/v1"
    respx.get(f"{base}/item/ID/files").mock(return_value=httpx.Response(200, json=[]))

    with pytest.raises(ValueError):
        download_item_slide("ID", tmp_path, base)


@respx.mock
def test_download_no_wsi_match_raises(tmp_path):
    from pathagent.worker.girder_download import download_item_slide

    base = "http://g.test/api/v1"
    respx.get(f"{base}/item/ID/files").mock(
        return_value=httpx.Response(
            200,
            json=[
                {"_id": "f1", "name": "notes.txt", "size": 10},
                {"_id": "f2", "name": "readme.md", "size": 5},
            ],
        )
    )

    with pytest.raises(ValueError, match="no WSI file"):
        download_item_slide("ID", tmp_path, base)


@respx.mock
def test_download_rejects_traversal_filename(tmp_path):
    from pathagent.worker.girder_download import download_item_slide

    base = "http://g.test/api/v1"
    respx.get(f"{base}/item/ID/files").mock(
        return_value=httpx.Response(
            200,
            json=[{"_id": "f1", "name": "../evil.svs", "size": 100}],
        )
    )

    dest = tmp_path / "dl"
    with pytest.raises(ValueError):
        download_item_slide("ID", dest, base)
    # nothing escaped the destination directory
    assert not (tmp_path / "evil.svs").exists()
