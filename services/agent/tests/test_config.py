from agent.common.config import Settings


def test_girder_base_default_is_neutral_local_not_a_remote_dev_host():
    # The compile-time default must not name a specific remote dev host (it misleads readers
    # into thinking the copilot talks to it); compose injects AGENT_GIRDER_BASE at runtime.
    default = Settings.model_fields["girder_base"].default
    assert default == "http://localhost:9080/api/v1"
    assert "lymphoma" not in default


def test_preprocess_service_url_defaults_empty(monkeypatch):
    # Empty ⇒ find_regions / the preprocess routes report the service isn't configured.
    assert Settings.model_fields["preprocess_service_url"].default == ""
    monkeypatch.setenv("AGENT_PREPROCESS_SERVICE_URL", "http://preprocess:8030")
    assert Settings().preprocess_service_url == "http://preprocess:8030"
