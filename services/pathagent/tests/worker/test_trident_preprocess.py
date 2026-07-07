from pathlib import Path

import pytest


def _valid_manifest():
    from pathagent.common.schemas import FeatureSpec, Manifest

    return Manifest(
        cache_key="case-1",
        item_id="BRACS_1648.svs",
        slide_name="BRACS_1648",
        backbone=FeatureSpec(patch_encoder="conch_v1"),
        patch_count=7,
        feature_dim=512,
        level0_width=83664,
        level0_height=64892,
        level0_magnification=40.0,
        target_magnification=20.0,
        patch_size_level0=512,
        overlap=0,
        pipeline_version="2",
        artifacts={"features": "features_conch_v1.h5"},
    )


def _payload():
    from pathagent.common.schemas import FeatureSpec, PreprocessRequest

    return PreprocessRequest(backbone=FeatureSpec(patch_encoder="conch_v1")).model_dump(
        by_alias=True
    )


def test_run_trident_preprocess_happy_path(job_redis, tmp_cache, monkeypatch):
    from pathagent.common.registry import Registry
    from pathagent.common.schemas import JobStatus
    from pathagent.worker import trident_preprocess

    stages = []
    orig_set_status = Registry.set_status

    def spy_set_status(self, cache_key, status):
        stages.append(status.stage)
        return orig_set_status(self, cache_key, status)

    monkeypatch.setattr(Registry, "set_status", spy_set_status)
    monkeypatch.setattr(
        trident_preprocess, "resolve_slide", lambda *a, **k: Path("/x/BRACS_1648.svs")
    )
    monkeypatch.setattr(trident_preprocess, "run_trident", lambda *a, **k: None)
    monkeypatch.setattr(
        trident_preprocess, "normalize_and_manifest", lambda *a, **k: _valid_manifest()
    )

    trident_preprocess.run_trident_preprocess("case-1", "BRACS_1648.svs", _payload())

    status = Registry(job_redis).get_status("case-1")
    assert status.status == JobStatus.ready
    assert status.ready.features is True
    assert stages[:3] == ["resolving", "segmentation", "manifest"]
    assert stages[-1] == "done"


def test_run_trident_preprocess_error_path(job_redis, tmp_cache, monkeypatch):
    from pathagent.common.registry import Registry
    from pathagent.common.schemas import JobStatus
    from pathagent.worker import trident_preprocess

    def boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(
        trident_preprocess, "resolve_slide", lambda *a, **k: Path("/x/BRACS_1648.svs")
    )
    monkeypatch.setattr(trident_preprocess, "run_trident", boom)
    monkeypatch.setattr(
        trident_preprocess, "normalize_and_manifest", lambda *a, **k: _valid_manifest()
    )

    with pytest.raises(RuntimeError, match="boom"):
        trident_preprocess.run_trident_preprocess("case-1", "BRACS_1648.svs", _payload())

    status = Registry(job_redis).get_status("case-1")
    assert status.status == JobStatus.error
    assert status.error == "boom"
