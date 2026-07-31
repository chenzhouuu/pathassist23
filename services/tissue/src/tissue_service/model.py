"""Backend loading — the only module that touches torch on the real path.

Kept tiny and lazy on purpose (mirrors ``biomarker/model.py``): ``_arch`` imports torch and
torchvision at module top, so nothing outside this function may import it.
"""

import logging

from .classes import Backend

logger = logging.getLogger(__name__)


def load_backend(backend: Backend, weights_path: str, device: str = "cpu"):
    """Build the network, load the checkpoint **strictly**, and put it in eval mode.

    ``strict=True`` is the contract: every one of the checkpoint's parameters must find a home and
    match in shape. It does not prove the *wiring* is right (an additive skip and a plain upsample
    have the same channel count) — that is what ``tests/test_arch_reference.py`` is for.
    """
    import torch

    from ._arch import build

    model = build(num_output_channels=len(backend.classes))
    state = torch.load(weights_path, map_location="cpu")
    model.load_state_dict(state, strict=True)
    model.eval()
    model.to(device)
    logger.info("tissue backend %s loaded from %s on %s", backend.name, weights_path, device)
    return model


def predict_fn(model, device: str = "cpu"):
    """Wrap a loaded model as ``predict(rgb_uint8_HxWx3) -> [C, out, out] float32 in [0, 1]``.

    The centre crop is the network's own: it sees ``patch_in`` and only the middle ``patch_in/2``
    of the upsampled probability field is trustworthy, because that is the extent whose receptive
    field lies wholly inside the input.
    """
    import numpy as np
    import torch

    def predict(rgb: "np.ndarray") -> "np.ndarray":
        with torch.no_grad():
            t = torch.from_numpy(np.ascontiguousarray(rgb))
            t = t.permute(2, 0, 1).unsqueeze(0).float().div_(255.0).to(device)
            prob = model(t)[0]                       # [C, H, W] at input resolution
            c, h, w = prob.shape
            oy, ox = h // 4, w // 4                  # centre crop to half
            prob = prob[:, oy:oy + h // 2, ox:ox + w // 2]
            return prob.float().cpu().numpy()

    return predict
