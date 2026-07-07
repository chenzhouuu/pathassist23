"""Read/write helpers for importance-heatmap extent metadata.

The perception subprocess renders an importance PNG and reports the level-0
pixel rectangle it covers; this module persists that rectangle alongside the
PNG so the viewer can place the overlay.
"""

import json
from pathlib import Path


def write_meta(meta_path: Path, extent: dict) -> None:
    """Write the heatmap extent ``{x, y, width, height}`` as JSON.

    Args:
        meta_path: Destination JSON path (parent dirs are created).
        extent: Mapping with integer ``x``, ``y``, ``width``, ``height`` keys.
    """
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "x": extent["x"],
        "y": extent["y"],
        "width": extent["width"],
        "height": extent["height"],
    }
    meta_path.write_text(json.dumps(payload))


def read_meta(meta_path: Path) -> dict:
    """Load heatmap extent metadata JSON into a dict."""
    return json.loads(meta_path.read_text())
