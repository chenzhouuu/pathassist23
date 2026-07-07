from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import ValidationError

from ..common.cache_keys import cache_paths, compute_cache_key
from ..common.registry import Registry
from ..common.schemas import (
    ClassifierResult,
    JobStatus,
    PreprocessRequest,
    PreprocessResponse,
    StatusResponse,
)
from .auth import require_user
from .deps import get_queue, get_registry
from .queue import PreprocessQueue

API_PREFIX = "/api/agent"

router = APIRouter(prefix=API_PREFIX)


@router.post(
    "/cases/{item_id}/preprocess",
    response_model=PreprocessResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def preprocess(
    item_id: str,
    request: PreprocessRequest,
    user: dict = Depends(require_user),  # noqa: B008 - FastAPI DI idiom
    registry: Registry = Depends(get_registry),  # noqa: B008 - FastAPI DI idiom
    queue: PreprocessQueue = Depends(get_queue),  # noqa: B008 - FastAPI DI idiom
) -> PreprocessResponse:
    """Enqueue preprocessing for a case; short-circuit if already cached and ready."""
    try:
        cache_key = compute_cache_key(item_id, request)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="invalid itemId"
        ) from exc
    existing = registry.get_status(cache_key)
    if existing and existing.status == JobStatus.ready:
        return PreprocessResponse(job_id="cached", cache_key=cache_key, status=JobStatus.ready)
    registry.create(cache_key)
    job_id = queue.enqueue_preprocess(cache_key, item_id, request)
    return PreprocessResponse(job_id=job_id, cache_key=cache_key, status=JobStatus.queued)


@router.get("/cases/{item_id}/status", response_model=StatusResponse)
async def get_status(
    item_id: str,
    cacheKey: str,  # noqa: N803 - camelCase query param matches the wire contract
    user: dict = Depends(require_user),  # noqa: B008 - FastAPI DI idiom
    registry: Registry = Depends(get_registry),  # noqa: B008 - FastAPI DI idiom
) -> StatusResponse:
    """Return the current job status for a cache key, or an error status if unknown."""
    found = registry.get_status(cacheKey)
    if found is None:
        return StatusResponse(status=JobStatus.error, stage="unknown", error="no such cacheKey")
    return found


@router.get("/cases/{item_id}/classifier", response_model=ClassifierResult)
async def get_classifier(
    item_id: str,
    cacheKey: str,  # noqa: N803 - camelCase query param matches the wire contract
    user: dict = Depends(require_user),  # noqa: B008 - FastAPI DI idiom
) -> ClassifierResult:
    """Return the cached classifier result for a case, or 404 if not available."""
    try:
        paths = cache_paths(cacheKey)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="invalid cacheKey"
        ) from exc
    if not paths.classifier.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="classifier result not available"
        )
    try:
        return ClassifierResult.model_validate_json(paths.classifier.read_text())
    except (ValidationError, ValueError) as exc:
        # A corrupt/truncated cache file is treated as "not available", not a 500.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="classifier result not available"
        ) from exc
