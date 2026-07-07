def test_resolve_local_direct(tmp_path):
    from pathagent.common.config import Settings
    from pathagent.worker.slide_resolver import resolve_slide

    slide = tmp_path / "BRACS_1648.svs"
    slide.write_bytes(b"x")
    settings = Settings(slides_root=tmp_path)

    dest = tmp_path / "dl"
    result = resolve_slide("BRACS_1648.svs", dest, settings)
    assert result == slide


def test_resolve_local_glob_by_stem(tmp_path):
    from pathagent.common.config import Settings
    from pathagent.worker.slide_resolver import resolve_slide

    sub = tmp_path / "sub"
    sub.mkdir()
    slide = sub / "foo.svs"
    slide.write_bytes(b"x")
    settings = Settings(slides_root=tmp_path)

    dest = tmp_path / "dl"
    result = resolve_slide("foo", dest, settings)
    assert result == slide


def test_resolve_rejects_glob_metachar(tmp_path):
    import pytest

    from pathagent.common.config import Settings
    from pathagent.worker.slide_resolver import resolve_slide

    # a real slide exists that a wildcard would otherwise disclose
    (tmp_path / "secret_case.svs").write_bytes(b"x")
    settings = Settings(slides_root=tmp_path)

    dest = tmp_path / "dl"
    with pytest.raises(ValueError):
        resolve_slide("*", dest, settings)


def test_resolve_falls_back_to_download(tmp_path, monkeypatch):
    from pathagent.common.config import Settings
    from pathagent.worker import slide_resolver

    captured = {}

    def fake_download(item_id, dest_dir, girder_base, girder_token=None):
        captured["args"] = (item_id, dest_dir, girder_base, girder_token)
        return dest_dir / "downloaded.svs"

    monkeypatch.setattr(slide_resolver, "download_item_slide", fake_download)
    settings = Settings(slides_root=None, girder_base="http://g.test/api/v1")

    dest = tmp_path / "dl"
    result = slide_resolver.resolve_slide("item42", dest, settings, girder_token="tok")

    assert result == dest / "downloaded.svs"
    assert captured["args"][2] == "http://g.test/api/v1"
    assert captured["args"][3] == "tok"
