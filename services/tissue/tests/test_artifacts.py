import pytest

from tissue_service.artifacts import (
    CORE,
    Coverage,
    art_hash,
    artifact_dir,
    class_tile_path,
    level_offset,
    prob_tile_path,
)


def test_hash_excludes_bbox_but_separates_backends():
    # bbox is coverage, not identity: two region jobs must land on the SAME artifact (D6).
    a = art_hash(seg_hash="seg1", backend="bcss_fcn_unet", store_mpp=1.0)
    b = art_hash(seg_hash="seg1", backend="bcss_fcn_unet", store_mpp=1.0)
    assert a == b
    # a different backend is a different map, so it must not overwrite the first (D1)
    assert art_hash(seg_hash="seg1", backend="uni_decoder", store_mpp=1.0) != a
    assert art_hash(seg_hash="seg2", backend="bcss_fcn_unet", store_mpp=1.0) != a
    assert art_hash(seg_hash="seg1", backend="bcss_fcn_unet", store_mpp=0.5) != a
    # overlap changes the probability field, so it is identity — not a tuning knob two runs share
    assert art_hash(seg_hash="seg1", backend="bcss_fcn_unet", store_mpp=1.0, overlap=64) != a


def test_level_offset_is_derived_not_assumed():
    assert level_offset(0.25, 1.0) == 2
    assert level_offset(0.5, 1.0) == 1          # a 20x slide must not claim 2 octaves
    assert level_offset(0.2519, 1.0) == 2       # real slides are never exactly 0.25
    assert level_offset(1.0, 1.0) == 0
    assert level_offset(2.0, 1.0) == 0          # never negative


def test_paths_reject_traversal(tmp_path):
    with pytest.raises(ValueError):
        artifact_dir(tmp_path, "../etc", "abc")
    with pytest.raises(ValueError):
        artifact_dir(tmp_path, "item", "..")
    root = artifact_dir(tmp_path, "item1", "ab12")
    assert class_tile_path(root, 0, 3, 4).name == "3_4.png"
    assert prob_tile_path(root, 2, 3, 4).parent.name == "2"


def test_coverage_accumulates_and_is_idempotent(tmp_path):
    cov = Coverage()
    cov.add(1, 1)
    cov.add(1, 1)
    assert len(cov.done) == 1
    cov.add(2, 1)
    cov.save(tmp_path)

    again = Coverage.load(tmp_path)
    assert again.done == {(1, 1), (2, 1)}
    assert again.missing([(1, 1), (3, 3)]) == [(3, 3)]
    assert again.bounds() == (CORE, CORE, 2 * CORE, CORE)


def test_empty_coverage_has_no_bounds(tmp_path):
    assert Coverage.load(tmp_path).bounds() is None
