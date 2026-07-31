"""MIL inference (Inc 2c).

Hashing, paths and geometry are torch-free and always run. The model tests are gated on torch +
the weights being present, because Fork 7 put ``/predict`` in the trident image only.

The L1 regression is the only check that can prove the port is faithful: identical inputs and
identical weights must give identical numbers as ``lcr_mil.teacher.abmil.ABMIL``. The golden file
was produced by that module (see the fixture's ``_note``), so this compares against the training
code, not against ourselves.
"""

import importlib.util
import json
from pathlib import Path

import numpy as np
import pytest

from preprocess_service.predict import (
    FeatureMismatch,
    _patch_px,
    forward,
    pred_hash,
    pred_paths,
    run_prediction,
    weights_path,
)
from preprocess_service.tasks import BRCA_IDC_ILC

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "abmil_brca_golden.json").read_text())
WEIGHTS_ROOT = Path("/home/chen/data2/models/mil")

needs_model = pytest.mark.skipif(
    importlib.util.find_spec("torch") is None
    or not (WEIGHTS_ROOT / BRCA_IDC_ILC.weights_file).exists(),
    reason="needs torch + task weights (the trident image / a GPU host)",
)


def golden_bag() -> np.ndarray:
    """The fixture bag — must be generated exactly as tests/fixtures/gen_abmil_golden.py does."""
    rng = np.random.default_rng(GOLDEN["seed"])
    raw = rng.standard_normal((GOLDEN["n"], GOLDEN["dim"]))
    return (raw * GOLDEN["feature_std"] + GOLDEN["feature_mean"]).astype(np.float32)


# ── hashing / paths (torch-free) ────────────────────────────────────────────────────


def test_pred_hash_is_deterministic_and_16_chars():
    a = pred_hash("feed1234", "brca_idc_ilc", "abmil-conch-brca-fold0-v1")
    assert a == pred_hash("feed1234", "brca_idc_ilc", "abmil-conch-brca-fold0-v1")
    assert len(a) == 16


@pytest.mark.parametrize("args", [
    ("other456", "brca_idc_ilc", "abmil-conch-brca-fold0-v1"),   # parent features
    ("feed1234", "nsclc_lusc_luad", "abmil-conch-brca-fold0-v1"),  # task
    ("feed1234", "brca_idc_ilc", "abmil-conch-brca-fold1-v1"),   # weights version
])
def test_pred_hash_varies_with_parent_task_and_weights(args):
    base = pred_hash("feed1234", "brca_idc_ilc", "abmil-conch-brca-fold0-v1")
    assert pred_hash(*args) != base


def test_pred_hash_varies_with_the_invalidation_version():
    base = pred_hash("feed1234", "brca_idc_ilc", "abmil-conch-brca-fold0-v1")
    assert pred_hash("feed1234", "brca_idc_ilc", "abmil-conch-brca-fold0-v1", "v2") != base


def test_pred_paths_sit_beside_the_other_dag_kinds(tmp_path):
    p = pred_paths(tmp_path, "item123", "abc0000000000000")
    assert p["prediction"] == tmp_path / "item123" / "pred" / "abc0000000000000" / "prediction.json"


def test_pred_paths_reject_path_traversal(tmp_path):
    with pytest.raises(ValueError):
        pred_paths(tmp_path, "../escape", "abc0000000000000")


def test_patch_px_is_read_from_the_coords_attrs_not_derived():
    # Risk ⑤: 256 px at 20× is 512 level-0 px on a 40× slide and 256 on a 20× slide. Trident
    # records the truth in patch_size_level0; deriving it from mag/patch_size misplaces the
    # heatmap on half the cohort.
    at_20x = {"patch_size": 256, "target_magnification": 20}
    assert _patch_px({**at_20x, "patch_size_level0": 512}) == 512    # 40× slide
    assert _patch_px({**at_20x, "patch_size_level0": 256}) == 256    # 20× slide


def test_patch_px_fails_loudly_when_the_geometry_attr_is_missing():
    with pytest.raises(FeatureMismatch, match="patch_size_level0"):
        _patch_px({"patch_size": 256, "target_magnification": 20})


# ── L1: port fidelity ───────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def out():
    return forward(BRCA_IDC_ILC, golden_bag(), WEIGHTS_ROOT)


@needs_model
def test_probs_match_the_training_code(out):
    assert out["probs"] == pytest.approx(GOLDEN["probs"], abs=1e-5)
    assert int(np.argmax(out["probs"])) == GOLDEN["pred_index"]


@needs_model
def test_attention_matches_the_training_code(out):
    assert out["attention"] == pytest.approx(GOLDEN["attention"], abs=1e-5)


@needs_model
def test_evidence_matches_the_reference_derivation(out):
    assert out["evidence"] == pytest.approx(GOLDEN["evidence"], abs=1e-5)


@needs_model
def test_attention_is_a_softmax_over_the_whole_bag(out):
    assert out["attention"].sum() == pytest.approx(1.0, abs=1e-6)
    assert (out["attention"] > 0).all()


@needs_model
def test_evidence_sums_to_the_slide_logit_margin(out):
    # The claim that makes this a decomposition of the decision, not a saliency heuristic.
    assert out["evidence"].sum() == pytest.approx(GOLDEN["logit_margin"], abs=1e-5)


@needs_model
def test_evidence_is_signed_both_ways(out):
    assert (out["evidence"] > 0).any() and (out["evidence"] < 0).any()


@needs_model
def test_weights_are_the_exported_checkpoint():
    from preprocess_service.predict import sha256_of

    assert sha256_of(weights_path(WEIGHTS_ROOT, BRCA_IDC_ILC)) == GOLDEN["weights_sha256"]


# ── guards ──────────────────────────────────────────────────────────────────────────


@needs_model
def test_rejects_features_of_the_wrong_dimensionality():
    with pytest.raises(FeatureMismatch, match="512-d"):
        forward(BRCA_IDC_ILC, np.zeros((8, 1024), dtype=np.float32), WEIGHTS_ROOT)


@needs_model
def test_rejects_an_empty_bag():
    with pytest.raises(FeatureMismatch, match="no patches"):
        forward(BRCA_IDC_ILC, np.zeros((0, 512), dtype=np.float32), WEIGHTS_ROOT)


@needs_model
def test_rejects_missing_weights(tmp_path):
    with pytest.raises(FileNotFoundError):
        forward(BRCA_IDC_ILC, golden_bag(), tmp_path)


# ── end to end over a features.h5 ───────────────────────────────────────────────────


@needs_model
def test_run_prediction_reads_a_features_h5_and_summarises(tmp_path):
    from preprocess_service.artifacts import write_features_h5

    bag = golden_bag()
    coords = np.arange(GOLDEN["n"] * 2, dtype=np.int64).reshape(-1, 2) * 512
    path = tmp_path / "features.h5"
    write_features_h5(path, bag, coords, {"patch_size_level0": 512, "target_magnification": 20})

    res = run_prediction(BRCA_IDC_ILC, path, WEIGHTS_ROOT)

    assert res.pred_index == GOLDEN["pred_index"]
    assert res.probs == pytest.approx(GOLDEN["probs"], abs=1e-5)
    assert res.n_patches == GOLDEN["n"]
    assert res.patch_px == 512
    assert res.elapsed_ms >= 0

    summary = res.summary()
    assert summary["pred_label"] == "IDC"
    assert summary["model_ver"] == "abmil-conch-brca-fold0-v1"
    assert "coords" not in summary          # arrays never ride in the DB row

    doc = res.document()
    assert len(doc["attention"]) == len(doc["evidence"]) == GOLDEN["n"]
    assert len(doc["coords"]) == GOLDEN["n"] * 2
    assert doc["patch_px"] == 512
    json.dumps(doc)                          # must be JSON-serialisable as written to disk
