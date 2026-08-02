"""Content-addressed layout for a slide's nuclei (Inc 5 plan §4.1, restructured by Inc 7 §3).

Mirrors ``tissue/artifacts.py`` and ``biomarker/artifacts.py`` deliberately, so that the third copy
of this machinery stays recognisable as a copy (plan R2). What differs is the payload: nuclei are
**vector truth first**. CellViT already computes a polygon per nucleus and, until Inc 5, the
storage layer threw it away and kept a centroid in a Girder annotation. Here the ring is what is
stored, and every later picture is rasterised from it — so the number in a report and the shape on
screen can never come from two different objects (D3).

Inc 7 splits the payload in two along one line: **geometry is shared, naming is not.**

    /cache/{item}/nuclei/{art_hash}/
      meta.json              slide dims, mpp, store_mpp, level_offset, backend, taxonomies
      coverage.json          {"core": 2048, "done": [[tx, ty], ...], "totals": {...}}
      cells/{tx}_{ty}.npz    per-core-tile vector truth — outlines, ids, centroids (write_cells)
      tokens/{tx}_{ty}.npy   float16 [N, 1280], row-aligned with cells/ (Inc 7)
      instances/{z}/…png     packed per-nucleus id raster        ─┐ taxonomy-independent:
      cover/{z}/…png         what fraction of each pixel is nucleus ┘ the same array for all of them
      labels/{taxonomy}/
        coverage.json        which cores *this naming* covers, and its tallies
        summary.json         n_nuclei, counts_by_class, area_mm2, n_tiles
        cls/{tx}_{ty}.npz    stored class id + softmax prob, row-aligned with cells/
        classes/{z}/…png     paletted class raster, a lookup over the shared instance raster

Everything under `labels/` is derived from `cells/` + `tokens/` and can be deleted for a redraw or
a re-run; nothing there is a source of truth for a shape.

**The artifact's identity is what changes the numbers, and nothing else.** Not the bbox — that is
coverage, and two regions on one slide accumulate into one artifact. Not the segmentation either:
a tissue mask decides *where* a whole-slide run bothers to look, which is again coverage. Not the
taxonomy: a naming does not move an outline, which is why five of them share one address. What is
left is the model, the resolution it was run at, and — since Inc 7 — whether the tokens a later
naming needs were kept.
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
PIPELINE_VERSION = "inc7-1"

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

# CellViT-SAM-H's ViT-H embedding width — the length of the per-nucleus token every classifier head
# reads. Verified against the heads' own `fc1.weight` shape rather than assumed; a head trained on
# a different backbone would not load, and `heads.py` says so rather than broadcasting garbage.
TOKEN_DIM = 1280

_SAFE = re.compile(r"^[A-Za-z0-9._-]+$")


def _safe(seg: str) -> str:
    """Reject anything that could escape the cache root (mirrors preprocess's _validate_segment)."""
    if not seg or not _SAFE.match(seg) or seg in {".", ".."}:
        raise ValueError(f"unsafe path segment: {seg!r}")
    return seg


def art_hash(
    *, backend: str, store_mpp: float = STORE_MPP, version: str = PIPELINE_VERSION,
    tokens: bool = True,
) -> str:
    """Deterministic id for a slide's nuclei artifact.

    The slide is already in the path, so it is deliberately not in the hash. Neither is the bbox
    (coverage) nor a segmentation (also coverage — it selects tiles, it does not move an outline).
    Nor is the taxonomy: a naming shares the address of the outlines it names.

    ``tokens`` is in, and is the one thing here that is not about the numbers. An artifact without
    per-nucleus tokens cannot be classified afterwards, and that is a difference in what the
    artifact *is* — leaving two incompatible things at one address is how `conch_v1` came to mean
    two embeddings.
    """
    canonical = (
        f"nuclei|backend={backend}|mpp={store_mpp:g}"
        f"|tokens={1 if tokens else 0}|ver={version}"
    )
    return hashlib.sha1(canonical.encode()).hexdigest()[:16]


def level_offset(slide_mpp: float, store_mpp: float) -> int:
    """Octaves between the slide's own resolution and the stored raster's.

    Derived, never hardcoded. At the nuclei store resolution this is 0 for a 0.25 µm/px slide and
    1 for a 0.5 µm/px one — the raster needs it to sit at the right scale on the viewer, and meta
    carries it from here so both agree.
    """
    if slide_mpp <= 0 or store_mpp <= 0:
        return 0
    return max(0, int(round(math.log2(store_mpp / slide_mpp))))


def artifact_dir(cache_root: Path | str, item: str, ahash: str) -> Path:
    return Path(cache_root) / _safe(item) / "nuclei" / _safe(ahash)


def cells_path(root: Path, tx: int, ty: int) -> Path:
    return root / "cells" / f"{int(tx)}_{int(ty)}.npz"


def tokens_path(root: Path, tx: int, ty: int) -> Path:
    return root / "tokens" / f"{int(tx)}_{int(ty)}.npy"


def label_dir(root: Path, taxonomy: str) -> Path:
    """One taxonomy's whole sidecar: its coverage, its counts, its labels and its pictures."""
    return root / "labels" / _safe(taxonomy)


def labels_path(root: Path, taxonomy: str, tx: int, ty: int) -> Path:
    return label_dir(root, taxonomy) / "cls" / f"{int(tx)}_{int(ty)}.npz"


def class_tile_path(root: Path, taxonomy: str, z: int, x: int, y: int) -> Path:
    return label_dir(root, taxonomy) / "classes" / str(int(z)) / f"{int(x)}_{int(y)}.png"


def cover_tile_path(root: Path, z: int, x: int, y: int) -> Path:
    return root / "cover" / str(int(z)) / f"{int(x)}_{int(y)}.png"


def instance_tile_path(root: Path, z: int, x: int, y: int) -> Path:
    return root / "instances" / str(int(z)) / f"{int(x)}_{int(y)}.png"


def meta_path(root: Path) -> Path:
    return root / "meta.json"


def summary_path(root: Path, taxonomy: str) -> Path:
    return label_dir(root, taxonomy) / "summary.json"


def stored_taxonomies(root: Path) -> list[str]:
    """Which namings this artifact actually has on disk, in directory order.

    Read from the filesystem rather than from meta, so an interrupted job that wrote labels but
    never reached `_write_meta` still shows what it produced.
    """
    base = root / "labels"
    if not base.is_dir():
        return []
    return sorted(p.name for p in base.iterdir() if p.is_dir())


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


def _atomic_npz(path: Path, **arrays: np.ndarray) -> None:
    """`savez_compressed` through a temp file, renamed into place.

    Written through a file object on purpose: handed a *path* that does not end in `.npz`,
    savez_compressed appends the extension itself and the rename would then look for a file that
    was never written.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".npz.tmp")
    with open(tmp, "wb") as fh:
        np.savez_compressed(fh, **arrays)
    tmp.replace(path)


# ── the vector truth ────────────────────────────────────────────────────────────────


def write_cells(
    path: Path,
    *,
    xy: np.ndarray,
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

    No class column since Inc 7: a class belongs to a taxonomy, and this file is what every
    taxonomy names. See :func:`write_labels`.
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

    _atomic_npz(
        path,
        xy=np.asarray(xy, dtype=np.float32).reshape(-1, 2),
        ring_off=ring_off,
        ring_xy=ring_xy,
        inst=np.asarray(inst, dtype=np.uint32).reshape(-1),
        origin=np.array([ox, oy], dtype=np.int32),
    )


def read_cell_arrays(path: Path) -> dict | None:
    """A core tile's nuclei as the arrays they are stored as, rings still packed.

    The CSR form, with ``ring_xy`` offset back to level-0 slide pixels and ``ring_off`` marking
    each nucleus's slice. This is what the rasteriser wants: unpacking a million polygons into
    Python lists and immediately converting each one back to an array is most of the cost of
    drawing a core, and it buys nothing.
    """
    if not path.is_file():
        return None
    with np.load(path) as z:
        ox, oy = (int(v) for v in z["origin"])
        return {
            "xy": z["xy"], "inst": z["inst"],
            "ring_off": z["ring_off"],
            "ring_xy": z["ring_xy"].astype(np.float64) + np.array([ox, oy], dtype=np.float64),
            "origin": (ox, oy),
        }


def read_cells(path: Path) -> dict | None:
    """The same, with rings unpacked into ``[[x, y], ...]`` lists in level-0 slide pixels.

    The friendly form, for readers that want one polygon at a time. The rasteriser uses
    :func:`read_cell_arrays` instead.
    """
    a = read_cell_arrays(path)
    if a is None:
        return None
    off, xy = a["ring_off"], a["ring_xy"]
    return {
        "xy": a["xy"], "inst": a["inst"], "origin": a["origin"],
        "rings": [xy[off[i]:off[i + 1]].tolist() for i in range(len(off) - 1)],
    }


# ── the tokens a later naming reads ─────────────────────────────────────────────────


def write_tokens(path: Path, tokens: np.ndarray) -> None:
    """One core tile's per-nucleus embeddings, row-aligned with its `cells/` file.

    float16 halves 2.5 kB a nucleus to 1.25 — and the head that reads them was trained in mixed
    precision, so the second half of a float32 was never information. Written temp-then-renamed
    like everything else here: a classify job reading a half-written array would produce labels
    for nuclei that do not exist.
    """
    a = np.asarray(tokens, dtype=np.float16).reshape(-1, TOKEN_DIM)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".npy.tmp")
    with open(tmp, "wb") as fh:
        np.save(fh, a)
    tmp.replace(path)


def read_tokens(path: Path) -> np.ndarray | None:
    """``[N, 1280]`` float16, or None when this core predates tokens or was never written."""
    if not path.is_file():
        return None
    return np.load(path)


def has_tokens(root: Path) -> bool:
    """Whether this artifact can be classified at all — i.e. whether step 1 kept the tokens."""
    d = root / "tokens"
    return d.is_dir() and any(d.glob("*.npy"))


# ── one taxonomy's naming of them ───────────────────────────────────────────────────


def write_labels(path: Path, *, cls: np.ndarray, prob: np.ndarray) -> None:
    """One core tile's class ids and their softmax confidence, row-aligned with `cells/`.

    ``cls`` is a **stored** id: 1-based, 0 reserved for "no nucleus" (see `taxonomy.py`).

    ``prob`` is the real softmax value. Upstream computes it and then writes `int(z)` into
    `type_prob`, which truncates every confidence below 1.0 to zero; computing it here is both the
    fix and the reason it is worth two bytes a nucleus. Nothing displays it yet (D12).
    """
    _atomic_npz(
        path,
        cls=np.asarray(cls, dtype=np.uint8).reshape(-1),
        prob=np.asarray(prob, dtype=np.float16).reshape(-1),
    )


def read_labels(path: Path) -> dict | None:
    """``{"cls": uint8[N], "prob": float16[N]}``, or None when this core is not labelled yet."""
    if not path.is_file():
        return None
    with np.load(path) as z:
        return {"cls": z["cls"], "prob": z["prob"]}


@dataclass
class Coverage:
    """Which level-0 core tiles have been computed, and their running tallies.

    The tallies live here, in the *same* file and therefore the same atomic write as the tile list.
    They describe exactly the tiles in ``done``, and a tally that can disagree with the tile list it
    describes is worse than no tally at all: a job stopped part-way would resume, count only the
    cores it happened to run itself, and publish those counts under the core count of every core
    ever computed. (The invariant Inc 4 arrived at, inherited here rather than re-learned.)

    Used at two roots since Inc 7, unchanged in either: the artifact's own, for which cores have
    outlines, and each ``labels/{taxonomy}/``, for which cores that naming has reached. Reading a
    taxonomy's counts against the artifact's tile list is exactly the disagreement above, one level
    out — so a taxonomy carries its own tile list and its counts describe that.
    """

    core: int = CORE
    done: set[tuple[int, int]] = None  # type: ignore[assignment]
    totals: dict | None = None

    @classmethod
    def load(cls, root: Path) -> "Coverage":
        doc = read_json(root / "coverage.json")
        if not doc:
            return cls()
        return cls(core=int(doc.get("core", CORE)),
                   done={(int(a), int(b)) for a, b in doc.get("done", [])},
                   totals=doc.get("totals") or None)

    def __post_init__(self) -> None:
        if self.done is None:
            self.done = set()

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
    "CORE", "HALO", "PIPELINE_VERSION", "STORE_MPP", "TILE", "TOKEN_DIM", "Coverage", "art_hash",
    "artifact_dir", "cells_path", "class_tile_path", "cover_tile_path", "has_tokens",
    "instance_tile_path", "label_dir", "labels_path", "level_offset", "meta_path",
    "read_cell_arrays", "read_cells", "read_json", "read_labels", "read_tokens",
    "stored_taxonomies",
    "summary_path", "tokens_path", "write_cells", "write_json", "write_labels", "write_tokens",
]
