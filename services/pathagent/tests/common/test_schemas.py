def test_preprocess_request_parses_camelcase():
    from pathagent.common.schemas import PreprocessRequest

    req = PreprocessRequest.model_validate(
        {
            "backbone": {"patchEncoder": "conch_v1", "mag": 20, "patchSize": 256},
            "consensus": {"patchEncoder": "conch_v1.5", "mag": 20, "patchSize": 512},
            "slidechat": True,
        }
    )
    assert req.backbone.patch_encoder == "conch_v1"
    assert req.consensus.patch_size == 512
    # dumps back to camelCase for the JS client
    assert req.model_dump(by_alias=True)["backbone"]["patchEncoder"] == "conch_v1"


def test_feature_spec_defaults():
    from pathagent.common.schemas import FeatureSpec

    spec = FeatureSpec(patchEncoder="conch_v1")
    assert spec.mag == 20 and spec.patch_size == 256


def test_preprocess_response_dumps_camelcase():
    from pathagent.common.schemas import JobStatus, PreprocessResponse

    resp = PreprocessResponse(job_id="j1", cache_key="item1-abc", status=JobStatus.queued)
    dumped = resp.model_dump(by_alias=True)
    assert dumped["jobId"] == "j1"
    assert dumped["cacheKey"] == "item1-abc"
    assert dumped["status"] == "queued"


def test_status_response_defaults():
    from pathagent.common.schemas import JobStatus, StatusResponse

    st = StatusResponse(status=JobStatus.queued)
    dumped = st.model_dump(by_alias=True)
    assert dumped["status"] == "queued"
    assert dumped["ready"] == {"features": False, "slidechat": False, "classifiers": False}


BRCA_SAMPLE = {
    "prediction": "IDC",
    "confidence": 90.1,
    "idc_prob": 90.1,
    "ilc_prob": 9.9,
    "top_patches": [2814, 2862],
    "top_coords": [[95744, 34304], [97280, 30720]],
    "top_scores": [0.91, 0.82],
    "patch_size_px": 256,
    "extract_mpp": 0.5,
    "num_patches": 4260,
    "model": "ABMIL-BRCA-5fold-ensemble",
    "auc": 0.9624,
}


def test_classifier_result_parses_brca_sample():
    from pathagent.common.schemas import ClassifierResult

    result = ClassifierResult.model_validate(BRCA_SAMPLE)
    assert result.prediction == "IDC"
    assert result.idc_prob == 90.1
    assert result.num_patches == 4260
    assert len(result.top_coords) == 2


def test_classifier_result_dumps_camelcase():
    from pathagent.common.schemas import ClassifierResult

    dumped = ClassifierResult.model_validate(BRCA_SAMPLE).model_dump(by_alias=True)
    for key in ("idcProb", "ilcProb", "topCoords", "numPatches", "patchSizePx", "extractMpp"):
        assert key in dumped


def test_manifest_dumps_camelcase_and_round_trips():
    from pathagent.common.schemas import FeatureSpec, Manifest

    manifest = Manifest(
        cache_key="item9-abc",
        item_id="item9",
        slide_name="slide.svs",
        backbone=FeatureSpec(patch_encoder="conch_v1", mag=20, patch_size=256),
        patch_count=1234,
        feature_dim=512,
        level0_width=100000,
        level0_height=80000,
        level0_magnification=40.0,
        target_magnification=20.0,
        patch_size_level0=512,
        overlap=0,
        pipeline_version="m1",
        artifacts={"features": "features.h5"},
    )

    dumped = manifest.model_dump(by_alias=True)
    assert dumped["patchCount"] == 1234
    assert dumped["featureDim"] == 512
    assert dumped["level0Width"] == 100000
    assert dumped["targetMagnification"] == 20.0
    assert dumped["patchSizeLevel0"] == 512

    assert Manifest.model_validate(dumped) == manifest
