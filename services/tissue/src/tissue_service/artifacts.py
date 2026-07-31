"""Content-addressed layout for a slide's tissue-class map (Inc 4, design §4).

One artifact per (segmentation × backend × stored resolution × pipeline version). Deliberately
**not** per bbox: repeated region jobs accumulate into the same artifact and record what they
computed in a coverage set (inherited from Inc 3b D6), so framing a second region extends the map
instead of forking it.

    /cache/{item}/tissue/{art_hash}/
      meta.json      backend, classes, palette, slide dims + mpp, level offsets, version
      coverage.json  {"core": 2048, "done": [[tx, ty], ...]}   level-0 core-tile indices
      summary.json   per-class pixel counts, area fractions (hard + soft), TSR, covered mm²
      classes/{z}/{x}_{y}.png    paletted, index 0 = outside tissue (transparent)
      probs/{z}/{x}_{y}.npz      one named uint8 plane per class
"""

import hashlib
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path

# Bump when anything that changes the *numbers* changes: weights, normalisation, window geometry,
# feathering, downsampling rule.
PIPELINE_VERSION = "inc4-1"

# Job unit of work, level-0 px. The halo is exactly the network's own context margin
# ((patch_in - patch_out) / 2 = 256 at 0.25 µm/px), so a core tile's interior is predicted with
# real neighbouring tissue rather than with reflected padding.
CORE = 2048
HALO = 256

# Output pyramid tile side, both layers.
TILE = 256

_SAFE = re.compile(r"^[A-Za-z0-9._-]+$")


def _safe(seg: str) -> str:
    """Reject anything that could escape the cache root (mirrors preprocess's _validate_segment)."""
    if not seg or not _SAFE.match(seg) or seg in {".", ".."}:
        raise ValueError(f"unsafe path segment: {seg!r}")
    return seg


def art_hash(
    *, seg_hash: str, backend: str, store_mpp: float, overlap: int = 0,
    version: str = PIPELINE_VERSION,
) -> str:
    """Deterministic id for a slide's tissue artifact.

    ``bbox`` is deliberately absent — it is coverage, not identity. ``seg_hash`` transitively
    carries the slide and the segmenter params. ``backend`` is what lets a future self-trained
    decoder coexist with the BCSS map instead of invalidating it (D1).

    ``overlap`` **is** part of the identity: it changes the probability field, so two runs at
    different overlaps produce different numbers. Left out, they would share one artifact and
    accumulate into a single coverage set with no way to tell which tile came from which — a map
    that is quietly two maps.
    """
    canonical = (f"tissue|p={seg_hash}|backend={backend}|mpp={store_mpp:g}"
                 f"|ov={int(overlap)}|ver={version}")
    return hashlib.sha1(canonical.encode()).hexdigest()[:16]


def level_offset(slide_mpp: float, store_mpp: float) -> int:
    """Octaves between the slide's own resolution and the stored raster's.

    Derived, never hardcoded: a 0.25 µm/px slide stored at 1 µm/px gives 2, but a 0.5 µm/px slide
    gives 1, and a layer that assumed 2 there would sit at half scale on the viewer.
    """
    if slide_mpp <= 0 or store_mpp <= 0:
        return 0
    return max(0, int(round(math.log2(store_mpp / slide_mpp))))


def artifact_dir(cache_root: Path | str, item: str, ahash: str) -> Path:
    return Path(cache_root) / _safe(item) / "tissue" / _safe(ahash)


def class_tile_path(root: Path, z: int, x: int, y: int) -> Path:
    return root / "classes" / str(int(z)) / f"{int(x)}_{int(y)}.png"


def prob_tile_path(root: Path, z: int, x: int, y: int) -> Path:
    return root / "probs" / str(int(z)) / f"{int(x)}_{int(y)}.npz"


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
    """Which level-0 core tiles have been computed for this artifact, and their running tallies.

    The tallies live here, in the *same* file and therefore the same atomic write as the tile list,
    rather than in ``summary.json``. They describe exactly the tiles in ``done``, and a tally that
    can disagree with the tile list it describes is worse than no tally at all: a job stopped or
    killed part-way would resume, count only the cores it happened to run itself, and publish those
    fractions under the core count of every core ever computed.
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
