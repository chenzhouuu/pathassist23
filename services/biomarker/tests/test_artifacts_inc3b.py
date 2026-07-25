"""Artifact identity + coverage (D6): bbox is coverage, not identity."""

import pytest

from biomarker_service.artifacts import (
    CORE,
    Coverage,
    art_hash,
    artifact_dir,
    read_json,
    write_json,
)

_BASE = {"seg_hash": "abc123", "marker_mpp": 1.0, "pheno_mpp": 0.25, "nucleus_radius_um": 4.0}


def test_art_hash_is_stable_and_ignores_bbox():
    h1 = art_hash(**_BASE)
    assert h1 == art_hash(**_BASE)          # deterministic
    assert len(h1) == 16
    # there is no bbox parameter at all — framing a second region must land in the SAME artifact
    assert "bbox" not in art_hash.__code__.co_varnames


def test_art_hash_changes_with_every_input_that_changes_the_numbers():
    base = art_hash(**_BASE)
    assert art_hash(**{**_BASE, "seg_hash": "def456"}) != base
    assert art_hash(**{**_BASE, "marker_mpp": 2.0}) != base
    assert art_hash(**{**_BASE, "pheno_mpp": 0.5}) != base
    assert art_hash(**{**_BASE, "nucleus_radius_um": 6.0}) != base
    assert art_hash(**_BASE, version="other") != base


def test_artifact_dir_rejects_traversal():
    for bad in ("..", "a/b", "", "../etc"):
        with pytest.raises(ValueError):
            artifact_dir("/cache", bad, "hash")
        with pytest.raises(ValueError):
            artifact_dir("/cache", "item", bad)


def test_coverage_is_idempotent_and_subtracts(tmp_path):
    cov = Coverage()
    cov.add(0, 0)
    cov.add(0, 0)                            # re-running a covered tile changes nothing
    assert len(cov.done) == 1
    assert cov.has(0, 0) and not cov.has(1, 0)
    assert cov.missing([(0, 0), (1, 0), (2, 3)]) == [(1, 0), (2, 3)]


def test_coverage_round_trips_through_disk(tmp_path):
    cov = Coverage()
    cov.add(2, 3)
    cov.add(0, 1)
    cov.save(tmp_path)
    back = Coverage.load(tmp_path)
    assert back.done == {(2, 3), (0, 1)}
    assert back.core == CORE
    # a never-written artifact loads as empty, not as an error
    assert Coverage.load(tmp_path / "nope").done == set()


def test_coverage_bounds_is_the_level0_extent(tmp_path):
    cov = Coverage()
    assert cov.bounds() is None
    cov.add(1, 2)
    assert cov.bounds() == (CORE, 2 * CORE, CORE, CORE)


def test_write_json_is_atomic_enough_to_never_leave_a_partial_file(tmp_path):
    p = tmp_path / "meta.json"
    write_json(p, {"a": 1})
    assert read_json(p) == {"a": 1}
    assert not list(tmp_path.glob("*.tmp"))
    assert read_json(tmp_path / "missing.json") is None
