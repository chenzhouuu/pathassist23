"""Loading a CellViT++ classifier head, and running it over stored tokens (Inc 7 §2, §6).

A head is a two-layer MLP over the per-nucleus token — `Linear(1280 → hidden) · ReLU ·
Linear(hidden → C)`, which upstream applies inside its ray postprocessing actor the moment the
tokens come off the encoder. We apply the same four tensors later, from disk. The operation is
theirs; only its position in time is ours.

**The arithmetic is numpy, not torch.** This service's base environment has numpy and no torch —
that is deliberate and predates this increment (`pyproject.toml`), and it is what lets the whole
DAG stay testable with no GPU. A 1280→512→7 MLP is two matmuls, so keeping it in numpy costs
nothing and buys a classify path that runs, and is tested, in the GPU-free image. torch appears in
exactly one function, to read the checkpoint file, because a `.pth` is a pickle of torch storages
and hand-rolling a reader for it would be inventing a mechanism upstream already has.

**Where the files come from.** `cache_classifier()`, upstream's own, which downloads Zenodo's
`classifier.zip` into `$CELLVIT_CACHE/classifier/` and unpacks it — the same volume and the same
failure mode as the 2.8 GB SAM-H checkpoint beside it. Nothing here re-implements that.
"""

import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .artifacts import TOKEN_DIM
from .taxonomy import HEAD_IDS, Taxonomy
from .taxonomy import get as get_taxonomy

logger = logging.getLogger(__name__)


class HeadUnavailable(RuntimeError):
    """The checkpoint for a taxonomy is missing, unreadable, or not the shape it claims."""


@dataclass(frozen=True)
class Head:
    """One classifier head's four tensors, and the labelling they perform.

    Deliberately a plain value: a test builds one from synthetic weights and never touches torch or
    the filesystem, which is the only way the classify loop is testable in the base environment.
    """

    taxonomy: str
    w1: np.ndarray          # (hidden, 1280)
    b1: np.ndarray          # (hidden,)
    w2: np.ndarray          # (C, hidden)
    b2: np.ndarray          # (C,)
    model_offset: int

    def __call__(self, tokens: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """`[N, 1280]` tokens → `(stored class ids uint8[N], softmax confidence float32[N])`.

        The returned ids are **stored** ids: `argmax + model_offset`, so 0 stays reserved for "no
        nucleus" everywhere downstream (see `taxonomy.py`).

        The confidence is the real softmax value of the winning class. Upstream computes the same
        number and then writes `int(z)` into `type_prob`, which truncates everything below 1.0 to
        zero; that is why this is worth returning rather than inheriting.
        """
        x = np.asarray(tokens, dtype=np.float32).reshape(-1, TOKEN_DIM)
        if x.shape[0] == 0:
            return np.zeros(0, dtype=np.uint8), np.zeros(0, dtype=np.float32)
        h = np.maximum(x @ self.w1.T + self.b1, 0.0)
        logits = h @ self.w2.T + self.b2
        # Stable softmax: the logits of a confident head reach into the tens, and exp of that
        # overflows float32 long before the ratio it is part of does.
        e = np.exp(logits - logits.max(axis=1, keepdims=True))
        prob = e / e.sum(axis=1, keepdims=True)
        idx = prob.argmax(axis=1)
        cls = (idx + self.model_offset).astype(np.uint8)
        return cls, prob[np.arange(idx.shape[0]), idx].astype(np.float32)


# One head is ~3 MB and is read once per process. Guarded because the classify job and a catalog
# request can arrive together on a threaded server.
_HEADS: dict[str, Head] = {}
_HEADS_LOCK = threading.Lock()


def head_dir(*, download: bool = False) -> Path:
    """Where the SAM-H classifier checkpoints live.

    With ``download`` the upstream cacher runs, fetching and unpacking `classifier.zip` if it is
    not there yet. Without it this only says where to look — so a catalog request never blocks on
    a Zenodo round trip, and only an actual run pays for the first fetch.
    """
    if download:
        try:
            from cellvit.utils.cache_models import cache_classifier
        except ImportError:
            logger.info("cellvit package absent; classifier heads must already be in the cache")
        else:
            return Path(cache_classifier(logger)) / "sam-h"
    base = Path(os.getenv("CELLVIT_CACHE", str(Path.home() / ".cache" / "cellvit")))
    return base / "classifier" / "sam-h"


def checkpoint_path(taxonomy: str, *, download: bool = False) -> Path:
    tax = get_taxonomy(taxonomy)
    if not tax.checkpoint:
        raise HeadUnavailable(
            f"{tax.id} is not a classifier head — segmentation produces it"
        )
    return head_dir(download=download) / tax.checkpoint


def installed() -> dict[str, bool]:
    """Which of the five heads are on disk right now. Never downloads."""
    d = head_dir()
    return {t: (d / get_taxonomy(t).checkpoint).is_file() for t in HEAD_IDS}


def load_head(taxonomy: str) -> Head:
    """The head for a taxonomy, downloading the checkpoint bundle on first use.

    Raises:
        HeadUnavailable: when the file is missing and cannot be fetched, when torch is not present
            to read it, or when the checkpoint does not match what this service expects it to be.
    """
    if taxonomy in _HEADS:
        return _HEADS[taxonomy]
    with _HEADS_LOCK:
        if taxonomy not in _HEADS:
            _HEADS[taxonomy] = _build(get_taxonomy(taxonomy))
    return _HEADS[taxonomy]


def warm_heads() -> bool:
    """Fetch the checkpoint bundle at start-up so the first run does not pay for it.

    Best-effort and safe in a background thread, exactly like `infer.warm_up`: a box with no
    network still starts, and the failure is a logged warning at boot rather than a run that dies
    twenty minutes in.
    """
    try:
        d = head_dir(download=True)
    except Exception:  # noqa: BLE001 — a warm-up must never take the service down
        logger.warning("classifier head download failed; first classify run will retry",
                       exc_info=True)
        return False
    missing = [t for t, ok in installed().items() if not ok]
    logger.info("classifier heads in %s; missing: %s", d, missing or "none")
    return not missing


def reset_heads() -> None:
    """Drop the cache. For tests, and for a redeploy that replaced the checkpoints."""
    with _HEADS_LOCK:
        _HEADS.clear()


def _build(tax: Taxonomy) -> Head:
    path = checkpoint_path(tax.id, download=True)
    if not path.is_file():
        raise HeadUnavailable(
            f"no checkpoint for {tax.id} at {path} — the classifier bundle has not been "
            f"downloaded and this box could not fetch it"
        )
    state, config = _read_checkpoint(path)

    try:
        w1, b1 = state["fc1.weight"], state["fc1.bias"]
        w2, b2 = state["fc2.weight"], state["fc2.bias"]
    except KeyError as exc:
        raise HeadUnavailable(f"{path} is not a LinearClassifier checkpoint: {exc}") from exc

    if w1.shape[1] != TOKEN_DIM:
        raise HeadUnavailable(
            f"{tax.id} expects a {w1.shape[1]}-d token but this backbone produces {TOKEN_DIM} — "
            f"that head was trained on a different encoder"
        )
    declared = int(_conf(config, "data.num_classes", default=b2.shape[0]))
    if declared != tax.n_classes or b2.shape[0] != tax.n_classes:
        raise HeadUnavailable(
            f"{tax.id} names {tax.n_classes} classes but its checkpoint has "
            f"{b2.shape[0]} (config says {declared}) — taxonomy.py and the weights disagree"
        )

    logger.info("loaded %s head: %d-d token -> %d hidden -> %d classes",
                tax.id, w1.shape[1], w1.shape[0], b2.shape[0])
    return Head(taxonomy=tax.id, w1=w1, b1=b1, w2=w2, b2=b2, model_offset=tax.model_offset)


def _read_checkpoint(path: Path) -> tuple[dict[str, np.ndarray], dict]:
    """The one place torch is needed: a `.pth` is a pickle of torch storages.

    Everything crosses into numpy immediately, so nothing downstream holds a torch object or cares
    whether torch is installed.
    """
    try:
        import torch
    except ImportError as exc:
        raise HeadUnavailable(
            "reading a classifier checkpoint needs torch, which this image does not have"
        ) from exc
    doc = torch.load(path, map_location="cpu", weights_only=False)
    state = {k: v.detach().cpu().numpy().astype(np.float32)
             for k, v in doc["model_state_dict"].items()}
    return state, dict(doc.get("config") or {})


def _conf(config: dict, dotted: str, *, default):
    """Read a config key from either the flat dotted form the checkpoints use or a nested one."""
    if dotted in config:
        return config[dotted]
    node = config
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return node


__all__ = [
    "Head", "HeadUnavailable", "checkpoint_path", "head_dir", "installed", "load_head",
    "reset_heads", "warm_heads",
]
