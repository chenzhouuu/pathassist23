"""The tissue map job: core tiles → dense prediction → masked class raster → pyramid (Inc 4).

Region and whole slide are the **same** job and differ only in ``bbox`` (``None`` = whole slide),
inherited from Inc 3b D5. Results accumulate into one artifact through the coverage set, so a
second region extends the map rather than forking it.

The stored grid is defined by an **integer level offset**, not by an arbitrary µm/px ratio: a
0.2519 µm/px slide asked to store at "1 µm/px" gets ``offset = 2`` and therefore an exact factor of
4, and ``meta.json`` reports the resulting 1.0076 µm/px rather than the round number that was
requested. A non-integer factor would put core-tile boundaries between stored pixels and the whole
tile grid would drift.
"""

import logging
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from .artifacts import (
    CORE,
    TILE,
    Coverage,
    level_offset,
    meta_path,
    read_json,
    summary_path,
    write_json,
)
from .classes import BACKGROUND_INDEX, Backend
from .infer import predict_window
from .pyramid import (
    downsample_class,
    downsample_prob,
    levels_for,
    read_class_tile,
    read_prob_tile,
    write_class_tile,
    write_prob_tile,
)
from .slides import rasterise_tissue
from .tiling import clip_bbox_to_slide, core_tiles, haloed_read_window

logger = logging.getLogger(__name__)

# Above this the stored core (CORE >> offset) stops being a whole number of 256 px tiles.
MAX_LEVEL_OFFSET = 3
# Feed the network native pixels when the slide's µm/px is this close to what it was trained on;
# resampling a ~1 % difference costs a full-window interpolation and buys nothing.
MPP_TOLERANCE = 0.05


@dataclass(frozen=True)
class SlideInfo:
    width: int
    height: int
    mpp: float


def run_region(
    *, root: Path, art: str, backend: Backend, slide: SlideInfo,
    bbox: dict | None, tissue_tiles: list[tuple[int, int]], contours: dict | None,
    read_window, predict, store_mpp: float, overlap: int = 0, report=None, should_stop=None,
) -> dict:
    """Compute (or extend) a slide's tissue map. Returns the job result dict.

    ``should_stop`` is polled once per core tile — the only boundary where stopping is free.
    Coverage and its tallies have just been persisted, so a stopped job leaves a *complete* map of
    a smaller area rather than a damaged map of a larger one, and pressing the same button again
    resumes exactly where it left off.
    """
    say = report or (lambda *_a, **_k: None)
    root.mkdir(parents=True, exist_ok=True)

    offset = min(level_offset(slide.mpp, store_mpp), MAX_LEVEL_OFFSET)
    s = 1 << offset                                     # level-0 px per stored px
    if (CORE // s) % TILE:
        raise RuntimeError(f"stored core {CORE // s} is not a whole number of {TILE}px tiles")

    tiles = _tiles_for(bbox, tissue_tiles, slide)
    if not tiles:
        raise RuntimeError("nothing to analyse: the requested area holds no tissue")

    cov = Coverage.load(root)
    totals = _load_totals(root, backend, cov)
    if totals is None:
        # Covered tiles whose tallies are missing or describe a different number of tiles: a job
        # interrupted back when the tallies were only written at the very end. Nothing on disk
        # records what is in those rasters, so recompute rather than publish the fractions of a
        # subset under the core count and the area of all of them.
        #
        # The rasters go with the coverage that described them. Left behind they would be claimed
        # by no coverage entry yet still served as tiles and still counted by /stats over a bbox —
        # one artifact giving two accounts of itself, which is the failure this whole path exists
        # to prevent.
        logger.warning("tissue artifact %s: %d covered tiles have no tallies to match — "
                       "discarding them and recomputing", art, len(cov.done))
        _discard_rasters(root)
        cov = Coverage()
        totals = _load_totals(root, backend, cov)

    todo = cov.missing(tiles)
    logger.info("tissue job: %d tiles requested, %d already covered, %d to do",
                len(tiles), len(tiles) - len(todo), len(todo))

    model_scale = slide.mpp / backend.input_mpp

    done = 0
    stopped = False
    for i, (tx, ty) in enumerate(todo):
        if should_stop is not None and should_stop():
            stopped = True
            logger.info("tissue job stopped after %d of %d tiles", done, len(todo))
            break
        say("tiles", i / max(1, len(todo)))
        win = haloed_read_window(tx, ty, slide.width, slide.height)
        if win is None:
            continue
        _process_core(
            root=root, backend=backend, win=win, s=s, contours=contours,
            read_window=read_window, predict=predict, overlap=overlap,
            model_scale=model_scale, totals=totals,
        )
        cov.add(tx, ty)
        cov.totals = totals
        cov.save(root)
        done += 1

    # Even a stopped job finalises: the pyramid is what makes the covered area viewable at all, and
    # it is a small fraction of one core's cost.
    say("pyramid", 0.9 if not stopped else done / max(1, len(todo)))
    n_levels = levels_for(_ceil_div(slide.width, s), _ceil_div(slide.height, s))
    build_levels(root, backend, n_levels)

    _write_meta(root=root, art=art, backend=backend, slide=slide, offset=offset,
                store_mpp=slide.mpp * s, n_levels=n_levels, overlap=overlap)
    summary = _write_summary(root, backend, totals, cov, s, slide)
    result = {"art_hash": art, "n_tiles": len(cov.done), **summary}
    if stopped:
        result.update(stopped=True, remaining=len(todo) - done)
        say("stopped", done / max(1, len(todo)))
    else:
        say("done", 1.0)
    return result


def _tiles_for(bbox: dict | None, tissue_tiles: list[tuple[int, int]],
               slide: SlideInfo) -> list[tuple[int, int]]:
    """Whole slide ⇒ the tissue tile list. A region ⇒ its core tiles, narrowed to tissue if known.

    With no tissue mask a region job runs exactly what was asked for: the user framed that box, and
    refusing because the segmentation stage has not run would be a worse answer than analysing it.
    """
    if bbox is None:
        return list(tissue_tiles)
    clipped = clip_bbox_to_slide(bbox, slide.width, slide.height)
    if clipped is None:
        return []
    asked = core_tiles(clipped)
    if not tissue_tiles:
        return asked
    keep = set(tissue_tiles)
    return [t for t in asked if t in keep]


def _process_core(*, root, backend, win, s, contours, read_window, predict, overlap,
                  model_scale, totals) -> None:
    """One core tile: read (haloed) → predict → crop to core → reduce → mask → write."""
    rgb = read_window(win.x, win.y, win.width, win.height)
    rgb = _to_model_scale(rgb, model_scale)

    probs = predict_window(
        rgb, predict, n_classes=len(backend.classes),
        patch_in=backend.patch_in, patch_out=backend.patch_out, overlap=overlap,
    )
    probs = _from_model_scale(probs, (win.height, win.width), model_scale)

    core = probs[:, win.core_dy:win.core_dy + win.core_h,
                 win.core_dx:win.core_dx + win.core_w]
    small = _box_reduce(core, s)                       # [C, h, w] at the stored resolution

    mask = rasterise_tissue(contours, x=win.core_x, y=win.core_y,
                            width=win.core_w, height=win.core_h, scale=float(s))
    mask = _fit(mask, small.shape[1:])

    idx = (small.argmax(axis=0) + 1).astype(np.uint8)
    idx[~mask] = BACKGROUND_INDEX

    planes = {name: np.clip(small[c] * 255.0 + 0.5, 0, 255).astype(np.uint8)
              for c, name in enumerate(backend.classes)}
    for p in planes.values():
        p[~mask] = 0

    _accumulate(totals, backend, idx, small, mask)
    _write_core_tiles(root, backend, win, s, idx, planes)


def _write_core_tiles(root, backend, win, s, idx, planes) -> None:
    """Split a core's stored raster onto the global 256px tile grid.

    A core is ``CORE >> offset`` stored px, an exact multiple of ``TILE``, and cores are aligned to
    that grid — so no two cores ever share a tile and no read-modify-write is needed.
    """
    ox, oy = win.core_x // s, win.core_y // s
    if ox % TILE or oy % TILE:
        raise RuntimeError(f"core origin ({ox},{oy}) is not tile-aligned at scale {s}")
    h, w = idx.shape
    for dy in range(0, h, TILE):
        for dx in range(0, w, TILE):
            sub = idx[dy:dy + TILE, dx:dx + TILE]
            if not sub.size:
                continue
            tx, ty = (ox + dx) // TILE, (oy + dy) // TILE
            write_class_tile(root, 0, tx, ty, _pad_tile(sub), backend)
            write_prob_tile(root, 0, tx, ty,
                            {k: _pad_tile(v[dy:dy + TILE, dx:dx + TILE])
                             for k, v in planes.items()})


def build_levels(root: Path, backend: Backend, n_levels: int) -> None:
    """Rebuild every coarse level from the level below, for whatever tiles exist.

    Deliberately a full rebuild of the levels rather than an incremental patch: a coarse tile can
    have children from more than one job, and the arithmetic that works out which parents a new
    core touched is exactly the kind of thing that is wrong once and then wrong forever in the
    picture. Levels are small (a quarter of the level below), so this is cheap.
    """
    for z in range(1, n_levels):
        child_dir = root / "classes" / str(z - 1)
        if not child_dir.is_dir():
            break
        parents: set[tuple[int, int]] = set()
        for p in child_dir.glob("*.png"):
            cx, _, cy = p.stem.partition("_")
            parents.add((int(cx) // 2, int(cy) // 2))
        for px, py in sorted(parents):
            _build_parent(root, backend, z, px, py)


def _build_parent(root: Path, backend: Backend, z: int, px: int, py: int) -> None:
    n = len(backend.classes)
    cls = np.zeros((TILE * 2, TILE * 2), dtype=np.uint8)
    prob = {c: np.zeros((TILE * 2, TILE * 2), dtype=np.uint8) for c in backend.classes}
    found = False
    for dy in (0, 1):
        for dx in (0, 1):
            child = read_class_tile(root, z - 1, px * 2 + dx, py * 2 + dy)
            if child is None:
                continue
            found = True
            cls[dy * TILE:(dy + 1) * TILE, dx * TILE:(dx + 1) * TILE] = _pad_tile(child)
            for k, v in read_prob_tile(root, z - 1, px * 2 + dx, py * 2 + dy,
                                       list(backend.classes)).items():
                prob[k][dy * TILE:(dy + 1) * TILE, dx * TILE:(dx + 1) * TILE] = _pad_tile(v)
    if not found:
        return
    write_class_tile(root, z, px, py, downsample_class(cls, n), backend)
    write_prob_tile(root, z, px, py, downsample_prob(prob))


# ── accumulation and metadata ──────────────────────────────────────────────────────

def _discard_rasters(root: Path) -> None:
    """Drop both stored layers of an artifact whose coverage record cannot be trusted.

    Scoped to the two layer directories under an already path-validated artifact root, and only
    ever reached from the recovery above — never from an ordinary job.
    """
    import shutil

    for layer in ("classes", "probs"):
        shutil.rmtree(root / layer, ignore_errors=True)


def _load_totals(root: Path, backend: Backend, cov: Coverage) -> dict | None:
    """Running per-class tallies, so extending coverage extends the statistics.

    Read from the coverage file, which is the only place they cannot drift out of step with the
    tile list they describe. ``summary.json`` is the fallback for artifacts built before the
    tallies moved there — but only when its own core count still matches the coverage, because it
    is written at the end of a job and an interrupted one leaves it describing fewer tiles than
    are on disk.

    Returns ``None`` when coverage exists but no tally can be trusted to describe it.
    """
    if not cov.done:
        doc = {}                    # tallies describe `done`; nothing covered means nothing tallied
    elif cov.totals is not None:
        doc = cov.totals
    else:
        doc = read_json(summary_path(root)) or {}
        if doc.get("n_core_tiles") != len(cov.done):
            return None
    pixels = doc.get("pixels") or {}
    soft = doc.get("soft") or {}
    return {
        "pixels": {c: int(pixels.get(c, 0)) for c in backend.classes},
        "soft": {c: float(soft.get(c, 0.0)) for c in backend.classes},
        "tissue_px": int(doc.get("tissue_px", 0)),
    }


def _accumulate(totals: dict, backend: Backend, idx: np.ndarray,
                small: np.ndarray, mask: np.ndarray) -> None:
    """Add one core's tallies. Only in-tissue pixels count, in both the hard and soft views."""
    inside = int(mask.sum())
    totals["tissue_px"] += inside
    if not inside:
        return
    for c, name in enumerate(backend.classes, start=1):
        totals["pixels"][name] += int((idx == c).sum())
    for c, name in enumerate(backend.classes):
        totals["soft"][name] += float(small[c][mask].sum())


def _write_summary(root: Path, backend: Backend, totals: dict, cov: Coverage,
                   s: int, slide: SlideInfo) -> dict:
    tissue = max(1, totals["tissue_px"])
    frac = {c: totals["pixels"][c] / tissue for c in backend.classes}
    soft_total = max(1e-6, sum(totals["soft"].values()))
    frac_soft = {c: totals["soft"][c] / soft_total for c in backend.classes}

    px_mm = (slide.mpp * s) / 1000.0                    # mm per stored pixel
    covered_mm2 = totals["tissue_px"] * px_mm * px_mm

    tum, stroma = frac.get("Tumour"), frac.get("Stroma")
    tsr = (stroma / (tum + stroma)) if (tum is not None and stroma is not None
                                        and (tum + stroma) > 0) else None

    doc = {
        "pixels": totals["pixels"], "soft": totals["soft"],
        "tissue_px": totals["tissue_px"],
        "fraction": {k: round(v, 4) for k, v in frac.items()},
        "fraction_soft": {k: round(v, 4) for k, v in frac_soft.items()},
        "tsr": round(tsr, 4) if tsr is not None else None,
        "covered_mm2": round(covered_mm2, 3),
        "n_core_tiles": len(cov.done),
    }
    write_json(summary_path(root), doc)
    return {k: doc[k] for k in ("fraction", "fraction_soft", "tsr", "covered_mm2",
                                "n_core_tiles")}


def _write_meta(*, root: Path, art: str, backend: Backend, slide: SlideInfo,
                offset: int, store_mpp: float, n_levels: int, overlap: int) -> None:
    from .artifacts import PIPELINE_VERSION

    write_json(meta_path(root), {
        "art_hash": art,
        "backend": backend.name,
        "classes": list(backend.classes),
        "colors": {c: f"#{col}" for c, col in zip(backend.classes, backend.colors, strict=True)},
        "trained_on": backend.trained_on,
        "weights_license": backend.weights_license,
        "slide": {"width": slide.width, "height": slide.height, "mpp": slide.mpp},
        # The number actually used, not the one requested: an integer octave offset is what keeps
        # the tile grid aligned, so the stored resolution is slide.mpp * 2**offset.
        "store_mpp": round(store_mpp, 5),
        "layers": {"classes": {"level_offset": offset, "levels": n_levels},
                   "probs": {"level_offset": offset, "levels": n_levels}},
        "tile": TILE, "core": CORE, "overlap": overlap,
        "version": PIPELINE_VERSION,
    })


# ── array helpers ──────────────────────────────────────────────────────────────────

def _ceil_div(a: int, b: int) -> int:
    return (a + b - 1) // b


def _pad_tile(a: np.ndarray, tile: int = TILE) -> np.ndarray:
    """Pad a partial edge tile out to the full tile with zeros (= outside tissue)."""
    if a.shape == (tile, tile):
        return a
    out = np.zeros((tile, tile), dtype=a.dtype)
    out[:a.shape[0], :a.shape[1]] = a
    return out


def _fit(mask: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """Force a rasterised mask onto the reduced array's exact shape (rounding can differ by 1)."""
    if mask.shape == shape:
        return mask
    out = np.zeros(shape, dtype=bool)
    h = min(mask.shape[0], shape[0])
    w = min(mask.shape[1], shape[1])
    out[:h, :w] = mask[:h, :w]
    return out


def _box_reduce(a: np.ndarray, s: int) -> np.ndarray:
    """Mean-reduce ``[C, H, W]`` by an integer factor, edge-padding a ragged last row/column."""
    if s <= 1:
        return a
    c, h, w = a.shape
    ph, pw = (-h) % s, (-w) % s
    if ph or pw:
        a = np.pad(a, ((0, 0), (0, ph), (0, pw)), mode="edge")
    c, h, w = a.shape
    return a.reshape(c, h // s, s, w // s, s).mean(axis=(2, 4))


def _to_model_scale(rgb: np.ndarray, model_scale: float) -> np.ndarray:
    """Resample a level-0 window to the backend's training resolution when it matters."""
    if abs(model_scale - 1.0) <= MPP_TOLERANCE:
        return rgb
    h, w = rgb.shape[:2]
    size = (max(1, int(round(w * model_scale))), max(1, int(round(h * model_scale))))
    return np.asarray(Image.fromarray(rgb).resize(size, Image.BILINEAR))


def _from_model_scale(probs: np.ndarray, target_hw: tuple[int, int],
                      model_scale: float) -> np.ndarray:
    """Bring a probability field back onto the level-0 window grid."""
    if abs(model_scale - 1.0) <= MPP_TOLERANCE and probs.shape[1:] == target_hw:
        return probs
    th, tw = target_hw
    out = np.empty((probs.shape[0], th, tw), dtype=np.float32)
    for c in range(probs.shape[0]):
        im = Image.fromarray(probs[c])
        out[c] = np.asarray(im.resize((tw, th), Image.BILINEAR), dtype=np.float32)
    return out


def seam_gradient_ratio(field: np.ndarray, pitch: int) -> float:
    """Mean |d/dx| at a tiling pitch divided by the same statistic off-pitch (Inc 3b's metric).

    ~1.0 means the seams are indistinguishable from the tissue's own texture; the Inc 3b marker map
    measured 6.94 before feathering and 0.85 after. Used by the acceptance check that sets
    ``OVERLAP``; kept in the service so the number can be re-measured on any artifact.
    """
    g = np.abs(np.diff(field.astype(np.float32), axis=-1))
    if g.shape[-1] < pitch * 2:
        return float("nan")
    cols = np.arange(g.shape[-1])
    on = g[..., (cols % pitch) == (pitch - 1)].mean()
    off = g[..., (cols % pitch) == (pitch // 2)].mean()
    return float(on / off) if off > 0 else math.inf
