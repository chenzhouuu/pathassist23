"""Text→patch region retrieval for find_regions, behind the stub/real seam.

Given a ready text-capable index (features h5), embed the query into the shared space and cosine
against the unit-norm patch features → top-K level-0 boxes. The stub derives a deterministic,
query-sensitive text vector so retrieval is CI-testable with no GPU; the real path embeds with the
`conch` package's text tower (F1: conch_v1 with projection — NOT a Trident method).
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
    encoder: str = "conch_v1",
    *,
    use_trident: bool = False,
) -> list[dict]:
    """Top-K level-0 candidate boxes for `query`, ranked by cosine similarity (desc)."""
    feats, coords, attrs = read_features_h5(features_path)
    if feats.size == 0:
        return []
    ps0 = int(attrs.get("patch_size_level0", 256))
    dim = int(feats.shape[1])
    q = _conch_text_embed(query, encoder, dim) if use_trident else _stub_text_vec(query, dim)
    sims = np.asarray(feats, dtype=np.float32) @ q  # feats + q unit-norm → cosine
    order = np.argsort(-sims)[: max(1, int(k))]
    return [
        {
            "x": int(coords[i][0]), "y": int(coords[i][1]),
            "width": ps0, "height": ps0, "score": round(float(sims[i]), 4),
        }
        for i in order
    ]


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
