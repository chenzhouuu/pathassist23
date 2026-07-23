"""Girder file primitives for slide resolution (re-ported from the v1 pathagent worker, 75d5523^).

`find_item_slide_file` reads the item's largest WSI file doc (metadata only); `download_item_slide`
streams the bytes to a scratch dir. Both authenticate with the caller's Girder-Token and accept an
injectable httpx transport so tests never need a live Girder.
"""

import os
from pathlib import Path

import httpx

WSI_EXTS = (".svs", ".tif", ".tiff", ".ndpi", ".scn", ".mrxs", ".dcm")


def _validate_segment(seg: str) -> None:
    """Reject path traversal / separators in a value used to build a filesystem path."""
    if not isinstance(seg, str) or not seg:
        raise ValueError("empty path segment")
    if seg in (".", "..") or seg.startswith(("/", "~", "\\")):
        raise ValueError(f"unsafe path segment: {seg!r}")
    if "/" in seg or "\\" in seg or "\x00" in seg:
        raise ValueError(f"unsafe path segment: {seg!r}")


def _girder_headers(girder_token: str | None) -> dict:
    return {"Girder-Token": girder_token} if girder_token else {}


def find_item_slide_file(
    item_id: str,
    girder_base: str,
    girder_token: str | None = None,
    timeout: float = 60.0,
    *,
    transport: httpx.BaseTransport | None = None,
) -> dict:
    """Girder file doc of the item's largest WSI (metadata only, no bytes)."""
    _validate_segment(item_id)
    with httpx.Client(
        base_url=girder_base, headers=_girder_headers(girder_token),
        timeout=timeout, transport=transport,
    ) as client:
        r = client.get(f"/item/{item_id}/files")
        r.raise_for_status()
        files = r.json()
    wsi = [f for f in files if str(f.get("name", "")).lower().endswith(WSI_EXTS)]
    if not wsi:
        raise ValueError(f"no WSI file on Girder item {item_id}")
    return max(wsi, key=lambda f: f.get("size", 0))


def download_item_slide(
    item_id: str,
    dest_dir: Path,
    girder_base: str,
    girder_token: str | None = None,
    timeout: float = 300.0,
    *,
    file_doc: dict | None = None,
    transport: httpx.BaseTransport | None = None,
) -> Path:
    """Stream the item's largest WSI to ``dest_dir`` (atomic .part → replace). Returns the path."""
    target = file_doc or find_item_slide_file(
        item_id, girder_base, girder_token, timeout, transport=transport
    )
    raw_name = str(target["name"])
    _validate_segment(raw_name)
    name = Path(raw_name).name  # basename only → no arbitrary write outside dest_dir
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / name
    part = dest.with_suffix(dest.suffix + ".part")
    with httpx.Client(
        base_url=girder_base, headers=_girder_headers(girder_token),
        timeout=timeout, transport=transport,
    ) as client, client.stream("GET", f"/file/{target['_id']}/download") as resp:
        resp.raise_for_status()
        with part.open("wb") as fh:
            for chunk in resp.iter_bytes(chunk_size=1 << 20):
                fh.write(chunk)
    os.replace(part, dest)
    return dest
