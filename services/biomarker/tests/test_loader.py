import numpy as np

from biomarker_service.model import _candidates, remap_state_dict


def _z(*shape):
    return np.zeros(shape, dtype=np.float32)


def test_candidate_transforms():
    # module. strip
    assert "decoder4.0.weight" in _candidates("module.decoder4.0.weight")
    # encoder.* → encoder.base_model.model.*
    assert "encoder.base_model.model.blocks.0.norm1.weight" in \
        _candidates("encoder.blocks.0.norm1.weight")
    # .base_layer. → .
    assert "encoder.qkv.weight" in _candidates("encoder.qkv.base_layer.weight")


def test_remap_maps_every_key_via_each_branch():
    model_state = {
        "encoder.base_model.model.blocks.0.norm1.weight": _z(4),
        "decoder4.0.weight": _z(2, 3),
        "final_conv.weight": _z(23, 24, 1, 1),
        "encoder.base_model.model.blocks.0.attn.qkv.base_layer.weight": _z(6, 4),
    }
    ckpt = {
        "encoder.blocks.0.norm1.weight": _z(4),                     # encoder-> branch
        "module.decoder4.0.weight": _z(2, 3),                       # module strip branch
        "final_conv.weight": _z(23, 24, 1, 1),                      # direct
        "encoder.blocks.0.attn.qkv.base_layer.weight": _z(6, 4),    # encoder-> (keeps base_layer)
    }
    loaded = remap_state_dict(ckpt, model_state)
    assert set(loaded) == set(model_state)  # every model tensor got a value


def test_remap_rejects_shape_mismatch():
    model_state = {"final_conv.weight": _z(23, 24, 1, 1)}
    ckpt = {"final_conv.weight": _z(1)}  # right key, wrong shape
    assert remap_state_dict(ckpt, model_state) == {}


def test_wrong_prefix_matches_nothing_trips_fidelity():
    # a checkpoint whose keys share no candidate with the model → 0 matched → load_flash would raise
    model_state = {"encoder.base_model.model.blocks.0.norm1.weight": _z(4)}
    ckpt = {"totally.unrelated.key": _z(4)}
    assert remap_state_dict(ckpt, model_state) == {}
