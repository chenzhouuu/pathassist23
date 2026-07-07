def _req(mag=20):
    from pathagent.common.schemas import FeatureSpec, PreprocessRequest

    return PreprocessRequest(backbone=FeatureSpec(patchEncoder="conch_v1", mag=mag))


def test_cache_key_is_deterministic():
    from pathagent.common.cache_keys import compute_cache_key

    k1 = compute_cache_key("item123", _req())
    k2 = compute_cache_key("item123", _req())
    assert k1 == k2
    assert k1.startswith("item123-")


def test_cache_key_varies_with_params():
    from pathagent.common.cache_keys import compute_cache_key

    assert compute_cache_key("item123", _req(mag=20)) != compute_cache_key("item123", _req(mag=40))


def test_cache_paths(tmp_cache):
    from pathagent.common.cache_keys import cache_paths

    paths = cache_paths("item123-abc")
    assert paths.root == tmp_cache / "item123-abc"
    assert paths.manifest.name == "manifest.json"
    assert paths.features("conch_v1").name == "features_conch_v1.h5"


def test_classifier_path(tmp_cache):
    from pathagent.common.cache_keys import cache_paths

    paths = cache_paths("k")
    assert paths.classifier.name == "classifier.json"
    assert paths.classifier.parent == cache_paths("k").root


def test_rejects_unsafe_ids():
    import pytest

    from pathagent.common.cache_keys import cache_paths, compute_cache_key

    for bad in ("../etc", "a/b", ""):
        with pytest.raises(ValueError):
            compute_cache_key(bad, _req())
        with pytest.raises(ValueError):
            cache_paths(bad)


def test_features_rejects_unsafe_encoder(tmp_cache):
    import pytest

    from pathagent.common.cache_keys import cache_paths

    paths = cache_paths("item-abc")
    with pytest.raises(ValueError):
        paths.features("../evil")
    assert paths.features("conch_v1").name == "features_conch_v1.h5"


def test_heatmap_paths(tmp_cache):
    from pathagent.common.cache_keys import cache_paths

    paths = cache_paths("item123-abc")
    assert paths.heatmap("t1") == tmp_cache / "item123-abc" / "heatmaps" / "t1.png"
    assert paths.heatmap_meta("t1") == tmp_cache / "item123-abc" / "heatmaps" / "t1.json"
    assert str(paths.heatmap_meta("t1")).endswith("heatmaps/t1.json")


def test_heatmap_rejects_unsafe_task_id(tmp_cache):
    import pytest

    from pathagent.common.cache_keys import cache_paths

    paths = cache_paths("item-abc")
    for bad in ("../x", "a/b", ""):
        with pytest.raises(ValueError):
            paths.heatmap(bad)
        with pytest.raises(ValueError):
            paths.heatmap_meta(bad)
