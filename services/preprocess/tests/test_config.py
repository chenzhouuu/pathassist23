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
    # The default build target is the TEXT variant so a default index still powers Copilot
    # search; a downstream task asks for the vision variant in its own feature_spec.
    assert s.image_encoder == "conch_v1_text"
    assert s.text_encoder == "conch_v1_text"
    assert isinstance(s.artifact_cache, Path) and str(s.artifact_cache)


def test_text_capability_is_variant_specific():
    s = Settings()
    assert s.is_text_capable("conch_v1_text") and s.is_text_capable("musk")
    # The vision variant never entered the text space — searching it would be nonsense.
    assert not s.is_text_capable("conch_v1")
    assert not s.is_text_capable("conch_v15")  # F1: vision-only, no text tower
    assert not s.is_text_capable("uni_v2")
    assert TEXT_CAPABLE_ENCODERS == {"conch_v1_text", "musk"}


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


# ── the encoder variant split (Inc 2c) ──────────────────────────────────────────────


def test_conch_variants_are_distinct_ids_with_distinct_kwargs():
    from preprocess_service.config import encoder_kwargs, encoder_model

    # One checkpoint, two output spaces. `conch_v1` takes Trident's defaults (the vision tower
    # embedding every hgmil MIL model trained on); `conch_v1_text` adds the contrastive projection
    # find_regions searches. Measured per-patch cosine between them is ~0.005 — near-orthogonal.
    assert encoder_kwargs("conch_v1") == {}
    assert encoder_kwargs("conch_v1_text") == {"with_proj": True, "normalize": True}
    assert encoder_model("conch_v1") == encoder_model("conch_v1_text") == "conch_v1"


def test_encoder_kwargs_is_a_copy_so_callers_cannot_mutate_the_catalog():
    from preprocess_service.config import ENCODER_KWARGS, encoder_kwargs

    got = encoder_kwargs("conch_v1_text")
    got["normalize"] = False
    assert ENCODER_KWARGS["conch_v1_text"]["normalize"] is True


def test_unknown_encoders_take_trident_defaults():
    from preprocess_service.config import encoder_kwargs, encoder_model

    assert encoder_kwargs("uni_v2") == {} and encoder_model("uni_v2") == "uni_v2"


def test_the_two_variants_cannot_share_a_feat_hash():
    from preprocess_service.artifacts import feat_hash

    assert (feat_hash("p1", "conch_v1", "v2", "stub")
            != feat_hash("p1", "conch_v1_text", "v2", "stub"))


def test_feat_version_is_independent_of_index_version():
    # Splitting the variants changed what `conch_v1` MEANS, so pre-split feature artifacts had to
    # be invalidated — but the segmentations and patch grids under them are still correct and
    # expensive, so features carry their own version.
    from preprocess_service.artifacts import feat_hash

    s = get_settings.__wrapped__()
    assert s.feat_version == "v2" and s.index_version == "v1"
    assert feat_hash("p1", "conch_v1", "v1", "stub") != feat_hash("p1", "conch_v1", "v2", "stub")
