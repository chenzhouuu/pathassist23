"""Content-addressed layout for a slide's nuclei (Inc 5, plan §4.1).

Mirrors ``tissue/artifacts.py`` and ``biomarker/artifacts.py`` deliberately, so that the third copy
of this machinery stays recognisable as a copy (plan R2). What differs is the payload: nuclei are
**vector truth first**. CellViT already computes a polygon per nucleus and, until this ticket, the
storage layer threw it away and kept a centroid in a Girder annotation. Here the ring is what is
stored, and every later picture is rasterised from it — so the number in a report and the shape on
screen can never come from two different objects (D3).

    /cache/{item}/nuclei/{art_hash}/
      meta.json          slide dims, mpp, store_mpp, level_offset, backend, classes, palette
      coverage.json      {"core": 2048, "done": [[tx, ty], ...], "totals": {...}}
      summary.json       n_nuclei, counts_by_class, area_mm2, n_tiles
      cells/{tx}_{ty}.npz    per-core-tile vector truth (see write_cells)
      classes/{z}/{x}_{y}.png  paletted class raster, drawn from the rings (ticket 06)
      cover/{z}/{x}_{y}.png    what fraction of each pixel is nucleus (ticket 06)

The instance-id raster arrives in ticket 08. The class raster is derived — deleting it costs a
redraw, never a number, because every count comes from `cells/` and `coverage.json`.

**The artifact's identity is what changes the numbers, and nothing else.** Not the bbox — that is
coverage, and two regions on one slide accumulate into one artifact. Not the segmentation either:
a tissue mask decides *where* a whole-slide run bothers to look, which is again coverage. What is
left is the model and the resolution it was run at.
"""

import hashlib
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# Bump when anything that changes the *numbers* changes: weights, the mpp handed to the model,
# window geometry, the centroid-ownership rule.
PIPELINE_VERSION = "inc5-1"

# Job unit of work, level-0 px, and the halo read around it. The halo makes a nucleus that
# straddles a core seam segment whole; which core owns it is then decided by its centroid.
CORE = 2048
HALO = 256

# Nuclei are ~10 µm across. The tissue map's 1 µm/px would make them mush, so the raster stores at
# the slide's own resolution (plan §4.3).
STORE_MPP = 0.25

# Pyramid tile side, in stored pixels. 256 like the tissue map, and a core is a whole number of
# them at every offset this service allows, so no two cores ever share a tile.
TILE = 256

_SAFE = re.compile(r"^[A-Za-z0-9._-]+$")


def _safe(seg: str) -> str:
    """Reject anything that could escape the cache root (mirrors preprocess's _validate_segment)."""
    if not seg or not _SAFE.match(seg) or seg in {".", ".."}:
        raise ValueError(f"unsafe path segment: {seg!r}")
    return seg


def art_hash(
    *, backend: str, store_mpp: float = STORE_MPP, version: str = PIPELINE_VERSION,
) -> str:
    """Deterministic id for a slide's nuclei artifact.

    The slide is already in the path, so it is deliberately not in the hash. Neither is the bbox
    (coverage) nor a segmentation (also coverage — it selects tiles, it does not move an outline).
    """
    canonical = f"nuclei|backend={backend}|mpp={store_mpp:g}|ver={version}"
    return hashlib.sha1(canonical.encode()).hexdigest()[:16]


def level_offset(slide_mpp: float, store_mpp: float) -> int:
    """Octaves between the slide's own resolution and the stored raster's.

    Derived, never hardcoded. At the nuclei store resolution this is 0 for a 0.25 µm/px slide and
    1 for a 0.5 µm/px one — the raster in ticket 06 needs it to sit at the right scale on the
    viewer, and meta carries it from here so both agree.
    """
    if slide_mpp <= 0 or store_mpp <= 0:
        return 0
    return max(0, int(round(math.log2(store_mpp / slide_mpp))))


def artifact_dir(cache_root: Path | str, item: str, ahash: str) -> Path:
    return Path(cache_root) / _safe(item) / "nuclei" / _safe(ahash)


def cells_path(root: Path, tx: int, ty: int) -> Path:
    return root / "cells" / f"{int(tx)}_{int(ty)}.npz"


def class_tile_path(root: Path, z: int, x: int, y: int) -> Path:
    return root / "classes" / str(int(z)) / f"{int(x)}_{int(y)}.png"


def cover_tile_path(root: Path, z: int, x: int, y: int) -> Path:
    return root / "cover" / str(int(z)) / f"{int(x)}_{int(y)}.png"


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


# ── the vector truth ────────────────────────────────────────────────────────────────


def write_cells(
    path: Path,
    *,
    xy: np.ndarray,
    cls: np.ndarray,
    rings: list,
    inst: np.ndarray,
    origin: tuple[int, int],
) -> None:
    """One core tile's nuclei, as the CSR layout in plan §4.1.

    ``rings`` is a list of ``[[x, y], ...]`` polygons in level-0 slide pixels, index-aligned with
    ``xy``. They are flattened into ``ring_xy`` with ``ring_off`` marking each nucleus's slice —
    a ragged array of ~10⁶ small polygons is what CSR exists for.

    Ring points are stored **relative to the core-tile origin**, which is the whole reason int16
    fits: a core is 2048 px and the halo reaches 256 beyond it, so every coordinate lands well
    inside ±32767. Absolute level-0 coordinates would need int32 and double the file.

    Written via a temp file and renamed, so a reader during a job sees either the previous tile or
    the finished one, never a half-written array.
    """
    ox, oy = int(origin[0]), int(origin[1])
    counts = np.array([len(r) for r in rings], dtype=np.int32)
    ring_off = np.zeros(len(rings) + 1, dtype=np.int32)
    if counts.size:
        np.cumsum(counts, out=ring_off[1:])
    flat = (
        np.concatenate([np.asarray(r, dtype=np.float64).reshape(-1, 2) for r in rings])
        if counts.size else np.zeros((0, 2), dtype=np.float64)
    )
    ring_xy = np.rint(flat - np.array([ox, oy], dtype=np.float64)).astype(np.int16)

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".npz.tmp")
    # Written through a file object on purpose: handed a *path* that does not end in `.npz`,
    # savez_compressed appends the extension itself and the rename below would then look for a
    # file that was never written.
    with open(tmp, "wb") as fh:
        np.savez_compressed(
            fh,
            xy=np.asarray(xy, dtype=np.float32).reshape(-1, 2),
            cls=np.asarray(cls, dtype=np.uint8).reshape(-1),
            ring_off=ring_off,
            ring_xy=ring_xy,
            inst=np.asarray(inst, dtype=np.uint32).reshape(-1),
            origin=np.array([ox, oy], dtype=np.int32),
        )
    tmp.replace(path)


def read_cells(path: Path) -> dict | None:
    """A core tile's nuclei back, with rings restored to level-0 slide pixels."""
    if not path.is_file():
        return None
    with np.load(path) as z:
        ox, oy = (int(v) for v in z["origin"])
        ring_off = z["ring_off"]
        ring_xy = z["ring_xy"].astype(np.float64) + np.array([ox, oy], dtype=np.float64)
        rings = [
            ring_xy[ring_off[i]:ring_off[i + 1]].tolist() for i in range(len(ring_off) - 1)
        ]
        return {
            "xy": z["xy"], "cls": z["cls"], "inst": z["inst"],
            "rings": rings, "origin": (ox, oy),
        }


@dataclass
class Coverage:
    """Which level-0 core tiles have been computed, and their running tallies.

    The tallies live here, in the *same* file and therefore the same atomic write as the tile list.
    They describe exactly the tiles in ``done``, and a tally that can disagree with the tile list it
    describes is worse than no tally at all: a job stopped part-way would resume, count only the
    cores it happened to run itself, and publish those counts under the core count of every core
    ever computed. (The invariant Inc 4 arrived at, inherited here rather than re-learned.)
    """

    core: int = CORE
    done: set[tuple[int, int]] = None  # type: ignore[assignment]
    totals: dict | None = None

    def __post_init__(self) -> None:
        if self.done is None:
            self.done = set()

    @classmethod
    def load(cls, root: Path) -> "Coverage":
        doc = read_json(root / "coverage.json")
        if not doc:
            return cls()
        return cls(core=int(doc.get("core", CORE)),
                   done={(int(a), int(b)) for a, b in doc.get("done", [])},
                   totals=doc.get("totals") or None)

    def save(self, root: Path) -> None:
        doc = {"core": self.core, "done": [[a, b] for a, b in sorted(self.done)]}
        if self.totals is not None:
            doc["totals"] = self.totals
        write_json(root / "coverage.json", doc)

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


__all__ = [
    "CORE", "HALO", "PIPELINE_VERSION", "STORE_MPP", "TILE", "Coverage", "art_hash",
    "artifact_dir", "cells_path", "class_tile_path", "cover_tile_path", "level_offset",
    "meta_path", "read_cells", "read_json", "summary_path", "write_cells", "write_json",
]
