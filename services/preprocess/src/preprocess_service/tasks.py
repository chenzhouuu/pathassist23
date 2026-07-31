"""The downstream-task registry (Inc 2c) — what MIL models this deployment can run.

One frozen dataclass per task. A task owns three things the rest of the service needs:

  * ``feature_spec`` — the preprocess build its weights were trained on. The Task panel matches a
    slide's existing feature artifacts against this and offers to build the right one if none fits.
    It deliberately constrains only ``encoder/mag/patch_size/overlap``: ``segmenter`` propagates
    through seg_hash → patch_hash → feat_hash, so including it would reject every otherwise-valid
    index built with a different segmenter and force a redundant rebuild.
  * ``arch`` + dims — enough to rebuild the module and assert the checkpoint agrees.
  * ``model_ver`` — part of ``pred_hash``, so re-pointing a task at new weights invalidates cleanly.

The table is pure data with no torch import, so ``GET /tasks`` is served by the CPU image too; only
``/predict`` needs the GPU image (see ``predict.py``).
"""

from dataclasses import asdict, dataclass, field
from types import MappingProxyType

# Bump to invalidate every cached prediction (part of pred_hash).
PRED_VERSION = "v1"


@dataclass(frozen=True)
class FeatureSpec:
    """The preprocess build a task's weights were trained on."""

    encoder: str
    mag: int
    patch_size: int
    overlap: int = 0

    def matches(self, params: dict) -> bool:
        """True when a features-artifact's params satisfy this spec.

        ``params`` carries the whole chain's parameters as the gateway stored them; only the four
        fields above are compared, and only when present (a param the row never recorded cannot
        contradict the spec).
        """
        for key, want in (
            ("encoder", self.encoder), ("mag", self.mag),
            ("patch_size", self.patch_size), ("overlap", self.overlap),
        ):
            got = params.get(key)
            if got is None:
                continue
            if isinstance(want, int):
                try:
                    got = int(got)
                except (TypeError, ValueError):
                    return False
            if got != want:
                return False
        return True


@dataclass(frozen=True)
class TaskSpec:
    """One downstream task: a model, the features it eats, and what it is honest about."""

    id: str
    label: str
    classes: tuple[str, ...]
    arch: str                    # dispatch key in predict.py
    in_dim: int                  # patch feature dim (must equal the features.h5 dim)
    embed_dim: int
    attn_dim: int
    weights_file: str            # basename under the weights root
    model_ver: str
    feature_spec: FeatureSpec
    metrics: dict = field(default_factory=dict)
    cohort: str = ""
    caveat: str = ""

    @property
    def n_classes(self) -> int:
        return len(self.classes)

    def to_json(self) -> dict:
        """JSON-ready view for GET /tasks (weights_file stays server-side)."""
        d = asdict(self)
        d.pop("weights_file", None)
        d["classes"] = list(self.classes)
        d["n_classes"] = self.n_classes
        return d


BRCA_IDC_ILC = TaskSpec(
    id="brca_idc_ilc",
    label="Breast · IDC vs ILC (TCGA-BRCA)",
    classes=("IDC", "ILC"),
    arch="abmil",
    in_dim=512,
    embed_dim=256,
    attn_dim=128,
    weights_file="brca_idc_ilc_abmil_conch_fold0.pt",
    model_ver="abmil-conch-brca-fold0-v1",
    # `conch_v1` is the VISION variant (Trident defaults) — the space hgmil trained on. The
    # text-search variant `conch_v1_text` is a near-orthogonal embedding and must never match here.
    feature_spec=FeatureSpec(encoder="conch_v1", mag=20, patch_size=256, overlap=0),
    metrics={"test_auc": 0.895, "test_acc": 0.878, "test_f1": 0.623, "n_test": 189, "fold": 0},
    cohort="TCGA-BRCA — 942 cases (IDC 753 / ILC 189), patient-level 5-fold split, fold 0",
    caveat=(
        "Distinguishes invasive ductal from invasive lobular carcinoma only. The output is not "
        "meaningful for benign, in-situ or non-breast slides."
    ),
)

TASKS: MappingProxyType[str, TaskSpec] = MappingProxyType({
    BRCA_IDC_ILC.id: BRCA_IDC_ILC,
})


def list_tasks() -> list[dict]:
    """Every registered task, JSON-ready, in registration order."""
    return [t.to_json() for t in TASKS.values()]


def get_task(task_id: str) -> TaskSpec | None:
    return TASKS.get(task_id)
