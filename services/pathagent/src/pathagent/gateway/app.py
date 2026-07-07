from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis import Redis

from ..common.config import get_settings
from ..common.registry import Registry
from .queue import PreprocessQueue
from .routes import router


def create_app(redis_conn: Redis | None = None, queue: PreprocessQueue | None = None) -> FastAPI:
    """Build and configure the PathAgent FastAPI app (routes, shared state)."""
    settings = get_settings()
    conn = redis_conn or Redis.from_url(settings.redis_url)

    app = FastAPI(title="PathAgent Gateway", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        # The heatmap endpoint returns its level-0 extent via custom headers; browsers only
        # surface these to JS cross-origin when explicitly exposed (the M4 OSD overlay reads them).
        expose_headers=["X-Level0-X", "X-Level0-Y", "X-Level0-Width", "X-Level0-Height"],
    )
    app.state.settings = settings
    app.state.redis = conn
    app.state.registry = Registry(conn)
    app.state.queue = queue or PreprocessQueue(conn)
    app.include_router(router)
    return app
