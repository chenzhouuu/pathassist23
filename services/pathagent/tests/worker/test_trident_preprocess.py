from pathlib import Path

import pytest


def _valid_manifest():
    from pathagent.common.cache_keys import PIPELINE_VERSION
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
        pipeline_version=PIPELINE_VERSION,
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


def _classifier_result():
    from pathagent.common.schemas import ClassifierResult

    return ClassifierResult(
        model="brca_abmil",
        prediction="IDC",
        confidence=0.91,
        idc_prob=0.91,
        ilc_prob=0.09,
        num_patches=7,
    )


def _consensus_payload():
    from pathagent.common.schemas import FeatureSpec, PreprocessRequest

    return PreprocessRequest(
        backbone=FeatureSpec(patch_encoder="conch_v1"),
        consensus=FeatureSpec(patch_encoder="uni_v1"),
    ).model_dump(by_alias=True)


def test_run_trident_preprocess_runs_classifier(job_redis, tmp_cache, monkeypatch):
    from pathagent.common.cache_keys import cache_paths
    from pathagent.common.registry import Registry
    from pathagent.common.schemas import ClassifierResult, JobStatus
    from pathagent.worker import trident_preprocess

    class FakeClassifierClient:
        def __init__(self, settings):
            self.settings = settings

        def predict(self, feature_path):
            return _classifier_result()

    paths = cache_paths("case-1")
    paths.root.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(
        trident_preprocess, "resolve_slide", lambda *a, **k: Path("/x/BRACS_1648.svs")
    )
    monkeypatch.setattr(trident_preprocess, "run_trident", lambda *a, **k: None)
    monkeypatch.setattr(
        trident_preprocess, "normalize_and_manifest", lambda *a, **k: _valid_manifest()
    )
    monkeypatch.setattr(
        trident_preprocess, "copy_features", lambda *a, **k: paths.features("uni_v1")
    )
    monkeypatch.setattr(trident_preprocess, "ClassifierClient", FakeClassifierClient)

    trident_preprocess.run_trident_preprocess("case-1", "BRACS_1648.svs", _consensus_payload())

    status = Registry(job_redis).get_status("case-1")
    assert status.status == JobStatus.ready
    assert status.ready.features is True
    assert status.ready.classifiers is True
    assert paths.classifier.is_file()
    written = ClassifierResult.model_validate_json(paths.classifier.read_text())
    assert written.prediction == "IDC"


def test_run_trident_preprocess_classifier_failure_non_fatal(job_redis, tmp_cache, monkeypatch):
    from pathagent.common.cache_keys import cache_paths
    from pathagent.common.registry import Registry
    from pathagent.common.schemas import JobStatus
    from pathagent.worker import trident_preprocess
    from pathagent.worker.classifier_client import ClassifierError

    class FailingClassifierClient:
        def __init__(self, settings):
            pass

        def predict(self, feature_path):
            raise ClassifierError("service down")

    paths = cache_paths("case-1")
    paths.root.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(
        trident_preprocess, "resolve_slide", lambda *a, **k: Path("/x/BRACS_1648.svs")
    )
    monkeypatch.setattr(trident_preprocess, "run_trident", lambda *a, **k: None)
    monkeypatch.setattr(
        trident_preprocess, "normalize_and_manifest", lambda *a, **k: _valid_manifest()
    )
    monkeypatch.setattr(
        trident_preprocess, "copy_features", lambda *a, **k: paths.features("uni_v1")
    )
    monkeypatch.setattr(trident_preprocess, "ClassifierClient", FailingClassifierClient)

    trident_preprocess.run_trident_preprocess("case-1", "BRACS_1648.svs", _consensus_payload())

    status = Registry(job_redis).get_status("case-1")
    assert status.status == JobStatus.ready
    assert status.ready.features is True
    assert status.ready.classifiers is False
    assert not paths.classifier.is_file()


def test_run_trident_preprocess_skips_classifier_without_consensus(
    job_redis, tmp_cache, monkeypatch
):
    from pathagent.common.registry import Registry
    from pathagent.common.schemas import JobStatus
    from pathagent.worker import trident_preprocess

    calls = []
    monkeypatch.setattr(
        trident_preprocess, "resolve_slide", lambda *a, **k: Path("/x/BRACS_1648.svs")
    )
    monkeypatch.setattr(trident_preprocess, "run_trident", lambda *a, **k: calls.append(1))
    monkeypatch.setattr(
        trident_preprocess, "normalize_and_manifest", lambda *a, **k: _valid_manifest()
    )

    trident_preprocess.run_trident_preprocess("case-1", "BRACS_1648.svs", _payload())

    status = Registry(job_redis).get_status("case-1")
    assert status.status == JobStatus.ready
    assert status.ready.classifiers is False
    assert len(calls) == 1
