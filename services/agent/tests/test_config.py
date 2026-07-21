from agent.common.config import Settings


def test_girder_base_default_is_neutral_local_not_a_remote_dev_host():
    # The compile-time default must not name a specific remote dev host (it misleads readers
    # into thinking the copilot talks to it); compose injects AGENT_GIRDER_BASE at runtime.
    default = Settings.model_fields["girder_base"].default
    assert default == "http://localhost:9080/api/v1"
    assert "lymphoma" not in default
