import logging
from pathlib import Path
from typing import Any

from ..common import connection
from ..common.cache_keys import cache_paths
from ..common.config import get_settings
from ..common.registry import Registry
from ..common.schemas import FeatureSpec, JobStatus, PreprocessRequest, ReadyFlags, StatusResponse
from .artifacts import copy_features, normalize_and_manifest
from .classifier_client import ClassifierClient
from .slide_resolver import resolve_slide
from .trident_runner import run_trident

logger = logging.getLogger(__name__)


def run_trident_preprocess(cache_key: str, item_id: str, request_payload: dict[str, Any]) -> None:
    """Real M1 worker: resolve slide -> Trident seg/coords/CONCH -> normalize -> ready."""
    settings = get_settings()
    registry = Registry(connection.get_job_redis())
    request = PreprocessRequest.model_validate(request_payload)
    spec: FeatureSpec = request.backbone
    paths = cache_paths(cache_key)
    job_dir = paths.root / "trident"
    try:
        registry.set_status(
            cache_key,
            StatusResponse(status=JobStatus.running, stage="resolving", progress=0.05),
        )
        slide_path = resolve_slide(item_id, paths.root / "download", settings)
        registry.set_status(
            cache_key,
            StatusResponse(status=JobStatus.running, stage="segmentation", progress=0.2),
        )
        run_trident(Path(slide_path), job_dir, spec, settings)
        registry.set_status(
            cache_key,
            StatusResponse(status=JobStatus.running, stage="manifest", progress=0.9),
        )
        normalize_and_manifest(
            job_dir, Path(slide_path).stem, item_id, cache_key, spec,
            settings.default_overlap, paths,
        )
        classifiers_ok = False
        consensus = request.consensus
        if settings.classifier_enabled and consensus is not None:
            try:
                registry.set_status(cache_key, StatusResponse(
                    status=JobStatus.running, stage="consensus", progress=0.6))
                run_trident(Path(slide_path), job_dir, consensus, settings)
                feat_path = copy_features(
                    job_dir, Path(slide_path).stem, consensus, settings.default_overlap, paths)
                registry.set_status(cache_key, StatusResponse(
                    status=JobStatus.running, stage="classifier", progress=0.85))
                result = ClassifierClient(settings).predict(str(feat_path))
                paths.classifier.write_text(result.model_dump_json(by_alias=True, indent=2))
                classifiers_ok = True
            except Exception:  # noqa: BLE001 - classifier is best-effort; features stay ready
                logger.exception("classifier pass failed (non-fatal): %s", cache_key)
        registry.set_status(
            cache_key,
            StatusResponse(
                status=JobStatus.ready,
                stage="done",
                progress=1.0,
                ready=ReadyFlags(features=True, slidechat=False, classifiers=classifiers_ok),
            ),
        )
        logger.info("trident preprocess complete: %s", cache_key)
    except Exception as exc:  # noqa: BLE001 - any failure becomes a visible job error
        logger.exception("trident preprocess failed: %s", cache_key)
        registry.set_status(
            cache_key,
            StatusResponse(status=JobStatus.error, stage="error", error=str(exc)),
        )
        raise
