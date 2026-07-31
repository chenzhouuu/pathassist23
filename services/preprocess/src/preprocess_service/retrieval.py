"""Text→patch region retrieval for find_regions, behind the stub/real seam.

Given a ready text-capable index (features h5), embed the query into the shared space and cosine
against the unit-norm patch features → top-K level-0 boxes. The stub derives a deterministic,
query-sensitive text vector so retrieval is CI-testable with no GPU; the real path embeds with the
`conch` package's text tower (F1: the conch_v1_text variant, i.e. conch_v1 with the
contrastive projection — NOT a Trident method).
"""

from pathlib import Path

import numpy as np

from .artifacts import read_features_h5


def _stub_text_vec(query: str, dim: int) -> np.ndarray:
    """A deterministic unit vector for `query`, so different queries rank patches differently."""
    seed = abs(hash(query)) % (2**32) if query else 0
    rng = np.random.default_rng(seed=seed)
    v = rng.standard_normal(dim).astype(np.float32)
    return v / (np.linalg.norm(v) + 1e-8)


def find_regions(
    features_path: Path,
    query: str,
    k: int = 8,
    encoder: str = "conch_v1_text",
    *,
    use_trident: bool = False,
) -> list[dict]:
    """Top-K level-0 candidate boxes for `query`, ranked by cosine similarity (desc).

    Zero-shot text→image retrieval (CONCH). These are *candidates* to verify downstream, not
    findings: precision comes from confirming each with the Perceptor (describe_region), not from
    thresholding the cosine — so no confidence score is derived here (on real CONCH the top-of-N
    cosine barely separates a real match from noise; the VLM is the reliable gate).

    Selection is not a raw top-K: it (1) spatially de-duplicates so adjacent patches from one hot
    spot collapse to a single focus, and (2) caps *tissue-edge* patches at ⌈k/2⌉. Real-CONCH
    probing showed tumour-like queries rank tissue-boundary patches ~4× over baseline (folds,
    section borders, half-background reads embed as "dense/abnormal" and spuriously align with the
    text) — so an uncapped top-K comes back almost entirely on the edges. The cap keeps the strong
    edge hits (some are genuine) while forcing interior foci in, without discarding signal. Both
    steps are purely geometric — no cosine threshold.
    """
    feats, coords, attrs = read_features_h5(features_path)
    if feats.size == 0:
        return []
    ps0 = int(attrs.get("patch_size_level0", 256))
    dim = int(feats.shape[1])
    q = _conch_text_embed(query, encoder, dim) if use_trident else _stub_text_vec(query, dim)
    sims = np.asarray(feats, dtype=np.float32) @ q  # feats + q unit-norm → cosine
    picks = _select_candidates(coords, sims, k, ps0)
    return [
        {
            "x": int(coords[i][0]), "y": int(coords[i][1]),
            "width": ps0, "height": ps0, "score": round(float(sims[i]), 4),
        }
        for i in picks
    ]


def _grid_step(coords: np.ndarray, ps0: int) -> int:
    """The patch stride in level-0 px — the smallest positive spacing between neighbours on either
    axis (robust to overlap); falls back to the patch side when the grid is degenerate."""
    steps = []
    for axis in (0, 1):
        diffs = np.diff(np.unique(coords[:, axis]))
        diffs = diffs[diffs > 0]
        if diffs.size:
            steps.append(int(diffs.min()))
    return min(steps) if steps else max(1, int(ps0))


def _interior_mask(coords: np.ndarray, step: int) -> np.ndarray:
    """True where a patch has all four grid neighbours present (interior); False on the tiled
    tissue's perimeter — those boundary patches carry the fold/edge/half-background artifacts that
    zero-shot retrieval over-ranks for tumour queries."""
    occ = set(map(tuple, coords.tolist()))
    return np.array(
        [
            (int(x) + step, int(y)) in occ and (int(x) - step, int(y)) in occ
            and (int(x), int(y) + step) in occ and (int(x), int(y) - step) in occ
            for x, y in coords
        ],
        dtype=bool,
    )


def _select_candidates(coords: np.ndarray, sims: np.ndarray, k: int, ps0: int) -> list[int]:
    """Pick indices for the returned candidates: spatially-distinct foci, tissue-edge patches
    capped at ⌈k/2⌉, always exactly ``min(k, N)`` of them, ordered by similarity (desc)."""
    k = max(1, int(k))
    order = [int(i) for i in np.argsort(-sims)]
    if len(order) <= k:
        return order
    step = _grid_step(coords, ps0)
    interior = _interior_mask(coords, step)
    min_sep = 2 * step  # returned foci sit ≥1 empty patch apart, so a hot spot yields one box
    edge_cap = max(1, k // 2)
    picks: list[int] = []
    n_edge = 0

    def _distinct(i: int) -> bool:
        xi, yi = int(coords[i][0]), int(coords[i][1])
        return all(
            abs(xi - int(coords[j][0])) >= min_sep or abs(yi - int(coords[j][1])) >= min_sep
            for j in picks
        )

    # Tier 1: spatially-distinct foci, capping edge patches so the list isn't edge-dominated.
    for i in order:
        if len(picks) >= k:
            break
        if not _distinct(i):
            continue
        if not interior[i] and n_edge >= edge_cap:
            continue
        picks.append(i)
        if not interior[i]:
            n_edge += 1
    # Tier 2: small/degenerate tissue left us short → top up in similarity order to guarantee k.
    if len(picks) < k:
        chosen = set(picks)
        for i in order:
            if len(picks) >= k:
                break
            if i not in chosen:
                picks.append(i)
                chosen.add(i)
    picks.sort(key=lambda i: -float(sims[i]))
    return picks


def _conch_text_embed(query: str, encoder: str, dim: int) -> np.ndarray:
    """Embed `query` with the conch package text tower (real path; manual GPU smoke)."""
    import torch
    from conch.open_clip_custom import (
        create_model_from_pretrained,
        get_tokenizer,
        tokenize,
    )

    model, _ = create_model_from_pretrained(
        "conch_ViT-B-16", checkpoint_path="hf_hub:MahmoodLab/conch"
    )
    tokenizer = get_tokenizer()
    tokens = tokenize(texts=[query], tokenizer=tokenizer)
    with torch.inference_mode():
        emb = model.encode_text(tokens, normalize=True)
    return emb[0].cpu().numpy().astype(np.float32)
