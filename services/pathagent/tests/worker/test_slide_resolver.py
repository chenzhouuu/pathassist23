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


def test_resolve_local_by_girder_name_avoids_download(tmp_path, monkeypatch):
    """A slide whose local filename differs from the Girder item id is still resolved
    locally — via the item's Girder file name — so no multi-GB byte download happens."""
    from pathagent.common.config import Settings
    from pathagent.worker import slide_resolver

    # Local slide named by its real filename, NOT by the opaque Girder item id.
    slide = tmp_path / "BRACS_1648.svs"
    slide.write_bytes(b"x")

    # Girder file lookup (metadata only) returns the on-disk name + matching size...
    monkeypatch.setattr(
        slide_resolver,
        "_girder_slide_file",
        lambda item_id, girder_base, girder_token=None: {
            "_id": "f", "name": "BRACS_1648.svs", "size": slide.stat().st_size,
        },
        raising=False,
    )

    # ...and the heavy byte download must NOT be reached.
    def no_download(*a, **k):
        raise AssertionError("download_item_slide must not run when the slide is local")

    monkeypatch.setattr(slide_resolver, "download_item_slide", no_download)

    settings = Settings(slides_root=tmp_path, girder_base="http://g.test/api/v1")
    dest = tmp_path / "dl"
    result = slide_resolver.resolve_slide(
        "6a3efdab9cb269b0b0bb615c", dest, settings, girder_token="tok"
    )
    assert result == slide


def test_resolve_downloads_when_name_lookup_fails(tmp_path, monkeypatch):
    """If the Girder name lookup yields nothing and no local file matches, fall back
    to the download path (resilience — a lookup failure must not crash preprocessing)."""
    from pathagent.common.config import Settings
    from pathagent.worker import slide_resolver

    monkeypatch.setattr(
        slide_resolver, "_girder_slide_file", lambda *a, **k: None, raising=False
    )
    captured = {}

    def fake_download(item_id, dest_dir, girder_base, girder_token=None, file_doc=None):
        captured["called"] = True
        return dest_dir / "downloaded.svs"

    monkeypatch.setattr(slide_resolver, "download_item_slide", fake_download)

    settings = Settings(slides_root=tmp_path, girder_base="http://g.test/api/v1")
    dest = tmp_path / "dl"
    result = slide_resolver.resolve_slide("itemX", dest, settings)
    assert result == dest / "downloaded.svs"
    assert captured["called"]


def test_resolve_name_match_picks_size_matching_slide(tmp_path, monkeypatch):
    """Filenames are not unique across cases. When two local slides share a name,
    the one whose byte size matches the Girder file doc must be chosen — never a
    different patient's same-named slide."""
    from pathagent.common.config import Settings
    from pathagent.worker import slide_resolver

    (tmp_path / "caseA").mkdir()
    (tmp_path / "caseB").mkdir()
    wrong = tmp_path / "caseA" / "slide.svs"
    wrong.write_bytes(b"x" * 10)  # size 10 — a different case's slide
    right = tmp_path / "caseB" / "slide.svs"
    right.write_bytes(b"y" * 20)  # size 20 — matches the Girder file doc below

    monkeypatch.setattr(
        slide_resolver,
        "_girder_slide_file",
        lambda item_id, girder_base, girder_token=None: {
            "_id": "f", "name": "slide.svs", "size": 20,
        },
        raising=False,
    )

    def no_download(*a, **k):
        raise AssertionError("must resolve locally by size, not download")

    monkeypatch.setattr(slide_resolver, "download_item_slide", no_download)

    settings = Settings(slides_root=tmp_path, girder_base="http://g.test/api/v1")
    result = slide_resolver.resolve_slide("itemA", tmp_path / "dl", settings)
    assert result == right


def test_resolve_name_match_rejects_hostile_name(tmp_path, monkeypatch):
    """A traversal-shaped Girder filename must never resolve locally; it falls
    through to the download path (which rejects it identically)."""
    from pathagent.common.config import Settings
    from pathagent.worker import slide_resolver

    (tmp_path / "real.svs").write_bytes(b"x")
    monkeypatch.setattr(
        slide_resolver,
        "_girder_slide_file",
        lambda *a, **k: {"_id": "f", "name": "../real.svs", "size": 1},
        raising=False,
    )
    captured = {}

    def fake_download(item_id, dest_dir, girder_base, girder_token=None, file_doc=None):
        captured["called"] = True
        return dest_dir / "downloaded.svs"

    monkeypatch.setattr(slide_resolver, "download_item_slide", fake_download)

    settings = Settings(slides_root=tmp_path, girder_base="http://g.test/api/v1")
    result = slide_resolver.resolve_slide("itemX", tmp_path / "dl", settings)
    assert result == (tmp_path / "dl") / "downloaded.svs"
    assert captured["called"]


def test_resolve_falls_back_to_download(tmp_path, monkeypatch):
    from pathagent.common.config import Settings
    from pathagent.worker import slide_resolver

    captured = {}

    def fake_download(item_id, dest_dir, girder_base, girder_token=None, file_doc=None):
        captured["args"] = (item_id, dest_dir, girder_base, girder_token)
        return dest_dir / "downloaded.svs"

    monkeypatch.setattr(slide_resolver, "download_item_slide", fake_download)
    settings = Settings(slides_root=None, girder_base="http://g.test/api/v1")

    dest = tmp_path / "dl"
    result = slide_resolver.resolve_slide("item42", dest, settings, girder_token="tok")

    assert result == dest / "downloaded.svs"
    assert captured["args"][2] == "http://g.test/api/v1"
    assert captured["args"][3] == "tok"
