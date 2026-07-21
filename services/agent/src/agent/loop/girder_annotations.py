"""Durable artifact store backed by Girder DSA annotations (R11 — D4).

Swaps in behind the ArtifactStore seam so a `run_segmentation`'s nuclei persist as a real
DSA annotation on the slide item: they survive reload, appear in the Annotations panel, and
render natively (`point` elements). The agent loop and the `ArtifactHandle` shape are
untouched — only where the bytes live changes.

Reads/writes go server-to-server with the caller's Girder token (D3, never a model arg),
against the same Girder the viewer is signed into (`settings.girder_base`).
"""

import httpx

from .artifacts import ArtifactHandle, ArtifactStore


class GirderAnnotationStore(ArtifactStore):
    """Persists bulk nuclei geometry as a DSA annotation; reads it back by annotation id."""

    def __init__(self, girder_base: str, client: httpx.AsyncClient | None = None) -> None:
        self._base = girder_base.rstrip("/")
        self._client = client

    def _acquire(self) -> tuple[httpx.AsyncClient, bool]:
        """Reuse an injected client (tests), else build a per-call one we must close."""
        if self._client is not None:
            return self._client, False
        return httpx.AsyncClient(base_url=self._base, timeout=30.0), True

    async def put(self, *, owner, conversation_id, kind, bbox, geometry, summary,
                  item_id=None, token=None) -> ArtifactHandle:
        points = geometry.get("points", [])
        count = geometry.get("count", len(points))
        elements = [
            {"type": "point", "center": [float(p[0]), float(p[1]), 0]} for p in points
        ]
        doc = {
            "name": f"Copilot nuclei · {count}",
            "description": _describe(count, bbox),
            "elements": elements,
        }
        client, owns = self._acquire()
        try:
            resp = await client.post(
                "/annotation", params={"itemId": item_id}, json=doc, headers=_auth(token),
            )
            resp.raise_for_status()
            ann_id = str(resp.json()["_id"])
        finally:
            if owns:
                await client.aclose()
        return ArtifactHandle(kind=kind, ref=ann_id, count=count, summary=summary, bbox=bbox)

    async def get(self, *, owner, ref, token=None) -> dict | None:
        client, owns = self._acquire()
        try:
            resp = await client.get(f"/annotation/{ref}", headers=_auth(token))
            if resp.status_code >= 400:
                return None  # inaccessible, gone, or a Girder error — degrade, never raise
            data = resp.json()
        except httpx.HTTPError:
            return None  # Girder unreachable/timeout — the overlay just won't render
        finally:
            if owns:
                await client.aclose()
        elements = (data.get("annotation") or {}).get("elements") or []
        points = [
            [float(el["center"][0]), float(el["center"][1])]
            for el in elements
            if el.get("type") == "point" and len(el.get("center") or ()) >= 2
        ]
        return {"kind": "nuclei", "count": len(points), "points": points}


def _auth(token: str | None) -> dict:
    return {"Girder-Token": token} if token else {}


def _describe(count: int, bbox: dict | None) -> str:
    if not bbox:
        return f"CellViT-SAM-H segmentation. {count} nuclei."
    x, y = int(bbox.get("x", 0)), int(bbox.get("y", 0))
    w, h = int(bbox.get("width", 0)), int(bbox.get("height", 0))
    return f"CellViT-SAM-H segmentation of a {w}x{h}px region at ({x}, {y}). {count} nuclei."


__all__ = ["GirderAnnotationStore"]
