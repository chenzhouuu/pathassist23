"""Gateway → CellViT inference service HTTP client (R11).

The ``run_segmentation`` server tool calls this to segment a region. The dense geometry
returned here is written to the artifact store by the caller and only a handle rides the
event stream (D4). The Girder token is sent server-to-server and is never a model argument
(D3).
"""

from dataclasses import dataclass, field

import httpx


@dataclass(frozen=True)
class SegmentResult:
    """Segmentation outcome: a nucleus count + level-0 ``[x, y]`` centroids, the slide's native
    µm/px (``mpp``, None if unknown), the per-nucleus PanNuke class **name** (``classes``, aligned
    with ``points``), and the per-class breakdown (``counts_by_type``, by name)."""

    count: int
    points: list[list[float]]
    mpp: float | None = None
    classes: list[str] = field(default_factory=list)
    counts_by_type: dict[str, int] = field(default_factory=dict)


async def segment_region(
    *,
    base_url: str,
    slide_ref: str,
    bbox: dict,
    token: str | None,
    timeout: float = 240.0,
    client: httpx.AsyncClient | None = None,
) -> SegmentResult:
    """POST the ROI to the CellViT service; return its count + level-0 centroids.

    The timeout is generous because a 20x slide must be upsampled to the x40 model's mpp — a
    slow arbitrary rescale — so a large region can take a few minutes on a contended GPU."""
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
    # The single int->name translation point: map the wire's class ids through class_names, so
    # every consumer past here sees a PanNuke name (D-F1). Degrade to empty when a service that
    # predates typed counts (or the stub) omits them, keeping points usable.
    class_names = data.get("class_names") or {}
    names = [class_names.get(str(c)) for c in (data.get("classes") or [])]
    if len(names) != len(centroids):
        names = []
    return SegmentResult(
        count=int(data.get("count", len(centroids))),
        points=centroids,
        mpp=float(mpp) if mpp else None,
        classes=names,
        counts_by_type=data.get("counts_by_type") or {},
    )
