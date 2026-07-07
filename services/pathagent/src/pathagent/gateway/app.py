import json

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from redis import Redis

from ..common.config import get_settings
from ..common.registry import Registry
from .auth import require_user
from .queue import PreprocessQueue
from .routes import API_PREFIX, router


def create_app(redis_conn: Redis | None = None, queue: PreprocessQueue | None = None) -> FastAPI:
    """Build and configure the PathAgent FastAPI app (routes, stubs, shared state)."""
    settings = get_settings()
    conn = redis_conn or Redis.from_url(settings.redis_url)

    app = FastAPI(title="PathAgent Gateway", version="0.1.0")
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )
    app.state.settings = settings
    app.state.redis = conn
    app.state.registry = Registry(conn)
    app.state.queue = queue or PreprocessQueue(conn)
    app.include_router(router)
    _add_stubs(app)
    return app


def _add_stubs(app: FastAPI) -> None:
    """M0 placeholders so the frontend (Plan 5) can integrate early.

    Plan 4 (M3) replaces /query with the LangGraph orchestrator and adds the real heatmap tiles.
    """

    @app.post(f"{API_PREFIX}/query")
    async def query_stub(payload: dict, user: dict = Depends(require_user)) -> StreamingResponse:
        events = [
            {"type": "route", "task": "Diagnosis", "tools": ["navigate", "verify"]},
            {"type": "triage", "risk": "unknown", "depth": 3},
            {"type": "navigate", "region": {"x": 0, "y": 0, "width": 1024, "height": 1024},
             "zoom": 20, "rationale": "stub region"},
            {"type": "final", "answer": "stub answer", "confidence": 0.0,
             "heatmapTaskId": "stub", "trail": [], "annotations": []},
        ]

        def gen():
            for event in events:
                yield f"data: {json.dumps(event)}\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    @app.get(f"{API_PREFIX}/cases/{{item_id}}/heatmap/{{task_id}}")
    async def heatmap_stub(
        item_id: str, task_id: str, user: dict = Depends(require_user)
    ) -> dict:
        return {"stub": True, "itemId": item_id, "taskId": task_id}
