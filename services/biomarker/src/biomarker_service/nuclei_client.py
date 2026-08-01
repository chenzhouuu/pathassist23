"""Biomarker service → the stored nuclei artifact (Inc 5, ticket 09).

Replaces asking CellViT to segment the same slide a second time. The map job needs, per read
window, the nuclei in it: level-0 centroids, PanNuke class names and rings. Those already exist —
the nuclei artifact stored them when it was built — so a whole-slide phenotype map now reads them
instead of paying for another whole-slide segmentation pass on the only GPU worker.

The dependency direction becomes the true one: a biomarker artifact is built *on* a nuclei
artifact (D9), which is why the gateway records it as the parent and why deleting the nuclei is
then refused while the biomarker exists.

Named for what it fetches. The function it replaces was ``fetch_centroids``, which was accurate
when a centroid was all CellViT gave back and stopped being accurate the moment rings were stored.
"""

from dataclasses import dataclass, field

import httpx


@dataclass(frozen=True)
class CellsResult:
    """One window's nuclei: level-0 ``[x, y]`` centroids, PanNuke names, rings, artifact ids."""

    centroids: list[list[float]]
    classes: list[str] = field(default_factory=list)
    contours: list[list[list[float]]] = field(default_factory=list)
    instances: list[int] = field(default_factory=list)
    # Whether every core the window touches has actually been computed. False means the answer is
    # honest but partial — the caller decides whether a partial window is usable.
    covered: bool = True


def fetch_cells(
    *,
    base_url: str,
    slide_ref: str,
    art_hash: str,
    bbox: dict,
    timeout: float = 300.0,
    client: httpx.Client | None = None,
) -> CellsResult:
    """The stored nuclei inside ``bbox``, in level-0 slide pixels."""
    spec = ",".join(str(int(round(float(bbox[k])))) for k in ("x", "y", "width", "height"))
    owns = client is None
    client = client or httpx.Client(base_url=base_url, timeout=timeout)
    try:
        resp = client.get(f"/nuclei/{slide_ref}/{art_hash}/cells", params={"bbox": spec})
        resp.raise_for_status()
        data = resp.json()
    finally:
        if owns:
            client.close()

    centroids = [[float(p[0]), float(p[1])] for p in data.get("centroids") or []]
    classes = list(data.get("classes") or [])
    # A nucleus with no ring degenerates to its centroid rather than dropping the detection —
    # the same rule the segmentation path used, kept so the two agree cell for cell.
    contours = data.get("contours") or [[c] for c in centroids]
    return CellsResult(
        centroids=centroids,
        classes=classes if len(classes) == len(centroids) else [],
        contours=contours,
        instances=[int(i) for i in data.get("instances") or []],
        covered=bool(data.get("covered", True)),
    )


__all__ = ["CellsResult", "fetch_cells"]
