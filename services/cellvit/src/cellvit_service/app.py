from fastapi import FastAPI, Request
from pydantic import BaseModel, Field

from .config import get_settings
from .geometry import offset_points
from .infer import segment_array
from .region import fetch_region


class Bbox(BaseModel):
    x: float
    y: float
    width: float
    height: float
    kind: str = "rect"
    unit: str = "px"


class SegmentRequest(BaseModel):
    slide_ref: str = Field(..., min_length=1)
    bbox: Bbox
    girder_token: str | None = None
    classes: list[str] | None = None


def create_app() -> FastAPI:
    """The CellViT inference service. Region-read → infer → re-offset, over HTTP."""
    app = FastAPI(title="CellViT Inference Service", version="0.1.0")
    app.state.read_region = fetch_region   # injectable seams (tests override these)
    app.state.segment = segment_array

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok", "service": "cellvit", "device": get_settings().device}

    @app.post("/segment")
    async def segment(body: SegmentRequest, request: Request) -> dict:
        settings = get_settings()
        bbox = body.bbox.model_dump()
        region = await request.app.state.read_region(
            girder_base=settings.girder_base, slide_ref=body.slide_ref,
            bbox=bbox, token=body.girder_token,
        )
        local = request.app.state.segment(region.pixels, region.mpp)
        centroids = offset_points(local, bbox["x"], bbox["y"], region.scale)
        return {"count": len(centroids), "centroids": centroids, "bbox": bbox}

    return app
