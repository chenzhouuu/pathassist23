from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ..common.config import get_settings
from ..loop import build_agent
from ..loop.artifacts import InMemoryArtifactStore
from ..loop.girder_annotations import GirderAnnotationStore
from ..store import PgPreprocessArtifactStore, PgStore
from .routes import router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Open the Postgres-backed store on startup, close it on shutdown.

    Only runs when the app is entered as an ASGI lifespan (uvicorn, or tests using
    `with TestClient(...)`). Plain `TestClient(create_app())` skips it, so the
    DB-free health tests never touch Postgres.
    """
    settings = get_settings()
    app.state.store = await PgStore.connect(settings.database_url)
    # The slide-index control plane (Inc 2b) shares the same pool + schema (one connect, one DDL).
    # The preprocess-DAG control plane (Inc 2b-3): one row per artifact (segment/patch/features).
    app.state.preprocess_artifacts = PgPreprocessArtifactStore(app.state.store.pool)
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
    app = FastAPI(title="PathAgent Copilot Gateway", version="0.7.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.settings = settings
    app.state.agent = build_agent(settings)          # SDK loop when keyed, else stub
    # Durable DSA-annotation store when real segmentation is on (nuclei survive reload and
    # show in the Annotations panel); the in-memory stub otherwise (dev/tests, keyless).
    app.state.artifacts = (
        GirderAnnotationStore(settings.girder_base)
        if settings.cellvit_service_url
        else InMemoryArtifactStore()
    )
    app.include_router(router)
    return app
