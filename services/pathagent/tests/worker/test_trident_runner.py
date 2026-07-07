import subprocess
from pathlib import Path

import pytest


def _idx_pair(cmd, flag, value):
    i = cmd.index(flag)
    assert cmd[i + 1] == value
    return i


def test_build_command_flags_and_order():
    from pathagent.common.config import Settings
    from pathagent.common.schemas import FeatureSpec
    from pathagent.worker.trident_runner import build_command

    settings = Settings(trident_python=Path("/opt/py"), trident_repo=Path("/opt/trident"))
    spec = FeatureSpec(patch_encoder="conch_v1", mag=20, patch_size=256)
    cmd = build_command(Path("/slides/s.svs"), Path("/jobs/j1"), spec, settings)

    assert cmd[0] == "/opt/py"
    assert cmd[1] == "/opt/trident/run_single_slide.py"

    i_enc = _idx_pair(cmd, "--patch_encoder", "conch_v1")
    i_mag = _idx_pair(cmd, "--mag", "20")
    i_ps = _idx_pair(cmd, "--patch_size", "256")
    i_ov = _idx_pair(cmd, "--overlap", "0")
    i_gpu = _idx_pair(cmd, "--gpu", "0")
    assert i_enc < i_mag < i_ps < i_ov < i_gpu


def test_run_trident_success_writes_log(tmp_path, monkeypatch):
    from pathagent.common.config import Settings
    from pathagent.common.schemas import FeatureSpec
    from pathagent.worker import trident_runner

    def fake_run(*_a, **_k):
        return subprocess.CompletedProcess(args=[], returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr(trident_runner.subprocess, "run", fake_run)

    job_dir = tmp_path / "job"
    spec = FeatureSpec(patch_encoder="conch_v1")
    trident_runner.run_trident(Path("/slides/s.svs"), job_dir, spec, Settings())

    log = job_dir / "trident.log"
    assert log.exists()
    assert "ok" in log.read_text()


def test_run_trident_failure_raises_and_logs(tmp_path, monkeypatch):
    from pathagent.common.config import Settings
    from pathagent.common.schemas import FeatureSpec
    from pathagent.worker import trident_runner

    def fake_run(*_a, **_k):
        return subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="boom")

    monkeypatch.setattr(trident_runner.subprocess, "run", fake_run)

    job_dir = tmp_path / "job"
    spec = FeatureSpec(patch_encoder="conch_v1")
    with pytest.raises(RuntimeError):
        trident_runner.run_trident(Path("/slides/s.svs"), job_dir, spec, Settings())

    log = job_dir / "trident.log"
    assert log.exists()
    assert "boom" in log.read_text()


def test_run_trident_timeout_writes_log_and_raises(tmp_path, monkeypatch):
    from pathagent.common.config import Settings
    from pathagent.common.schemas import FeatureSpec
    from pathagent.worker import trident_runner

    def fake_run(*_a, **_k):
        raise subprocess.TimeoutExpired(
            cmd=["trident"], timeout=1, output="partial-out", stderr="partial-err"
        )

    monkeypatch.setattr(trident_runner.subprocess, "run", fake_run)

    job_dir = tmp_path / "job"
    spec = FeatureSpec(patch_encoder="conch_v1")
    with pytest.raises(subprocess.TimeoutExpired):
        trident_runner.run_trident(Path("/slides/s.svs"), job_dir, spec, Settings())

    log = job_dir / "trident.log"
    assert log.exists()
    text = log.read_text()
    assert "partial-out" in text
    assert "partial-err" in text


def test_subprocess_env_propagates_hf_token(monkeypatch):
    from pathagent.worker.trident_runner import _subprocess_env

    monkeypatch.setenv("HF_TOKEN", "abc")
    monkeypatch.delenv("HUGGING_FACE_HUB_TOKEN", raising=False)
    env = _subprocess_env()
    assert env["HF_TOKEN"] == "abc"
    assert env["HUGGING_FACE_HUB_TOKEN"] == "abc"
