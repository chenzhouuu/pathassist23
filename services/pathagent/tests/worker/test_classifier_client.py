import httpx
import pytest
import respx

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


def _client():
    from pathagent.common.config import Settings
    from pathagent.worker.classifier_client import ClassifierClient

    return ClassifierClient(Settings(brca_service_url="http://svc"))


@respx.mock
def test_predict_happy_path():
    from pathagent.common.schemas import ClassifierResult

    route = respx.post("http://svc/predict").mock(
        return_value=httpx.Response(200, json=BRCA_SAMPLE)
    )

    result = _client().predict("/cache/features_uni_v1.h5")

    assert isinstance(result, ClassifierResult)
    assert result.prediction == "IDC"
    assert result.num_patches == 4260
    assert route.called
    sent = route.calls.last.request
    import json

    assert json.loads(sent.content)["feature_path"] == "/cache/features_uni_v1.h5"


@respx.mock
def test_predict_error_body_raises():
    from pathagent.worker.classifier_client import ClassifierError

    respx.post("http://svc/predict").mock(
        return_value=httpx.Response(200, json={"error": "Feature file not found: x"})
    )

    with pytest.raises(ClassifierError):
        _client().predict("/cache/missing.h5")


@respx.mock
def test_predict_http_500_raises():
    from pathagent.worker.classifier_client import ClassifierError

    respx.post("http://svc/predict").mock(return_value=httpx.Response(500))

    with pytest.raises(ClassifierError):
        _client().predict("/cache/features_uni_v1.h5")
