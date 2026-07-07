import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import ValidationError
from sse_starlette import EventSourceResponse

from ..common.cache_keys import cache_paths, compute_cache_key
from ..common.config import get_settings
from ..common.registry import Registry
from ..common.schemas import (
    AgentQueryRequest,
    ClassifierResult,
    JobStatus,
    PreprocessRequest,
    PreprocessResponse,
    StatusResponse,
)
from ..orchestrator.graph import run_query
from ..orchestrator.heatmap import read_meta
from ..orchestrator.llm_client import LLMClient
from ..orchestrator.perception import PerceptionRunner
from ..orchestrator.state import Deps
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


@router.post("/query")
async def query(
    request: AgentQueryRequest,
    user: dict = Depends(require_user),  # noqa: B008 - FastAPI DI idiom
) -> EventSourceResponse:
    """Stream the M3 orchestrator's reasoning for a case question as SSE events.

    Loads the case's cached classifier (if any) to seed triage/consensus, builds
    a per-request :class:`Deps` bundle, and drives the LangGraph merged loop,
    emitting ``route`` -> ``triage`` -> ``navigate``/``describe`` -> ``diagnose``
    -> ``verify`` -> ``final`` events. A fresh ``task_id`` names the heatmap PNG
    the perception pass renders and rides on the terminal ``final`` event.
    """
    settings = get_settings()
    try:
        paths = cache_paths(request.cache_key)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="invalid cacheKey"
        ) from exc

    # The cache stores classifier.json camelCase (by_alias); the reasoning nodes
    # read snake_case, so validate + model_dump() to bridge the wire<->node gap
    # (raw json.loads would hand diagnose camelCase keys and KeyError mid-stream).
    classifier = None
    if paths.classifier.is_file():
        try:
            classifier = ClassifierResult.model_validate_json(
                paths.classifier.read_text()
            ).model_dump()
        except (ValidationError, ValueError):
            # A corrupt/mis-shaped classifier cache is treated as absent, not fatal.
            classifier = None

    deps = Deps(
        llm=LLMClient(settings),
        perception=PerceptionRunner(settings),
        settings=settings,
        classifier=classifier,
    )
    task_id = uuid.uuid4().hex

    async def event_source():
        """Yield SSE ``data:`` frames; a failure ends the stream with an error event."""
        try:
            async for event in run_query(request, deps, task_id):
                yield {"data": json.dumps(event)}
        except Exception as exc:  # noqa: BLE001 - stream must end with an error event, never a bare 500
            yield {"data": json.dumps({"type": "error", "message": str(exc)})}

    return EventSourceResponse(event_source())


@router.get("/cases/{item_id}/heatmap/{task_id}")
async def get_heatmap(
    item_id: str,
    task_id: str,
    cacheKey: str,  # noqa: N803 - camelCase query param matches the wire contract
    user: dict = Depends(require_user),  # noqa: B008 - FastAPI DI idiom
) -> FileResponse:
    """Return a query's rendered importance-heatmap PNG with its level-0 extent.

    The extent (level-0 ``x/y/width/height``) is surfaced as ``X-Level0-*``
    response headers so the viewer can georeference the overlay; a missing or
    malformed meta file simply omits the headers rather than failing the read.
    """
    try:
        paths = cache_paths(cacheKey)
        png = paths.heatmap(task_id)
        meta_path = paths.heatmap_meta(task_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="invalid id"
        ) from exc
    if not png.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="heatmap not available"
        )
    headers: dict[str, str] = {}
    if meta_path.is_file():
        try:
            meta = read_meta(meta_path)
            headers = {
                "X-Level0-X": str(meta["x"]),
                "X-Level0-Y": str(meta["y"]),
                "X-Level0-Width": str(meta["width"]),
                "X-Level0-Height": str(meta["height"]),
            }
        except (ValueError, KeyError):
            headers = {}
    return FileResponse(png, media_type="image/png", headers=headers)
