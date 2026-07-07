from pathlib import Path


def test_defaults():
    from pathagent.common.config import Settings

    s = Settings()
    assert s.redis_url.startswith("redis://")
    assert s.default_patch_encoder == "conch_v1"
    assert s.default_mag == 20


def test_env_override(monkeypatch):
    from pathagent.common.config import get_settings

    monkeypatch.setenv("PATHAGENT_REDIS_URL", "redis://example:6379/2")
    monkeypatch.setenv("PATHAGENT_CACHE_DIR", "/tmp/pa-cache")
    get_settings.cache_clear()
    s = get_settings()
    assert s.redis_url == "redis://example:6379/2"
    assert s.cache_dir == Path("/tmp/pa-cache")
    get_settings.cache_clear()
