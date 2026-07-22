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

# The Perceptor persona: observe and describe H&E morphology, grounded, but never a definitive
# diagnosis. Rides MedGemma's `system` role.
_SYSTEM = (
    "You are an AI medical assistant specialized in pathology image analysis. Interpret the "
    "image and describe the observed features — cell morphology, staining patterns, tissue "
    "architecture — with possible explanations grounded in established medical knowledge. Never "
    "give a definitive diagnosis or treatment. If a focus is given, concentrate on that aspect."
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
    prompt = (
        f"[Magnification: {magnification:g}x] Describe the pathological features visible in this "
        "H&E image."
    )
    if focus:
        prompt += f" Focus on: {focus}."
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
