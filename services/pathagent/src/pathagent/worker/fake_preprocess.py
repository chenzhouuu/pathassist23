import json
import logging
from pathlib import Path
from typing import Any

from ..common import connection
from ..common.cache_keys import cache_paths
from ..common.registry import Registry
from ..common.schemas import JobStatus, ReadyFlags, StatusResponse

logger = logging.getLogger(__name__)


def run_fake_preprocess(cache_key: str, item_id: str, request_payload: dict[str, Any]) -> None:
    """M0 stand-in for the Trident worker: simulate stages, write a stub manifest, mark ready.

    Plan 2 (M1) replaces this with the real seg -> coords -> CONCH feature pipeline.
    """
    registry = Registry(connection.get_job_redis())
    try:
        registry.set_status(
            cache_key,
            StatusResponse(status=JobStatus.running, stage="segmentation", progress=0.1),
        )
        paths = cache_paths(cache_key)
        paths.root.mkdir(parents=True, exist_ok=True)
        _write_stub_manifest(paths.manifest, cache_key, item_id, request_payload)
        registry.set_status(
            cache_key,
            StatusResponse(
                status=JobStatus.ready,
                stage="done",
                progress=1.0,
                ready=ReadyFlags(features=True, slidechat=False, classifiers=False),
            ),
        )
        logger.info("fake preprocess complete: %s", cache_key)
    except Exception as exc:  # noqa: BLE001 - any failure becomes a visible job error
        logger.exception("fake preprocess failed: %s", cache_key)
        registry.set_status(
            cache_key,
            StatusResponse(status=JobStatus.error, stage="error", error=str(exc)),
        )
        raise


def _write_stub_manifest(
    path: Path, cache_key: str, item_id: str, request_payload: dict[str, Any]
) -> None:
    path.write_text(
        json.dumps(
            {"cacheKey": cache_key, "itemId": item_id, "request": request_payload, "stub": True},
            indent=2,
        )
    )
