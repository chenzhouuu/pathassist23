from agent.common.config import Settings, get_settings
from agent.gateway.routes import get_pathvlm_url


def test_settings_reads_pathvlm_service_url(monkeypatch):
    monkeypatch.setenv("AGENT_PATHVLM_SERVICE_URL", "http://pathvlm:8021")
    assert Settings().pathvlm_service_url == "http://pathvlm:8021"


def test_get_pathvlm_url_is_none_when_unset(monkeypatch):
    monkeypatch.setenv("AGENT_PATHVLM_SERVICE_URL", "")
    get_settings.cache_clear()
    try:
        assert get_pathvlm_url() is None
    finally:
        get_settings.cache_clear()
