"""Artifacts as handles (PathAgent v2, R9 — D4).

A server tool that produces bulk output (dense nuclei geometry, masks) writes the bytes to
an **ArtifactStore** and returns only a light **handle** — `{kind, ref, bbox, count,
summary, size}`. The typed event stream and the model's context carry the handle + a text
summary, *never* the geometry; the browser fetches the bytes **out-of-band** by `ref`.

This retires inline-JSONB for the loop's artifacts. R9 ships `InMemoryArtifactStore`;
`GirderAnnotationStore` (writing a DSA annotation the OSD layer renders natively — O2,
gated) swaps in behind this seam at R10/R11 without touching the loop or the handle shape.
"""

import json
import uuid
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class ArtifactHandle:
    """A reference to bulk output — deliberately geometry-free, so it can ride the event
    stream and the model's context without leaking the payload."""

    kind: str
    ref: str
    count: int
    summary: str
    bbox: dict | None = None
    size: int | None = None

    def to_dict(self) -> dict:
        return asdict(self)


class ArtifactStore(ABC):
    """Writes bulk tool output and hands back a light reference; reads it back by ref.

    Owner-scoped: `get` returns the payload only to the owner who wrote it (the `ref` is an
    unguessable capability on top of that).
    """

    @abstractmethod
    async def put(
        self,
        *,
        owner: str,
        conversation_id: int,
        kind: str,
        bbox: dict | None,
        geometry: dict,
        summary: str,
    ) -> ArtifactHandle:
        """Store `geometry`, return a handle carrying only its metadata."""

    @abstractmethod
    async def get(self, *, owner: str, ref: str) -> dict | None:
        """Return the stored geometry for the owner, or None if absent / not theirs."""


class InMemoryArtifactStore(ArtifactStore):
    """Process-local stub store — the R9 stand-in for the Girder DSA-annotation store."""

    def __init__(self) -> None:
        self._items: dict[str, dict] = {}

    async def put(self, *, owner, conversation_id, kind, bbox, geometry, summary):
        ref = uuid.uuid4().hex
        points = geometry.get("points", [])
        count = geometry.get("count", len(points))
        size = len(json.dumps(geometry, separators=(",", ":")))
        self._items[ref] = {"owner": owner, "conversation_id": conversation_id,
                            "geometry": geometry}
        return ArtifactHandle(
            kind=kind, ref=ref, count=count, summary=summary, bbox=bbox, size=size
        )

    async def get(self, *, owner, ref):
        rec = self._items.get(ref)
        if rec is None or rec["owner"] != owner:
            return None
        return rec["geometry"]


__all__ = ["ArtifactHandle", "ArtifactStore", "InMemoryArtifactStore"]
