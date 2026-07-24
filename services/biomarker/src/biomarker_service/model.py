"""GigaTIME-Flash checkpoint loading — the notebook's key-remap, verbatim, plus a load-fidelity
assertion (review S3).

The checkpoint keys don't line up with the module tree: LoRA wrapping means ``encoder.*`` →
``encoder.base_model.model.*``, LoRA base layers carry a ``.base_layer.`` segment, and a
DataParallel checkpoint prefixes ``module.``. The remap below is a straight port of
``load_flash`` in the Flash notebook. Getting it wrong silently loads a **randomly-initialised**
ViT that still runs and returns plausible-looking garbage — so ``load_flash`` refuses to proceed
if too few tensors matched.

``remap_state_dict`` is pure (it only reads ``.shape``), so it is unit-tested with numpy arrays
and no torch (the base env has none).
"""

import logging

logger = logging.getLogger(__name__)

# A wrong remap matches almost nothing; a correct one matches nearly every model tensor. The hard
# floor catches total breakage; a soft warn fires below a near-complete load (a partially-random
# model still runs and returns plausible garbage — review S3/H2).
MIN_MATCH_FRACTION = 0.5
WARN_MATCH_FRACTION = 0.9


def _candidates(key: str) -> list[str]:
    """Candidate model keys for one checkpoint key, in priority order. The notebook's three
    transforms (strip ``module.``, ``.base_layer.``→``.``, and ``encoder.`` → the LoRA-wrapped
    ``encoder.base_model.model.``) are applied **cumulatively** so a key needing more than one still
    matches (review H2); shape checking in remap_state_dict keeps the extra candidates safe."""
    cands = [key]

    def _add(new: str) -> None:
        if new not in cands:
            cands.append(new)

    for k in list(cands):
        if k.startswith("module."):
            _add(k[len("module."):])
    for k in list(cands):
        if ".base_layer." in k:
            _add(k.replace(".base_layer.", "."))
    for k in list(cands):
        if k.startswith("encoder.") and not k.startswith("encoder.base_model.model."):
            _add(k.replace("encoder.", "encoder.base_model.model.", 1))
    return cands


def remap_state_dict(ckpt: dict, model_state: dict) -> dict:
    """Map checkpoint keys onto model keys by the notebook's candidates + a shape match.

    ``ckpt`` / ``model_state`` values need only expose ``.shape`` (torch tensors or numpy arrays).
    """
    loaded: dict = {}
    for k, v in ckpt.items():
        for c in _candidates(k):
            if c in model_state and model_state[c].shape == v.shape:
                loaded[c] = v
                break
    return loaded


def load_flash(weights_path: str, num_classes: int = 23, min_match: float = MIN_MATCH_FRACTION):
    """Build GigaTIME-Flash, load ``weights_path`` via the remap + fidelity check. Lazy torch."""
    import torch

    from ._arch import build_flash

    model = build_flash(num_classes=num_classes)
    ckpt = torch.load(weights_path, map_location="cpu")
    if isinstance(ckpt, dict) and "state_dict" in ckpt:
        ckpt = ckpt["state_dict"]
    model_state = model.state_dict()
    loaded = remap_state_dict(ckpt, model_state)
    matched, total = len(loaded), len(model_state)
    logger.info("GigaTIME-Flash load: matched %d/%d tensors (%.1f%%)",
                matched, total, 100.0 * matched / max(total, 1))
    if matched < min_match * total:
        raise RuntimeError(
            f"GigaTIME-Flash load fidelity too low: matched {matched}/{total} tensors "
            f"(<{min_match:.0%}) — the checkpoint key remap is likely wrong; refusing to serve a "
            f"randomly-initialised model."
        )
    if matched < WARN_MATCH_FRACTION * total:
        logger.warning("GigaTIME-Flash load matched only %.1f%% of tensors — verify the checkpoint "
                       "against the reference notebook before trusting the numbers",
                       100.0 * matched / total)
    model.load_state_dict(loaded, strict=False)
    model.eval()
    return model
