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
