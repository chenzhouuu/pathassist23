from fastapi import FastAPI

from .config import get_settings


def create_app() -> FastAPI:
    """The CellViT inference service. Region-read → infer → re-offset, over HTTP."""
    app = FastAPI(title="CellViT Inference Service", version="0.1.0")

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok", "service": "cellvit", "device": get_settings().device}

    return app
