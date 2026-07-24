import biomarker_service.config as cfg
from biomarker_service.config import Settings


def test_defaults_load():
    s = Settings()
    assert s.girder_base.endswith("/api/v1")
    assert s.cellvit_url == "http://cellvit:8020"
    assert s.weights_file.endswith("/gigatime/model.pth")
    assert s.dev_stub is False


def test_mode_unavailable_without_weights_or_stub(tmp_path):
    s = Settings(weights_dir=str(tmp_path))  # empty dir → no model.pth
    assert s.has_weights is False
    assert s.mode == "unavailable"


def test_mode_stub_when_dev_stub_and_no_weights(tmp_path):
    s = Settings(weights_dir=str(tmp_path), dev_stub=True)
    assert s.mode == "stub"


def test_mode_real_when_weights_present(tmp_path):
    (tmp_path / "model.pth").write_bytes(b"x")
    s = Settings(weights_dir=str(tmp_path), dev_stub=True)  # weights win over dev_stub
    assert s.has_weights is True
    assert s.mode == "real"


def test_env_override(monkeypatch):
    cfg.get_settings.cache_clear()
    monkeypatch.setenv("BIOMARKER_DEV_STUB", "1")
    monkeypatch.setenv("BIOMARKER_CELLVIT_URL", "http://cv:9999")
    monkeypatch.setenv("BIOMARKER_INPUT_MPP", "0.5")
    s = cfg.get_settings()
    assert s.dev_stub is True and s.cellvit_url == "http://cv:9999"
    assert s.expected_input_mpp == 0.5
    cfg.get_settings.cache_clear()
