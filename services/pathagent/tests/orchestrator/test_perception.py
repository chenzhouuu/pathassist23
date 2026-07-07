import json
from types import SimpleNamespace

import h5py
import numpy as np
import pytest

CACHE_KEY = "slide1-deadbeef0000"


def _write_features(cache_key: str) -> None:
    """Write a synthetic ``features_conch_v1.h5`` at the case's cache path."""
    from pathagent.common.cache_keys import cache_paths

    paths = cache_paths(cache_key)
    paths.root.mkdir(parents=True, exist_ok=True)
    # 12 patches on a 4x3 grid of 256px level-0 patches.
    coords = np.array(
        [[c * 256, r * 256] for r in range(3) for c in range(4)], dtype=np.int64
    )
    rng = np.random.default_rng(0)
    with h5py.File(paths.features("conch_v1"), "w") as f:
        f.create_dataset("features", data=rng.random((12, 512), dtype=np.float32))
        ds = f.create_dataset("coords", data=coords)
        ds.attrs["patch_size_level0"] = 256
        ds.attrs["level0_width"] = 4096
        ds.attrs["level0_height"] = 4096


_CANNED = {
    "regions": [
        {
            "x": 512,
            "y": 256,
            "width": 256,
            "height": 256,
            "score": 0.9,
            "rationale": "matches: invasive ductal carcinoma",
        }
    ],
    "rasterExtent": {"x": 0, "y": 0, "width": 4096, "height": 4096},
    "gridShape": [4, 4],
    "kbHits": [
        {"id": "k1", "text": "IDC fact", "source": "WHO (seed)", "score": 0.7}
    ],
}


def _fake_run_factory(canned: dict, returncode: int = 0):
    """Build a fake ``subprocess.run`` that writes a dummy PNG and returns ``canned``."""

    def fake_run(cmd, **kwargs):
        req = json.loads(kwargs["input"])
        from pathlib import Path

        raster = Path(req["rasterPng"])
        raster.parent.mkdir(parents=True, exist_ok=True)
        raster.write_bytes(b"\x89PNG\r\n\x1a\n")  # dummy PNG bytes
        stdout = json.dumps(canned) if returncode == 0 else ""
        return SimpleNamespace(returncode=returncode, stdout=stdout, stderr="boom")

    return fake_run


def test_run_returns_navresult_and_writes_meta(tmp_cache, monkeypatch):
    from pathagent.common.cache_keys import cache_paths
    from pathagent.common.config import get_settings
    from pathagent.orchestrator import heatmap, perception

    _write_features(CACHE_KEY)
    monkeypatch.setattr(perception.subprocess, "run", _fake_run_factory(_CANNED))

    runner = perception.PerceptionRunner(get_settings())
    result = runner.run(CACHE_KEY, "is there carcinoma?", "task1")

    assert isinstance(result, perception.NavResult)
    assert result.regions == _CANNED["regions"]
    assert result.kb_hits == _CANNED["kbHits"]
    assert result.raster_extent == _CANNED["rasterExtent"]
    assert result.grid_shape == [4, 4]

    paths = cache_paths(CACHE_KEY)
    assert paths.heatmap("task1").is_file()  # dummy PNG written by the fake
    assert heatmap.read_meta(paths.heatmap_meta("task1")) == _CANNED["rasterExtent"]


def test_run_passes_request_fields_to_subprocess(tmp_cache, monkeypatch):
    from pathagent.common.config import get_settings
    from pathagent.orchestrator import perception
    from pathagent.orchestrator.concepts import DIAGNOSTIC_CONCEPTS

    _write_features(CACHE_KEY)
    captured: dict = {}

    def capturing_run(cmd, **kwargs):
        captured["req"] = json.loads(kwargs["input"])
        req = captured["req"]
        from pathlib import Path

        Path(req["rasterPng"]).parent.mkdir(parents=True, exist_ok=True)
        Path(req["rasterPng"]).write_bytes(b"\x89PNG")
        return SimpleNamespace(returncode=0, stdout=json.dumps(_CANNED), stderr="")

    monkeypatch.setattr(perception.subprocess, "run", capturing_run)
    runner = perception.PerceptionRunner(get_settings())
    roi = {"x": 0, "y": 0, "width": 512, "height": 512}
    runner.run(CACHE_KEY, "any carcinoma?", "taskX", roi=roi)

    req = captured["req"]
    assert req["question"] == "any carcinoma?"
    assert req["concepts"] == DIAGNOSTIC_CONCEPTS
    assert req["navTopK"] == get_settings().nav_top_k
    assert req["kbTopK"] == get_settings().kb_top_k
    assert req["roi"] == roi
    assert req["kbSnippets"]
    assert all({"id", "text", "source"} <= s.keys() for s in req["kbSnippets"])
    assert req["featuresH5"].endswith("features_conch_v1.h5")


def test_missing_features_raises(tmp_cache, monkeypatch):
    from pathagent.common.config import get_settings
    from pathagent.orchestrator import perception

    def boom_run(*_a, **_k):
        raise AssertionError("subprocess should not be launched when features are missing")

    monkeypatch.setattr(perception.subprocess, "run", boom_run)
    runner = perception.PerceptionRunner(get_settings())
    with pytest.raises(perception.PerceptionError):
        runner.run(CACHE_KEY, "q", "task1")


def test_nonzero_returncode_raises(tmp_cache, monkeypatch):
    from pathagent.common.config import get_settings
    from pathagent.orchestrator import perception

    _write_features(CACHE_KEY)
    monkeypatch.setattr(perception.subprocess, "run", _fake_run_factory(_CANNED, returncode=1))

    runner = perception.PerceptionRunner(get_settings())
    with pytest.raises(perception.PerceptionError):
        runner.run(CACHE_KEY, "q", "task1")


def test_non_json_stdout_raises(tmp_cache, monkeypatch):
    from pathagent.common.config import get_settings
    from pathagent.orchestrator import perception

    _write_features(CACHE_KEY)

    def bad_json_run(cmd, **kwargs):
        return SimpleNamespace(returncode=0, stdout="not json at all", stderr="")

    monkeypatch.setattr(perception.subprocess, "run", bad_json_run)
    runner = perception.PerceptionRunner(get_settings())
    with pytest.raises(perception.PerceptionError):
        runner.run(CACHE_KEY, "q", "task1")
