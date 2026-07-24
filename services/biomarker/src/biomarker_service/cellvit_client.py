"""Biomarker service → CellViT service HTTP client (fusion, design decision 5).

The dense mIF must never leave this process, but nuclei centroids are small, so the fusion
fetches them from the CellViT service (service→service) for the same bbox. CellViT returns
centroids already in **level-0** slide pixels + per-nucleus PanNuke class names; this service
maps them into its own region-local mIF raster via its own read scale (align.py). Sync
(httpx.Client) because the service is Flask; the Girder token is passed through, never a model
argument (D3).
"""

from dataclasses import dataclass, field

import httpx


@dataclass(frozen=True)
class CentroidResult:
    """CellViT output for the fusion: level-0 ``[x, y]`` centroids + aligned PanNuke class names."""

    centroids: list[list[float]]
    classes: list[str] = field(default_factory=list)
    mpp: float | None = None


def fetch_centroids(
    *,
    base_url: str,
    slide_ref: str,
    bbox: dict,
    token: str | None,
    timeout: float = 240.0,
    client: httpx.Client | None = None,
) -> CentroidResult:
    """POST the bbox to the CellViT service; return level-0 centroids + class names."""
    payload = {"slide_ref": slide_ref, "bbox": bbox, "girder_token": token}
    owns = client is None
    client = client or httpx.Client(base_url=base_url, timeout=timeout)
    try:
        resp = client.post("/segment", json=payload)
        resp.raise_for_status()
        data = resp.json()
    finally:
        if owns:
            client.close()
    centroids = [[float(p[0]), float(p[1])] for p in data.get("centroids", [])]
    # Translate class ids → PanNuke names once, here (the single translation point), aligned with
    # centroids; degrade to empty when a service omits them (keeps centroids usable).
    class_names = data.get("class_names") or {}
    names = [class_names.get(str(c)) for c in (data.get("classes") or [])]
    if len(names) != len(centroids):
        names = []
    mpp = data.get("mpp")
    return CentroidResult(centroids=centroids, classes=names, mpp=float(mpp) if mpp else None)
