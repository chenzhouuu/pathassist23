from __future__ import annotations

import json
import logging
import math
import pickle
from pathlib import Path
from typing import Dict, Iterable, List, Optional

import joblib

from .config import Settings
from .utils import chunked


logger = logging.getLogger(__name__)


DEFAULT_CLASS_MAP = {
    0: "Background",
    1: "Neoplastic epithelial",
    2: "Inflammatory",
    3: "Connective",
    4: "Dead",
    5: "Non-neoplastic epithelial",
}

DEFAULT_CLASS_COLORS = {
    1: "rgb(230, 57, 70)",
    2: "rgb(42, 157, 143)",
    3: "rgb(244, 162, 97)",
    4: "rgb(107, 114, 128)",
    5: "rgb(59, 130, 246)",
}


def load_hovernet_output(path: Path) -> Dict:
    if path.suffix == ".dat":
        try:
            return joblib.load(path)
        except Exception:
            with path.open("rb") as fh:
                return pickle.load(fh)
    if path.suffix == ".json":
        return json.loads(path.read_text(encoding="utf-8"))
    raise RuntimeError(f"Unsupported HoVer-Net output file: {path}")


def build_class_map(settings: Settings) -> Dict[int, str]:
    if not settings.nuclei_type_map_json:
        return DEFAULT_CLASS_MAP
    payload = json.loads(settings.nuclei_type_map_json)
    return {int(k): v for k, v in payload.items()}


def _polygon_points(contour: Iterable) -> List[List[float]]:
    pts = []
    for point in contour:
        if len(point) < 2:
            continue
        pts.append([float(point[0]), float(point[1]), 0.0])
    if pts and pts[0] != pts[-1]:
        pts.append(pts[0])
    return pts


def hovernet_to_elements(instances: Dict, settings: Settings) -> List[Dict]:
    class_map = build_class_map(settings)
    elements: List[Dict] = []
    for inst_id, inst in instances.items():
        contour = inst.get("contour") or []
        if len(contour) < 3:
            continue
        nucleus_type = int(inst.get("type", 0) or 0)
        type_label = class_map.get(nucleus_type, f"Type {nucleus_type}")
        center = inst.get("centroid") or [
            sum(p[0] for p in contour) / len(contour),
            sum(p[1] for p in contour) / len(contour),
        ]
        group = f"{settings.annotation_group}:{type_label}"
        elements.append(
            {
                "type": "polyline",
                "id": str(inst_id),
                "closed": True,
                "points": _polygon_points(contour),
                "lineColor": DEFAULT_CLASS_COLORS.get(nucleus_type, "rgb(20, 184, 166)"),
                "lineWidth": settings.annotation_line_width,
                "fillColor": DEFAULT_CLASS_COLORS.get(nucleus_type, "rgb(20, 184, 166)"),
                "fillOpacity": settings.annotation_opacity,
                "group": group,
                "label": {"value": type_label},
                "center": [float(center[0]), float(center[1]), 0.0],
            }
        )
    return elements


def elements_to_annotation_docs(item_name: str, elements: List[Dict], settings: Settings) -> List[Dict]:
    docs = []
    total_chunks = max(1, math.ceil(len(elements) / settings.annotation_chunk_size))
    for idx, batch in enumerate(chunked(elements, settings.annotation_chunk_size), start=1):
        suffix = f" ({idx}/{total_chunks})" if total_chunks > 1 else ""
        docs.append(
            {
                "name": f"HoVer-Net nuclei{suffix}",
                "description": f"AI nuclei segmentation for {item_name}",
                "attributes": {
                    "tool": "PathAssistModel",
                    "model": settings.model_name,
                    "group": settings.annotation_group,
                },
                "elements": batch,
            }
        )
    return docs
