"""The gate that a strict state-dict load cannot give us: is the *wiring* right?

``load_state_dict(strict=True)`` proves every parameter found a home of the right shape. It does
not prove the forward pass uses them the way the checkpoint's author did — an additive skip and a
bare upsample have identical channel counts, so a wrong decoder would load cleanly and then
produce a confidently wrong map.

This test settles it by differencing against the reference implementation. It is skipped unless
BOTH tiatoolbox and the checkpoint are present, so it is a development gate rather than a runtime
dependency: the service image ships neither.

    uv venv /tmp/tiaenv && uv pip install --python /tmp/tiaenv/bin/python tiatoolbox
    TISSUE_TEST_WEIGHTS=/home/chen/data2/tissue_seg/fcn_resnet50_unet-bcss.pth \
        /tmp/tiaenv/bin/python -m pytest tests/test_arch_reference.py
"""

import os

import numpy as np
import pytest

torch = pytest.importorskip("torch")
tia = pytest.importorskip("tiatoolbox.models.architecture.unet")

WEIGHTS = os.getenv("TISSUE_TEST_WEIGHTS", "/home/chen/data2/tissue_seg/fcn_resnet50_unet-bcss.pth")
pytestmark = pytest.mark.skipif(not os.path.isfile(WEIGHTS), reason="BCSS checkpoint not present")


def _both():
    from tissue_service._arch import build

    state = torch.load(WEIGHTS, map_location="cpu")
    ref = tia.UNetModel(num_input_channels=3, num_output_channels=5, encoder="resnet50",
                        decoder_block=[3, 3], skip_type="add")
    ref.load_state_dict(state, strict=True)
    mine = build(5)
    mine.load_state_dict(state, strict=True)
    return ref.eval(), mine.eval()


def test_strict_load_accounts_for_every_checkpoint_parameter():
    from tissue_service._arch import build

    state = torch.load(WEIGHTS, map_location="cpu")
    model = build(5)
    model.load_state_dict(state, strict=True)      # raises on any missing/unexpected key
    assert len(state) == 372


@pytest.mark.parametrize("side", [512, 1024])
def test_vendored_arch_matches_the_reference_exactly(side):
    ref, mine = _both()
    img = np.random.default_rng(0).integers(0, 255, (1, side, side, 3), dtype=np.uint8)

    ref_out = tia.UNetModel.infer_batch(ref, torch.from_numpy(img), device="cpu")[0]
    with torch.no_grad():
        t = torch.from_numpy(img).permute(0, 3, 1, 2).float().div_(255.0)
        c = side // 4
        mine_out = mine(t)[0, :, c:c + side // 2, c:c + side // 2].permute(1, 2, 0).numpy()

    assert ref_out.shape == mine_out.shape
    assert np.abs(ref_out - mine_out).max() == 0.0
    assert (ref_out.argmax(-1) == mine_out.argmax(-1)).all()


def test_normalisation_is_divide_by_255_with_no_imagenet_stats():
    """The reference's `_transform` is the whole preprocessing. Pin it: a mean/std applied here
    would shift every logit and produce a map that looks plausible and is wrong."""
    x = torch.full((1, 3, 8, 8), 255.0)
    assert torch.allclose(tia.UNetModel._transform(x), torch.ones_like(x))
