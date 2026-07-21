from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ..chat import build_responder
from ..common.config import get_settings
from ..loop import build_agent
from ..loop.artifacts import InMemoryArtifactStore
from ..plan import build_planner
from ..store import PgStore
from .routes import router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Open the Postgres-backed store on startup, close it on shutdown.

    Only runs when the app is entered as an ASGI lifespan (uvicorn, or tests using
    `with TestClient(...)`). Plain `TestClient(create_app())` skips it, so the
    DB-free health/echo tests never touch Postgres.
    """
    settings = get_settings()
    app.state.store = await PgStore.connect(settings.database_url)
    try:
        yield
    finally:
        await app.state.store.close()


def create_app() -> FastAPI:
    """Build the Copilot gateway app (PathAgent v2).

    Factory form so tests can build a fresh app and override dependencies. Uvicorn
    runs it via ``agent.gateway.app:create_app --factory`` (see Dockerfile).
    """
    settings = get_settings()
    app = FastAPI(title="PathAgent Copilot Gateway", version="0.6.2", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.settings = settings
    app.state.responder = build_responder(settings)  # Claude when keyed, else echo
    app.state.planner = build_planner(settings)      # Claude when keyed, else stub
    app.state.agent = build_agent(settings)          # SDK loop when keyed, else stub
    app.state.artifacts = InMemoryArtifactStore()    # R9: artifact handles (D4)
    app.include_router(router)
    return app
