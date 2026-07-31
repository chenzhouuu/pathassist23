"""The downstream-task registry (Inc 2c) — pure data, no torch, always runs."""

import pytest

from preprocess_service.tasks import BRCA_IDC_ILC, TASKS, FeatureSpec, get_task, list_tasks

# ── registry ────────────────────────────────────────────────────────────────────────


def test_brca_task_is_registered_under_its_id():
    assert get_task("brca_idc_ilc") is BRCA_IDC_ILC
    assert get_task("nope") is None


def test_registry_is_immutable():
    with pytest.raises(TypeError):
        TASKS["x"] = BRCA_IDC_ILC


def test_brca_task_matches_the_trained_checkpoint_shape():
    # These four must agree with s3mil/tcga_brca/conch/abmil_fold0.pt or _assert_shapes will fire.
    t = BRCA_IDC_ILC
    assert (t.in_dim, t.embed_dim, t.attn_dim, t.n_classes) == (512, 256, 128, 2)
    assert t.classes == ("IDC", "ILC")


def test_brca_feature_spec_is_the_resolution_the_model_trained_on():
    # hgmil trains every BRCA model on 20x_256px_0px_overlap/features_conch_v1 — NOT the panel's
    # 512 px conch_v1 default. Guarding this is the whole point of Fork 2.
    assert BRCA_IDC_ILC.feature_spec == FeatureSpec("conch_v1", 20, 256, 0)


def test_list_tasks_is_json_ready_and_hides_the_weights_path():
    (task,) = list_tasks()
    assert task["id"] == "brca_idc_ilc"
    assert task["classes"] == ["IDC", "ILC"] and task["n_classes"] == 2
    assert task["feature_spec"]["patch_size"] == 256
    assert "weights_file" not in task


def test_list_tasks_carries_the_metrics_and_the_caveat_the_panel_prints():
    (task,) = list_tasks()
    assert task["metrics"]["test_auc"] == pytest.approx(0.895)
    assert task["metrics"]["n_test"] == 189
    assert "invasive" in task["caveat"].lower()


# ── FeatureSpec.matches ─────────────────────────────────────────────────────────────

SPEC = FeatureSpec("conch_v1", 20, 256, 0)
OK = {"encoder": "conch_v1", "mag": 20, "patch_size": 256, "overlap": 0}


def test_matches_exact_params():
    assert SPEC.matches(OK)


@pytest.mark.parametrize("field,bad", [
    ("encoder", "uni_v2"), ("mag", 40), ("patch_size", 512), ("overlap", 64),
])
def test_rejects_any_differing_constrained_field(field, bad):
    assert not SPEC.matches({**OK, field: bad})


def test_tolerates_string_numerics_from_json_params():
    assert SPEC.matches({"encoder": "conch_v1", "mag": "20", "patch_size": "256", "overlap": "0"})


def test_rejects_unparseable_numerics():
    assert not SPEC.matches({**OK, "patch_size": "big"})


def test_absent_fields_cannot_contradict_the_spec():
    # A features row records the encoder; mag/patch_size live on its patching parent, so the
    # gateway may hand us a partial param dict. Missing ≠ mismatched.
    assert SPEC.matches({"encoder": "conch_v1"})
    assert SPEC.matches({})


def test_segmenter_is_deliberately_unconstrained():
    # Fork 2: segmenter propagates seg_hash → patch_hash → feat_hash, so constraining it would
    # reject every otherwise-valid index and force a redundant rebuild.
    assert SPEC.matches({**OK, "segmenter": "otsu"})
    assert SPEC.matches({**OK, "segmenter": "hest"})
