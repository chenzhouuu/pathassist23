"""Perceptor inference: a region's pixels → a morphology description.

A stub/real seam exactly like the cellvit service. Without a MedGemma checkpoint the GPU-free
stub returns a deterministic, clearly-marked description (so the whole path is browser-E2E-able
with no GPU); the real **MedGemma** (Google's Gemma-3-based medical VLM) runs behind
``_medgemma_describe`` as a warm singleton. torch/transformers are imported lazily on the real
path only, so the base env / CI stays GPU-free.
"""

import logging

import numpy as np

from .config import get_settings

logger = logging.getLogger(__name__)

# The Perceptor persona: a concise, grounded H&E morphology read. Rides MedGemma's `system`
# role. Deliberately terse — plain prose, no headings, no disclaimer codas — so the copilot
# (Claude) synthesizes clean material instead of relaying a textbook template.
_SYSTEM = (
    "You are a pathology vision assistant that reads H&E morphology. Describe what is visible "
    "in the image — cell morphology, staining, and tissue architecture — in a few sentences of "
    "plain, continuous prose. Do not use headings or bullet lists, and do not append "
    "disclaimers or caveats. If a specific question is asked, answer it directly and briefly."
)

# Warm (model, processor) singleton — loaded once on the real path.
_MODEL: tuple | None = None


def describe_array(
    pixels: np.ndarray,
    magnification: float,
    focus: str | None = None,
    *,
    use_model: bool | None = None,
) -> str:
    """Describe the region ``pixels`` (seen at ``magnification``), optionally directed by ``focus``.

    ``use_model`` overrides the config seam (tests pass it explicitly); None reads the settings.
    """
    if use_model is None:
        use_model = get_settings().use_model
    if use_model:
        return _medgemma_describe(pixels, magnification, focus)
    return _stub_describe(pixels, magnification, focus)


def _stub_describe(pixels: np.ndarray, magnification: float, focus: str | None = None) -> str:
    """A deterministic, clearly-marked placeholder description that echoes mag + focus."""
    arr = np.asarray(pixels)
    mean = float(arr.mean()) if arr.size else 0.0
    density = "densely cellular" if mean < 160 else "sparse, pale"
    focus_note = f" Focus: {focus}." if focus else ""
    return (
        f"[STUB Perceptor @ {magnification:g}x] H&E region appears {density} "
        f"(mean intensity {mean:.0f}); real morphology description pending the MedGemma model."
        f"{focus_note}"
    )


def _load() -> tuple:
    """Load MedGemma once (warm singleton). Lazy torch/transformers import (GPU-only)."""
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    import torch
    from transformers import AutoModelForImageTextToText, AutoProcessor

    ckpt = get_settings().medgemma_ckpt
    model = AutoModelForImageTextToText.from_pretrained(
        ckpt, torch_dtype=torch.bfloat16, device_map="auto"
    )
    processor = AutoProcessor.from_pretrained(ckpt)
    _MODEL = (model, processor)
    return _MODEL


def warm_up() -> None:
    """Preload the model on the worker's main thread (best-effort; never raises)."""
    try:
        _load()
    except Exception:  # noqa: BLE001 — warm-up must never crash worker startup
        logger.warning("MedGemma warm-up failed", exc_info=True)


def _medgemma_describe(pixels: np.ndarray, magnification: float, focus: str | None = None) -> str:
    """Real MedGemma (Gemma-3 multimodal) perception. Not exercised in CI (manual GPU smoke)."""
    import torch
    from PIL import Image

    model, processor = _load()
    image = Image.fromarray(np.asarray(pixels)).convert("RGB")
    # A focus makes the read answer the agent's specific question; without one it's a short
    # general morphology read. Either way, keep it to a few sentences (the _SYSTEM contract).
    if focus:
        prompt = (
            f"This is an H&E region imaged at {magnification:g}x. In a few sentences, "
            f"address: {focus}"
        )
    else:
        prompt = (
            f"This is an H&E region imaged at {magnification:g}x. In a few sentences, describe "
            "the morphology you observe."
        )
    messages = [
        {"role": "system", "content": [{"type": "text", "text": _SYSTEM}]},
        {"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image", "image": image},
        ]},
    ]
    inputs = processor.apply_chat_template(
        messages, add_generation_prompt=True, tokenize=True,
        return_dict=True, return_tensors="pt",
    ).to(model.device, dtype=torch.bfloat16)
    input_len = inputs["input_ids"].shape[-1]
    with torch.inference_mode():
        generation = model.generate(**inputs, max_new_tokens=512, do_sample=False)
    generation = generation[0][input_len:]
    return processor.decode(generation, skip_special_tokens=True).strip()
