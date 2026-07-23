"""Artifact cache: where Trident h5 outputs live, keyed by a deterministic params hash.

The TissueLab split — arrays (features/coords h5, contours GeoJSON) are files under a
params-hash-keyed cache dir (the always-available sink, F3); the Postgres slide_index row (owned by
the gateway) is the durable record that points here. h5 layout mirrors Trident's features file:
an `features` [N, dim] dataset and an index-aligned level-0 `coords` [N, 2] dataset carrying the
patch geometry attrs.
"""

import hashlib
import json
from pathlib import Path

import h5py
import numpy as np

from .girder_download import _validate_segment


def params_hash(
    encoder: str, mag: int, patch_size: int, segmenter: str, version: str
) -> str:
    """Deterministic, order-stable id for an index build's parameters."""
    canonical = f"enc={encoder}|mag={mag}|ps={patch_size}|seg={segmenter}|ver={version}"
    return hashlib.sha1(canonical.encode()).hexdigest()[:16]


def cache_paths(cache_root: Path, item: str, phash: str) -> dict[str, Path]:
    """The {features, coords, contours} paths for an index under {cache}/{item}/{hash}/."""
    _validate_segment(item)
    _validate_segment(phash)
    d = Path(cache_root) / item / phash
    return {
        "dir": d,
        "features": d / "features.h5",
        "coords": d / "coords.h5",
        "contours": d / "contours.geojson",
    }


def write_features_h5(
    path: Path, features: np.ndarray, coords: np.ndarray, attrs: dict
) -> None:
    """Write features [N, dim] + index-aligned level-0 coords [N, 2] with geometry attrs."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with h5py.File(path, "w") as f:
        f.create_dataset("features", data=np.asarray(features))
        c = f.create_dataset("coords", data=np.asarray(coords))
        for k, v in attrs.items():
            c.attrs[k] = v


def read_features_h5(path: Path) -> tuple[np.ndarray, np.ndarray, dict]:
    """Return (features, coords, coords-attrs) from a features h5."""
    with h5py.File(path, "r") as f:
        features = f["features"][:]
        coords = f["coords"][:]
        attrs = {k: _plain(v) for k, v in f["coords"].attrs.items()}
    return features, coords, attrs


def write_contours_geojson(path: Path, geojson: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(geojson))


def _plain(v):
    """Coerce h5py scalar attrs to plain Python for JSON/asserts."""
    if isinstance(v, np.generic):
        return v.item()
    if isinstance(v, bytes):
        return v.decode()
    return v
