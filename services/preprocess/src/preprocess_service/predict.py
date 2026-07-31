"""MIL inference — the fourth DAG stage (Inc 2c): features.h5 → subtype call + evidence map.

torch is imported **lazily inside the forward**, exactly like the Trident seam in ``stages.py``:
the CPU image has no torch, so ``/predict`` 503s there while ``GET /tasks`` keeps working. Nothing
here fabricates a stub prediction — a made-up 0.97 is worse than an honest "unavailable".

The module mirrors ``lcr_mil.teacher.abmil.ABMIL`` (Ilse et al. gated attention) parameter-for-
parameter so the trained checkpoint loads with ``strict=True``:

    h      = relu(W1·x + b1)          [N,in_dim] → [N,embed_dim]
    a      = softmax(Ww·(tanh(WV·h) ⊙ sigmoid(WU·h)) + bw, dim=0)
    z      = Σ aᵢ·hᵢ ;  logits = Wc·z + bc

Per-patch class evidence rides along on the same forward:

    Lᵢ = Wc·hᵢ + bc                   per-patch class scores
    eᵢ = aᵢ · (Lᵢ[pred] − Lᵢ[other])  signed, and Σᵢ eᵢ is exactly the slide's logit margin

so the heatmap is a decomposition of the decision, not a heuristic saliency map. Dropout is identity
under ``eval()``, which is why the port is bit-comparable with the training code (see the L1
regression test).
"""

import hashlib
import importlib.util
import logging
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .artifacts import _sha16, read_features_h5
from .tasks import PRED_VERSION, TaskSpec

logger = logging.getLogger(__name__)


class TorchUnavailable(RuntimeError):
    """This image ships without torch — the caller should surface a 503, not a failure."""


class FeatureMismatch(ValueError):
    """The features.h5 does not have the dimensionality the task's weights expect."""


def torch_available() -> bool:
    """Can this image run a task at all? Checks the spec only — never imports torch.

    The route layer calls this *before* queueing so a CPU image answers 503 immediately instead of
    accepting a job that is certain to fail on the worker thread.
    """
    return importlib.util.find_spec("torch") is not None


def pred_hash(feat_hash: str, task_id: str, model_ver: str, version: str = PRED_VERSION) -> str:
    """Id for a prediction — depends on its parent feature index, the task and the weights."""
    return _sha16(f"pred|p={feat_hash}|task={task_id}|mv={model_ver}|ver={version}")


def pred_paths(cache_root: Path, item: str, ph: str) -> dict[str, Path]:
    """{prediction} for a prediction under {cache}/{item}/pred/{pred_hash}/."""
    from .artifacts import _artifact_dir

    d = _artifact_dir(cache_root, item, "pred", ph)
    return {"dir": d, "prediction": d / "prediction.json"}


@dataclass
class PredictResult:
    """Everything one prediction produces: the summary the DB keeps, and the arrays on disk."""

    task_id: str
    model_ver: str
    classes: list[str]
    probs: list[float]
    pred_index: int
    n_patches: int
    patch_px: int
    elapsed_ms: int
    coords: np.ndarray      # [N, 2] level-0 px, index-aligned with the arrays below
    attention: np.ndarray   # [N]  softmax over the bag
    evidence: np.ndarray    # [N]  signed class evidence

    def summary(self) -> dict:
        """The compact record that lands in preprocess_artifact.result."""
        return {
            "task_id": self.task_id, "model_ver": self.model_ver, "classes": self.classes,
            "probs": self.probs, "pred_index": self.pred_index,
            "pred_label": self.classes[self.pred_index],
            "n_patches": self.n_patches, "elapsed_ms": self.elapsed_ms,
        }

    def document(self) -> dict:
        """The full prediction.json, including the per-patch arrays the heatmap needs."""
        return {
            **self.summary(),
            "patch_px": self.patch_px,
            "coords": [int(v) for v in self.coords.reshape(-1)],
            "attention": [float(v) for v in self.attention],
            "evidence": [float(v) for v in self.evidence],
        }


def weights_path(weights_root: Path, task: TaskSpec) -> Path:
    return Path(weights_root) / task.weights_file


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run_prediction(
    task: TaskSpec, features_path: Path, weights_root: Path,
) -> PredictResult:
    """Load the bag, run the task's model, return the call plus per-patch evidence."""
    features, coords, attrs = read_features_h5(features_path)
    started = time.perf_counter()
    out = forward(task, np.asarray(features), weights_root)
    elapsed_ms = int(round((time.perf_counter() - started) * 1000))

    probs = out["probs"]
    pred_index = int(np.argmax(probs))
    logger.info(
        "predict %s: %s p=%.4f over %d patches in %d ms",
        task.id, task.classes[pred_index], probs[pred_index], len(features), elapsed_ms,
    )
    return PredictResult(
        task_id=task.id, model_ver=task.model_ver, classes=list(task.classes),
        probs=[float(p) for p in probs], pred_index=pred_index,
        n_patches=int(len(features)), patch_px=_patch_px(attrs),
        elapsed_ms=elapsed_ms, coords=np.asarray(coords),
        attention=out["attention"], evidence=out["evidence"],
    )


def _patch_px(attrs: dict) -> int:
    """Level-0 side of one patch, read from the coords attrs the tiling stage wrote.

    Never derived from mag/patch_size: 256 px at 20× is 512 level-0 px on a 40× slide and 256 on a
    20× slide, so arithmetic here would misplace the heatmap on half the cohort.
    """
    if "patch_size_level0" in attrs:
        return int(attrs["patch_size_level0"])
    raise FeatureMismatch(
        "coords attrs carry no patch_size_level0; re-run the tiling stage "
        f"(saw keys: {sorted(attrs)})"
    )


# ── the model ───────────────────────────────────────────────────────────────────────


def forward(task: TaskSpec, features: np.ndarray, weights_root: Path) -> dict:
    """Run ``task``'s architecture over one bag. Returns probs / attention / evidence."""
    if task.arch != "abmil":
        raise ValueError(f"unsupported arch {task.arch!r} for task {task.id!r}")
    if features.ndim != 2:
        raise FeatureMismatch(f"features must be [N, dim], got shape {features.shape}")
    if features.shape[1] != task.in_dim:
        raise FeatureMismatch(
            f"task {task.id!r} expects {task.in_dim}-d features, got {features.shape[1]}-d "
            "— this feature index was built with a different encoder"
        )
    if features.shape[0] == 0:
        raise FeatureMismatch("features.h5 holds no patches")

    torch = _torch()
    model = _load_abmil(task, weights_root, torch)
    with torch.no_grad():
        x = torch.from_numpy(np.ascontiguousarray(features, dtype=np.float32))
        h = torch.relu(model["embed"](x))                        # [N, embed_dim]
        gate = torch.tanh(model["attn_V"](h)) * torch.sigmoid(model["attn_U"](h))
        a = torch.softmax(model["attn_w"](gate), dim=0)           # [N, 1]
        z = (a * h).sum(dim=0, keepdim=True)                      # [1, embed_dim]
        logits = model["classifier"](z)[0]                        # [C]
        probs = torch.softmax(logits, dim=0)

        pred = int(torch.argmax(probs).item())
        per_patch = model["classifier"](h)                        # [N, C]
        other = _runner_up(per_patch, pred, torch)
        evidence = a.squeeze(-1) * (per_patch[:, pred] - other)

    return {
        "probs": probs.numpy().astype(np.float64),
        "logits": logits.numpy().astype(np.float64),
        "attention": a.squeeze(-1).numpy().astype(np.float64),
        "evidence": evidence.numpy().astype(np.float64),
    }


def _runner_up(per_patch, pred: int, torch):
    """Per-patch score of the strongest competing class (the binary case is just the other one)."""
    if per_patch.shape[1] == 2:
        return per_patch[:, 1 - pred]
    mask = torch.ones(per_patch.shape[1], dtype=torch.bool)
    mask[pred] = False
    return per_patch[:, mask].max(dim=1).values


def _torch():
    try:
        import torch
    except ImportError as exc:                                    # pragma: no cover - env-dependent
        raise TorchUnavailable(
            "this preprocess image ships without torch; bring the service up with the trident "
            "override to run downstream tasks"
        ) from exc
    return torch


_CACHE: dict[tuple[str, str], dict] = {}


def _load_abmil(task: TaskSpec, weights_root: Path, torch) -> dict:
    """Build the gated-attention ABMIL layers and load the trained weights (cached per task)."""
    path = weights_path(weights_root, task)
    key = (task.model_ver, str(path))
    if key in _CACHE:
        return _CACHE[key]
    if not path.exists():
        raise FileNotFoundError(f"weights for task {task.id!r} not found at {path}")

    ckpt = torch.load(path, map_location="cpu", weights_only=True)
    sd = ckpt.get("model_state_dict", ckpt)
    _assert_shapes(task, sd)

    nn = torch.nn
    layers = {
        "embed": nn.Linear(task.in_dim, task.embed_dim),
        "attn_V": nn.Linear(task.embed_dim, task.attn_dim),
        "attn_U": nn.Linear(task.embed_dim, task.attn_dim),
        "attn_w": nn.Linear(task.attn_dim, 1),
        "classifier": nn.Linear(task.embed_dim, task.n_classes),
    }
    src = {
        "embed": "patch_embed.0", "attn_V": "attention.attention_V.0",
        "attn_U": "attention.attention_U.0", "attn_w": "attention.attention_w",
        "classifier": "classifier",
    }
    with torch.no_grad():
        for name, layer in layers.items():
            layer.weight.copy_(sd[f"{src[name]}.weight"])
            layer.bias.copy_(sd[f"{src[name]}.bias"])
            layer.eval()

    logger.info("loaded %s weights for task %s from %s", task.arch, task.id, path)
    _CACHE[key] = layers
    return layers


def _assert_shapes(task: TaskSpec, sd: dict) -> None:
    """Fail loudly when the registry and the checkpoint disagree about the architecture."""
    want = {
        "patch_embed.0.weight": (task.embed_dim, task.in_dim),
        "attention.attention_V.0.weight": (task.attn_dim, task.embed_dim),
        "attention.attention_U.0.weight": (task.attn_dim, task.embed_dim),
        "attention.attention_w.weight": (1, task.attn_dim),
        "classifier.weight": (task.n_classes, task.embed_dim),
    }
    for key, shape in want.items():
        if key not in sd:
            raise FeatureMismatch(f"checkpoint for {task.id!r} has no {key!r}")
        got = tuple(sd[key].shape)
        if got != shape:
            raise FeatureMismatch(
                f"checkpoint for {task.id!r} has {key} of shape {got}, registry says {shape}"
            )
