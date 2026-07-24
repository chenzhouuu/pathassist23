"""Gateway → biomarker inference service HTTP client (Inc 3a).

The ``phenotype_cells`` server tool calls this to fuse GigaTIME-Flash virtual biomarkers with
CellViT nuclei into per-cell phenotypes. The dense per-cell geometry returned here is written to
the artifact store by the caller and only a handle rides the event stream (D4). The Girder token
is sent server-to-server and is never a model argument (D3).
"""

from dataclasses import dataclass, field

import httpx


@dataclass(frozen=True)
class PhenotypeResult:
    """Per-cell phenotyping outcome: a cell count + per-lineage / per-flag tallies + the per-cell
    records (level-0 ``x, y``, lineage ``phenotype``, functional ``flags``, gate-deciding
    ``markers``), the markers that had a positive population this region, and the slide's µm/px."""

    count: int
    counts_by_phenotype: dict[str, int] = field(default_factory=dict)
    flag_counts: dict[str, int] = field(default_factory=dict)
    cells: list[dict] = field(default_factory=list)
    positive_markers: list[str] = field(default_factory=list)
    mpp: float | None = None


async def phenotype_cells(
    *,
    base_url: str,
    slide_ref: str,
    bbox: dict,
    focus: str | None = None,
    token: str | None,
    timeout: float = 300.0,
    client: httpx.AsyncClient | None = None,
) -> PhenotypeResult:
    """POST the ROI to the biomarker service; return per-cell phenotypes + tallies.

    The timeout is generous: the service runs GigaTIME-Flash windowed inference AND a CellViT
    segmentation for the region, both on a contended GPU."""
    payload = {"slide_ref": slide_ref, "bbox": bbox, "focus": focus, "girder_token": token}
    owns = client is None
    client = client or httpx.AsyncClient(base_url=base_url, timeout=timeout)
    try:
        resp = await client.post("/phenotype", json=payload)
        resp.raise_for_status()
        data = resp.json()
    finally:
        if owns:
            await client.aclose()
    mpp = data.get("mpp")
    return PhenotypeResult(
        count=int(data.get("count", 0)),
        counts_by_phenotype=data.get("counts_by_phenotype") or {},
        flag_counts=data.get("flag_counts") or {},
        cells=data.get("cells") or [],
        positive_markers=data.get("positive_markers") or [],
        mpp=float(mpp) if mpp else None,
    )
