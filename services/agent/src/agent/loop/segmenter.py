"""Gateway → CellViT inference service HTTP client (R11).

The ``run_segmentation`` server tool calls this to segment a region. The dense geometry
returned here is written to the artifact store by the caller and only a handle rides the
event stream (D4). The Girder token is sent server-to-server and is never a model argument
(D3).
"""

from dataclasses import dataclass

import httpx


@dataclass(frozen=True)
class SegmentResult:
    """Segmentation outcome: a nucleus count + level-0 ``[x, y]`` centroids, plus the slide's
    native µm/px (``mpp``, None if the slide has no metadata) so the caller can ground density."""

    count: int
    points: list[list[float]]
    mpp: float | None = None


async def segment_region(
    *,
    base_url: str,
    slide_ref: str,
    bbox: dict,
    token: str | None,
    timeout: float = 120.0,
    client: httpx.AsyncClient | None = None,
) -> SegmentResult:
    """POST the ROI to the CellViT service; return its count + level-0 centroids."""
    payload = {"slide_ref": slide_ref, "bbox": bbox, "girder_token": token}
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=timeout)
    try:
        resp = await client.post("/segment", json=payload)
        resp.raise_for_status()
        data = resp.json()
    finally:
        if owns:
            await client.aclose()
    centroids = [[float(p[0]), float(p[1])] for p in data.get("centroids", [])]
    mpp = data.get("mpp")
    return SegmentResult(
        count=int(data.get("count", len(centroids))),
        points=centroids,
        mpp=float(mpp) if mpp else None,
    )
