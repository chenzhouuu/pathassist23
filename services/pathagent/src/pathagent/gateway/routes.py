from fastapi import APIRouter, Depends, HTTPException

from ..common.cache_keys import compute_cache_key
from ..common.registry import Registry
from ..common.schemas import JobStatus, PreprocessRequest, PreprocessResponse, StatusResponse
from .auth import require_user
from .deps import get_queue, get_registry
from .queue import PreprocessQueue

router = APIRouter(prefix="/api/agent")


@router.post("/cases/{item_id}/preprocess", response_model=PreprocessResponse, status_code=202)
async def preprocess(
    item_id: str,
    request: PreprocessRequest,
    user: dict = Depends(require_user),
    registry: Registry = Depends(get_registry),
    queue: PreprocessQueue = Depends(get_queue),
) -> PreprocessResponse:
    try:
        cache_key = compute_cache_key(item_id, request)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid itemId")
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
    user: dict = Depends(require_user),
    registry: Registry = Depends(get_registry),
) -> StatusResponse:
    found = registry.get_status(cacheKey)
    if found is None:
        return StatusResponse(status=JobStatus.error, stage="unknown", error="no such cacheKey")
    return found
