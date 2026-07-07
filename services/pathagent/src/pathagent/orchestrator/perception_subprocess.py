"""Self-contained CONCH concept-similarity perception step.

Runs in the pathology conda env (which has ``torch`` + ``conch``); launched as
a subprocess by :mod:`pathagent.orchestrator.perception`. It reads a single
JSON request on **stdin** and writes a single JSON result object on **stdout**.
All torch/model chatter is redirected to **stderr** so stdout stays clean.

Imports are deliberately limited to the standard library plus ``numpy``,
``h5py``, ``PIL``, ``torch``, ``conch`` and ``matplotlib`` — nothing from the
``pathagent`` package, which is not installed in the pathology env.

Request schema (stdin JSON)::

    {
      "featuresH5": str,
      "question": str,
      "concepts": [str, ...],
      "navTopK": int,
      "kbSnippets": [{"id": str, "text": str, "source": str}, ...],
      "kbTopK": int,
      "rasterPng": str,
      "roi": {"x": int, "y": int, "width": int, "height": int} | null
    }

Result schema (stdout JSON)::

    {"regions": [...], "rasterExtent": {...}, "gridShape": [rows, cols], "kbHits": [...]}
"""

import contextlib
import json
import sys
import traceback
from pathlib import Path

import h5py
import matplotlib
import numpy as np
import torch
from PIL import Image

matplotlib.use("Agg")

# Number of coarse buckets per axis for coverage sampling.
_GRID = 4
# Extra coverage regions allowed on top of the top-k hotspots.
_COVERAGE_SLOTS = 6
_EPS = 1e-8


def _l2norm(arr: np.ndarray) -> np.ndarray:
    """L2-normalize rows of a 2-D float array (safe against zero rows)."""
    norm = np.linalg.norm(arr, axis=-1, keepdims=True)
    return arr / np.maximum(norm, _EPS)


def _colormap():
    """Return a matplotlib colormap in a version-robust way."""
    try:
        return matplotlib.colormaps["jet"]  # matplotlib >= 3.6
    except AttributeError:  # pragma: no cover - old matplotlib fallback
        from matplotlib import cm

        return cm.get_cmap("jet")


def _load_text_tower():
    """Create the CONCH text tower + tokenizer (chatter goes to stderr)."""
    from conch.open_clip_custom import create_model_from_pretrained, get_tokenizer

    model, _ = create_model_from_pretrained(
        "conch_ViT-B-16", "hf_hub:MahmoodLab/conch", force_image_size=224
    )
    model.eval()
    tokenizer = get_tokenizer()
    return model, tokenizer


def _encode_text(model, tokenizer, texts: list[str]) -> np.ndarray:
    """Embed a list of prompts with CONCH's text tower → (len(texts), 512)."""
    from conch.open_clip_custom import tokenize

    toks = tokenize(texts=texts, tokenizer=tokenizer)
    with torch.no_grad():
        emb = model.encode_text(toks)
    return emb.cpu().numpy().astype(np.float32)


def _bucket_of(x: int, y: int, width: int, height: int) -> tuple[int, int]:
    """Map a level-0 coordinate to its coarse ``_GRID`` x ``_GRID`` cell."""
    cell_w = width / _GRID if width > 0 else 1.0
    cell_h = height / _GRID if height > 0 else 1.0
    col = min(int(x / cell_w), _GRID - 1)
    row = min(int(y / cell_h), _GRID - 1)
    return row, col


def _make_region(idx: int, coords: np.ndarray, ps: int, score01: np.ndarray,
                 best_concept: np.ndarray, concepts: list[str]) -> dict:
    """Build a region dict for one patch index."""
    concept = concepts[int(best_concept[idx])] if concepts else "importance"
    return {
        "x": int(coords[idx, 0]),
        "y": int(coords[idx, 1]),
        "width": int(ps),
        "height": int(ps),
        "score": float(score01[idx]),
        "rationale": f"matches: {concept}",
    }


def _select_regions(coords: np.ndarray, ps: int, score: np.ndarray, score01: np.ndarray,
                    best_concept: np.ndarray, concepts: list[str], nav_top_k: int,
                    width: int, height: int) -> list[dict]:
    """Pick top-k hotspot regions plus coverage regions from empty buckets."""
    order = np.argsort(-score)
    top_idx = list(order[: max(nav_top_k, 0)])

    represented = {
        _bucket_of(int(coords[i, 0]), int(coords[i, 1]), width, height) for i in top_idx
    }

    # Best-scoring patch per coarse bucket (for coverage sampling).
    best_in_bucket: dict[tuple[int, int], int] = {}
    for i in range(coords.shape[0]):
        b = _bucket_of(int(coords[i, 0]), int(coords[i, 1]), width, height)
        if b not in best_in_bucket or score[best_in_bucket[b]] < score[i]:
            best_in_bucket[b] = i

    coverage = [idx for b, idx in best_in_bucket.items() if b not in represented]
    coverage.sort(key=lambda i: -score[i])
    budget = max(nav_top_k + _COVERAGE_SLOTS - len(top_idx), 0)
    coverage = coverage[:budget]

    return [
        _make_region(i, coords, ps, score01, best_concept, concepts)
        for i in top_idx + coverage
    ]


def _render_raster(coords: np.ndarray, ps: int, score01: np.ndarray,
                   raster_png: str) -> tuple[dict, list[int]]:
    """Rasterize the importance map to an RGBA PNG; return extent + grid shape."""
    xmin, ymin = int(coords[:, 0].min()), int(coords[:, 1].min())
    xmax, ymax = int(coords[:, 0].max()), int(coords[:, 1].max())
    cols = int((xmax - xmin) // ps + 1)
    rows = int((ymax - ymin) // ps + 1)

    grid = np.full((rows, cols), np.nan, dtype=np.float32)
    for i in range(coords.shape[0]):
        c = int((coords[i, 0] - xmin) // ps)
        r = int((coords[i, 1] - ymin) // ps)
        if 0 <= r < rows and 0 <= c < cols:
            if np.isnan(grid[r, c]) or grid[r, c] < score01[i]:
                grid[r, c] = float(score01[i])

    filled = ~np.isnan(grid)
    colored = _colormap()(np.nan_to_num(grid, nan=0.0))
    rgba = np.zeros((rows, cols, 4), dtype=np.uint8)
    rgba[..., :3] = (colored[..., :3] * 255).astype(np.uint8)
    rgba[..., 3] = np.where(filled, 255, 0).astype(np.uint8)

    out = Path(raster_png)
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(out)

    extent = {
        "x": xmin,
        "y": ymin,
        "width": int(xmax + ps - xmin),
        "height": int(ymax + ps - ymin),
    }
    return extent, [rows, cols]


def _rank_kb(model, tokenizer, kb_snippets: list[dict], question_vec: np.ndarray,
             kb_top_k: int) -> list[dict]:
    """Rank KB snippets by cosine similarity of their text to the question."""
    if not kb_snippets:
        return []
    texts = [str(s["text"]) for s in kb_snippets]
    kb_norm = _l2norm(_encode_text(model, tokenizer, texts))
    sims = kb_norm @ question_vec
    order = np.argsort(-sims)[: max(kb_top_k, 0)]
    return [
        {
            "id": kb_snippets[j]["id"],
            "text": kb_snippets[j]["text"],
            "source": kb_snippets[j]["source"],
            "score": float(sims[j]),
        }
        for j in order
    ]


def _run(req: dict) -> dict:
    """Execute the perception pipeline for one request dict."""
    concepts: list[str] = list(req.get("concepts", []))
    question: str = req["question"]
    nav_top_k = int(req["navTopK"])
    kb_top_k = int(req["kbTopK"])

    with h5py.File(req["featuresH5"], "r") as f:
        feats = f["features"][:].astype(np.float32)
        coords = f["coords"][:]
        ps = int(f["coords"].attrs["patch_size_level0"])
        width = int(f["coords"].attrs["level0_width"])
        height = int(f["coords"].attrs["level0_height"])

    roi = req.get("roi")
    if roi:
        rx, ry = int(roi["x"]), int(roi["y"])
        rw, rh = int(roi["width"]), int(roi["height"])
        mask = (
            (coords[:, 0] >= rx)
            & (coords[:, 0] < rx + rw)
            & (coords[:, 1] >= ry)
            & (coords[:, 1] < ry + rh)
        )
        if mask.any():
            feats = feats[mask]
            coords = coords[mask]

    model, tokenizer = _load_text_tower()
    text_vecs = _l2norm(_encode_text(model, tokenizer, [question, *concepts]))
    feats_norm = _l2norm(feats)

    sim = feats_norm @ text_vecs.T  # (N, 1 + C)
    concept_best = sim[:, 1:].max(axis=1) if concepts else np.zeros(sim.shape[0], np.float32)
    best_concept = sim[:, 1:].argmax(axis=1) if concepts else np.zeros(sim.shape[0], int)
    score = 0.5 * sim[:, 0] + 0.5 * concept_best

    smin, smax = float(score.min()), float(score.max())
    score01 = (score - smin) / (smax - smin) if smax > smin else np.zeros_like(score)

    regions = _select_regions(
        coords, ps, score, score01, best_concept, concepts, nav_top_k, width, height
    )
    extent, grid_shape = _render_raster(coords, ps, score01, req["rasterPng"])
    kb_hits = _rank_kb(model, tokenizer, req.get("kbSnippets", []), text_vecs[0], kb_top_k)

    return {
        "regions": regions,
        "rasterExtent": extent,
        "gridShape": grid_shape,
        "kbHits": kb_hits,
    }


def main() -> None:
    """Read the request from stdin, run perception, write the result to stdout."""
    req = json.loads(sys.stdin.read())
    with contextlib.redirect_stdout(sys.stderr):
        result = _run(req)
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - surface any failure as rc=1 + stderr for the runner
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
