import logging

import httpx

from ..common.config import Settings
from ..common.schemas import ClassifierResult

logger = logging.getLogger(__name__)


class ClassifierError(RuntimeError):
    """Raised when the classifier service errors or returns an error body."""


class ClassifierClient:
    """Pluggable slide-level classifier backend (BRCA ABMIL /predict)."""

    def __init__(self, settings: Settings) -> None:
        self.base_url = settings.brca_service_url
        self.timeout = settings.classifier_timeout_s

    def predict(self, feature_path: str) -> ClassifierResult:
        """POST a UNI feature h5 path to /predict and parse the result."""
        try:
            resp = httpx.post(
                f"{self.base_url}/predict",
                json={"feature_path": feature_path},
                timeout=self.timeout,
            )
            resp.raise_for_status()
            body = resp.json()
        except httpx.HTTPError as exc:
            raise ClassifierError(f"classifier request failed: {exc}") from exc
        if isinstance(body, dict) and body.get("error"):
            raise ClassifierError(f"classifier error: {body['error']}")
        return ClassifierResult.model_validate(body)
