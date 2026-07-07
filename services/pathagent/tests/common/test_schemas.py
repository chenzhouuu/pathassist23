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
