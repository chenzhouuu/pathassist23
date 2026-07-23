import os
from pathlib import Path

from preprocess_service.config import (
    TEXT_CAPABLE_ENCODERS,
    Settings,
    apply_model_cache_env,
    get_settings,
)


def test_defaults_use_the_stub_and_conch():
    s = Settings()
    assert s.use_trident is False  # no PREPROCESS_USE_TRIDENT => GPU-free stub pipeline
    assert s.girder_base == "http://localhost:9080/api/v1"
    assert s.slides_root is None  # no slides_root => resolver goes straight to download
    assert s.image_encoder == "conch_v1"  # default build encoder (vision-language, seeded)
    assert s.text_encoder == "conch_v1"  # text-search default
    assert isinstance(s.artifact_cache, Path) and str(s.artifact_cache)


def test_text_capability_excludes_conch_v15():
    s = Settings()
    assert s.is_text_capable("conch_v1") and s.is_text_capable("musk")
    assert not s.is_text_capable("conch_v15")  # F1: vision-only, no text tower
    assert not s.is_text_capable("uni_v2")
    assert TEXT_CAPABLE_ENCODERS == {"conch_v1", "musk"}


def test_use_trident_true_once_enabled():
    assert Settings(trident_enabled=True).use_trident is True


def test_batch_limit_default_and_env(monkeypatch):
    assert Settings().batch_limit == 128  # GPU-sharing-safe default
    get_settings.cache_clear()
    monkeypatch.setenv("PREPROCESS_BATCH_LIMIT", "64")
    assert get_settings().batch_limit == 64
    get_settings.cache_clear()


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


def test_weight_cache_dirs_read_from_env(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("PREPROCESS_HF_HOME", "/home/chen/data2/hf")
    monkeypatch.setenv("PREPROCESS_TRIDENT_HOME", "/home/chen/data2/trident")
    s = get_settings()
    assert s.hf_home == Path("/home/chen/data2/hf")
    assert s.trident_home == Path("/home/chen/data2/trident")
    get_settings.cache_clear()


def test_weight_cache_dirs_default_to_none():
    # Unset => leave the process env untouched (Docker ENV / defaults still win).
    assert Settings().hf_home is None
    assert Settings().trident_home is None


def test_apply_model_cache_env_points_hf_and_trident_at_data2(monkeypatch):
    monkeypatch.delenv("HF_HOME", raising=False)
    monkeypatch.delenv("TRIDENT_HOME", raising=False)
    apply_model_cache_env(Settings(
        hf_home=Path("/home/chen/data2/hf"),
        trident_home=Path("/home/chen/data2/trident"),
    ))
    assert os.environ["HF_HOME"] == "/home/chen/data2/hf"
    assert os.environ["TRIDENT_HOME"] == "/home/chen/data2/trident"


def test_apply_model_cache_env_leaves_env_untouched_when_none(monkeypatch):
    monkeypatch.setenv("HF_HOME", "/preexisting")
    apply_model_cache_env(Settings())  # both None
    assert os.environ["HF_HOME"] == "/preexisting"
