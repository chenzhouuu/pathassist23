from pathvlm_service.config import Settings, get_settings


def test_defaults_use_the_stub_when_no_checkpoint():
    s = Settings()
    assert s.use_model is False  # no MedGemma checkpoint => GPU-free stub Perceptor
    assert s.perceptor_out_px == 512 and s.perceptor_default_mag == 20


def test_use_model_true_once_a_checkpoint_is_configured():
    assert Settings(medgemma_ckpt="google/medgemma-4b-it").use_model is True


def test_get_settings_reads_prefixed_env(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("PATHVLM_MEDGEMMA_CKPT", "/weights/medgemma")
    monkeypatch.setenv("PATHVLM_GIRDER_BASE", "http://g/api/v1")
    s = get_settings()
    assert s.use_model is True and s.girder_base == "http://g/api/v1"
    get_settings.cache_clear()


def test_idle_unload_defaults_to_fifteen_minutes_and_a_cold_start():
    """The shared GPU is the default: nothing resident until asked, released once quiet."""
    s = Settings()
    assert s.idle_ttl == 900.0
    assert s.warm_start is False


def test_idle_policy_is_env_overridable(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("PATHVLM_IDLE_TTL", "0")        # 0 = the old always-resident behaviour
    monkeypatch.setenv("PATHVLM_WARM_START", "true")
    s = get_settings()
    assert s.idle_ttl == 0.0 and s.warm_start is True
    get_settings.cache_clear()


def test_warm_start_flag_rejects_junk(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("PATHVLM_WARM_START", "maybe")
    assert get_settings().warm_start is False
    get_settings.cache_clear()
