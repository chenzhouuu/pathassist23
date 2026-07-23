from pathlib import Path

from preprocess_service.config import TEXT_CAPABLE_ENCODERS, Settings, get_settings


def test_defaults_use_the_stub_and_conch():
    s = Settings()
    assert s.use_trident is False  # no PREPROCESS_USE_TRIDENT => GPU-free stub pipeline
    assert s.girder_base == "http://localhost:9080/api/v1"
    assert s.slides_root is None  # no slides_root => resolver goes straight to download
    assert s.image_encoder == "conch_v15"  # image default
    assert s.text_encoder == "conch_v1"  # text-search default (conch_v15 has no text tower)
    assert isinstance(s.artifact_cache, Path) and str(s.artifact_cache)


def test_text_capability_excludes_conch_v15():
    s = Settings()
    assert s.is_text_capable("conch_v1") and s.is_text_capable("musk")
    assert not s.is_text_capable("conch_v15")  # F1: vision-only, no text tower
    assert not s.is_text_capable("uni_v2")
    assert TEXT_CAPABLE_ENCODERS == {"conch_v1", "musk"}


def test_use_trident_true_once_enabled():
    assert Settings(trident_enabled=True).use_trident is True


def test_get_settings_reads_prefixed_env(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("PREPROCESS_GIRDER_BASE", "http://g/api/v1")
    monkeypatch.setenv("PREPROCESS_SLIDES_ROOT", "/data2")
    monkeypatch.setenv("PREPROCESS_USE_TRIDENT", "1")
    s = get_settings()
    assert s.girder_base == "http://g/api/v1"
    assert s.slides_root == Path("/data2")
    assert s.use_trident is True
    get_settings.cache_clear()
