"""Content-addressed layout for a slide's virtual-mIF artifact (Inc 3b, design §5).

One artifact per (slide segmentation × resolutions × pipeline version). Deliberately **not** per
bbox: repeated region jobs accumulate into the same artifact and record what they computed in a
coverage set (D6), so framing a second region extends the map instead of forking it.

    /cache/{item}/biomarker/{art_hash}/
      meta.json      params, slide dims, per-layer level_offset, thresholds, threshold_rev
      coverage.json  {"core": 4096, "done": [[tx, ty], ...]}   level-0 core-tile indices
      summary.json   counts_by_phenotype, flag_counts, n_cells, ...
      markers/{z}/{x}_{y}.npz    20 named uint8[256,256] planes
      pheno/{z}/{x}_{y}.png      paletted, index 0 = transparent background
      cells/{x}_{y}.npz          per-core-tile cell records
"""

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

# Bump when anything that changes the *numbers* changes: model, pooling, gate table, tiling.
PIPELINE_VERSION = "inc3b-3"   # feathered windows AND chunks

# Job unit of work, level-0 px. The halo is what makes nuclei on a seam whole (review B1); the
# core size is set by a memory budget the design got wrong:
#
#   the whole haloed window's mIF must be resident to pool full-resolution disks, and
#   4096 core + 256 halo = 4608² × 23 ch × float32 = 1.95 GB — per tile.
#
# At 2048 the window is 2560² and the mIF, quantised to uint8 (exactly the precision the pyramid
# stores anyway), is 151 MB. 2560 still clears cellvit's `_min_native_side` (~1143 px at 0.25 µm/px)
# so `_pad_to_min` stays the no-op it was designed to be, and pooling stays full-resolution —
# strictly better than Inc 3a's sub-tile approximation, which truncated disks at every 512 seam.
CORE = 2048
HALO = 256

# Output pyramid tile side, both layers.
TILE = 256
# Marker planes are stored at 1 µm/px ≈ 4x the 0.25 µm/px slide, i.e. 2 octaves coarser; the
# phenotype raster is native. Layers declare the SLIDE's dimensions and carry this offset so both
# register against the H&E in OpenSeadragon (review S1).
LAYER_LEVEL_OFFSET = {"markers": 2, "pheno": 0}

_SAFE = re.compile(r"^[A-Za-z0-9._-]+$")


def _safe(seg: str) -> str:
    """Reject anything that could escape the cache root (mirrors preprocess's _validate_segment)."""
    if not seg or not _SAFE.match(seg) or seg in {".", ".."}:
        raise ValueError(f"unsafe path segment: {seg!r}")
    return seg


def art_hash(
    *, seg_hash: str, marker_mpp: float, pheno_mpp: float,
    nucleus_radius_um: float, version: str = PIPELINE_VERSION,
) -> str:
    """Deterministic id for a slide's biomarker artifact.

    ``bbox`` is deliberately absent — it is coverage, not identity (D6). ``seg_hash`` transitively
    carries the slide and the segmenter params.
    """
    canonical = (
        f"bio|p={seg_hash}|mres={marker_mpp:g}|pres={pheno_mpp:g}"
        f"|rad={nucleus_radius_um:g}|ver={version}"
    )
    return hashlib.sha1(canonical.encode()).hexdigest()[:16]


def artifact_dir(cache_root: Path | str, item: str, ahash: str) -> Path:
    return Path(cache_root) / _safe(item) / "biomarker" / _safe(ahash)


def marker_tile_path(root: Path, z: int, x: int, y: int) -> Path:
    return root / "markers" / str(int(z)) / f"{int(x)}_{int(y)}.npz"


def pheno_tile_path(root: Path, z: int, x: int, y: int) -> Path:
    return root / "pheno" / str(int(z)) / f"{int(x)}_{int(y)}.png"


def cells_path(root: Path, tx: int, ty: int) -> Path:
    return root / "cells" / f"{int(tx)}_{int(ty)}.npz"


def meta_path(root: Path) -> Path:
    return root / "meta.json"


def summary_path(root: Path) -> Path:
    return root / "summary.json"


def read_json(path: Path) -> dict | None:
    if not path.is_file():
        return None
    with open(path) as fh:
        return json.load(fh)


def write_json(path: Path, doc: dict) -> None:
    """Atomic-ish write: a reader mid-job must never see a half-written meta/coverage."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as fh:
        json.dump(doc, fh)
    tmp.replace(path)


@dataclass
class Coverage:
    """Which level-0 core tiles have been computed for this artifact."""

    core: int = CORE
    done: set[tuple[int, int]] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.done is None:
            self.done = set()

    @classmethod
    def load(cls, root: Path) -> "Coverage":
        doc = read_json(root / "coverage.json")
        if not doc:
            return cls()
        return cls(core=int(doc.get("core", CORE)),
                   done={(int(a), int(b)) for a, b in doc.get("done", [])})

    def save(self, root: Path) -> None:
        write_json(root / "coverage.json",
                   {"core": self.core, "done": [[a, b] for a, b in sorted(self.done)]})

    def add(self, tx: int, ty: int) -> None:
        """Idempotent — re-running a covered tile leaves coverage unchanged."""
        self.done.add((int(tx), int(ty)))

    def has(self, tx: int, ty: int) -> bool:
        return (int(tx), int(ty)) in self.done

    def missing(self, tiles: list[tuple[int, int]]) -> list[tuple[int, int]]:
        """The subset of ``tiles`` not yet computed, order preserved."""
        return [t for t in tiles if not self.has(*t)]

    def bounds(self) -> tuple[int, int, int, int] | None:
        """Level-0 bbox of everything covered, as (x, y, w, h); None when empty."""
        if not self.done:
            return None
        xs = [t[0] for t in self.done]
        ys = [t[1] for t in self.done]
        x0, y0 = min(xs) * self.core, min(ys) * self.core
        x1, y1 = (max(xs) + 1) * self.core, (max(ys) + 1) * self.core
        return x0, y0, x1 - x0, y1 - y0
