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
    """Deterministic, order-stable id for an index build's parameters (legacy flat model)."""
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


# ── Content-addressed DAG (Inc 2b-3) ────────────────────────────────────────────────
# Three stages, each hash transitively including its ancestors, so identical upstream work is
# shared: segment-once → tile-many → encode-many. Mirrors Trident's own on-disk layout
# (contours_geojson/ → 20x_256px/patches → .../features_<enc>).


def _sha16(canonical: str) -> str:
    return hashlib.sha1(canonical.encode()).hexdigest()[:16]


def seg_hash(
    segmenter: str, seg_conf_thresh: float, remove_artifacts: bool,
    remove_holes: bool, remove_penmarks: bool, version: str,
) -> str:
    """Id for a tissue segmentation — depends only on the slide + segmenter params."""
    return _sha16(
        f"seg|s={segmenter}|conf={seg_conf_thresh:g}|art={int(remove_artifacts)}"
        f"|holes={int(remove_holes)}|pen={int(remove_penmarks)}|ver={version}"
    )


def patch_hash(parent: str, mag: int, patch_size: int, overlap: int, version: str) -> str:
    """Id for a patch grid — depends on its parent segmentation + tiling params."""
    return _sha16(f"patch|p={parent}|mag={mag}|ps={patch_size}|ov={overlap}|ver={version}")


def feat_hash(parent: str, encoder: str, version: str) -> str:
    """Id for a feature index — depends on its parent patch grid + encoder."""
    return _sha16(f"feat|p={parent}|enc={encoder}|ver={version}")


def seg_paths(cache_root: Path, item: str, sh: str) -> dict[str, Path]:
    """{contours} for a segmentation under {cache}/{item}/seg/{seg_hash}/."""
    d = _artifact_dir(cache_root, item, "seg", sh)
    return {"dir": d, "contours": d / "contours.geojson"}


def patch_paths(cache_root: Path, item: str, ph: str) -> dict[str, Path]:
    """{coords} for a patch grid under {cache}/{item}/patch/{patch_hash}/."""
    d = _artifact_dir(cache_root, item, "patch", ph)
    return {"dir": d, "coords": d / "coords.h5"}


def feat_paths(cache_root: Path, item: str, fh: str) -> dict[str, Path]:
    """{features} for a feature index under {cache}/{item}/feat/{feat_hash}/."""
    d = _artifact_dir(cache_root, item, "feat", fh)
    return {"dir": d, "features": d / "features.h5"}


def _artifact_dir(cache_root: Path, item: str, kind: str, ahash: str) -> Path:
    _validate_segment(item)
    _validate_segment(ahash)
    return Path(cache_root) / item / kind / ahash


def write_coords_h5(path: Path, coords: np.ndarray, attrs: dict) -> None:
    """Write level-0 patch coords [N, 2] + geometry attrs (the tiling-stage artifact)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with h5py.File(path, "w") as f:
        c = f.create_dataset("coords", data=np.asarray(coords))
        for k, v in attrs.items():
            c.attrs[k] = v


def read_coords_h5(path: Path) -> tuple[np.ndarray, dict]:
    """Return (coords, coords-attrs) from a coords h5."""
    with h5py.File(path, "r") as f:
        coords = f["coords"][:]
        attrs = {k: _plain(v) for k, v in f["coords"].attrs.items()}
    return coords, attrs


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
