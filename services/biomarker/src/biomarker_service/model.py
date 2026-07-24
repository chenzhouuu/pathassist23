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

# A wrong remap matches almost nothing; a correct one matches nearly every model tensor. Well
# below any real load, well above a broken one.
MIN_MATCH_FRACTION = 0.5


def _candidates(key: str) -> list[str]:
    """The notebook's candidate keys for one checkpoint key, in priority order."""
    cands = [key]
    if key.startswith("module."):
        cands.append(key[len("module."):])
    if ".base_layer." in key:
        cands.append(key.replace(".base_layer.", "."))
    if key.startswith("encoder.") and not key.startswith("encoder.base_model.model."):
        cands.append(key.replace("encoder.", "encoder.base_model.model.", 1))
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
    if len(loaded) < min_match * len(model_state):
        raise RuntimeError(
            f"GigaTIME-Flash load fidelity too low: matched {len(loaded)}/{len(model_state)} "
            f"tensors (<{min_match:.0%}) — the checkpoint key remap is likely wrong; refusing to "
            f"serve a randomly-initialised model."
        )
    model.load_state_dict(loaded, strict=False)
    model.eval()
    return model
