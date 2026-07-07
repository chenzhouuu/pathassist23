import os
from pathlib import Path

import httpx

from ..common.cache_keys import _validate_segment

WSI_EXTS = (".svs", ".tif", ".tiff", ".ndpi", ".scn", ".mrxs", ".dcm")


def download_item_slide(item_id: str, dest_dir: Path, girder_base: str,
                        girder_token: str | None = None, timeout: float = 300.0) -> Path:
    """Download the largest WSI file of a Girder item into dest_dir; return the path."""
    headers = {"Girder-Token": girder_token} if girder_token else {}
    with httpx.Client(base_url=girder_base, headers=headers, timeout=timeout) as client:
        r = client.get(f"/item/{item_id}/files")
        r.raise_for_status()
        files = r.json()
        if not files:
            raise ValueError(f"no files on Girder item {item_id}")
        wsi = [f for f in files if str(f.get("name", "")).lower().endswith(WSI_EXTS)]
        if not wsi:
            raise ValueError(f"no WSI file on Girder item {item_id}")
        target = max(wsi, key=lambda f: f.get("size", 0))

        # Guard against arbitrary-file-write via an attacker-controlled filename.
        raw_name = str(target["name"])
        _validate_segment(raw_name)
        name = Path(raw_name).name
        if not name:
            raise ValueError(f"invalid Girder filename: {raw_name!r}")

        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / name
        # Stream to a temp ".part" file and atomically rename, so a mid-stream
        # failure never leaves a truncated slide in place.
        part = dest.with_suffix(dest.suffix + ".part")
        with client.stream("GET", f"/file/{target['_id']}/download") as resp:
            resp.raise_for_status()
            with part.open("wb") as fh:
                for chunk in resp.iter_bytes(chunk_size=1 << 20):
                    fh.write(chunk)
        os.replace(part, dest)
    return dest
