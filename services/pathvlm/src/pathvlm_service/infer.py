"""Perceptor inference: a region's pixels → a morphology description.

A stub/real seam exactly like the cellvit service. Without a Patho-R1 checkpoint the GPU-free
stub returns a deterministic, clearly-marked description (so the whole path is browser-E2E-able
with no GPU); the real Patho-R1-7B (Qwen2.5-VL) runs behind ``_patho_r1_describe`` as a warm
singleton. torch/transformers/qwen_vl_utils are imported lazily on the real path only, so the
base env / CI stays GPU-free.
"""

import logging

import numpy as np

from .config import get_settings

logger = logging.getLogger(__name__)

# The Perceptor persona (adapted from PathAgent's patho_r1 system prompt): observe and describe,
# grounded in morphology, but never a definitive diagnosis.
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
        return _patho_r1_describe(pixels, magnification, focus)
    return _stub_describe(pixels, magnification, focus)


def _stub_describe(pixels: np.ndarray, magnification: float, focus: str | None = None) -> str:
    """A deterministic, clearly-marked placeholder description that echoes mag + focus."""
    arr = np.asarray(pixels)
    mean = float(arr.mean()) if arr.size else 0.0
    density = "densely cellular" if mean < 160 else "sparse, pale"
    focus_note = f" Focus: {focus}." if focus else ""
    return (
        f"[STUB Perceptor @ {magnification:g}x] H&E region appears {density} "
        f"(mean intensity {mean:.0f}); real morphology description pending the Patho-R1 model."
        f"{focus_note}"
    )


def _load() -> tuple:
    """Load Patho-R1-7B once (warm singleton). Lazy torch/transformers import (GPU-only)."""
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

    ckpt = get_settings().patho_r1_ckpt
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        ckpt, torch_dtype="auto", device_map="auto"
    )
    processor = AutoProcessor.from_pretrained(ckpt)
    _MODEL = (model, processor)
    return _MODEL


def warm_up() -> None:
    """Preload the model on the worker's main thread (best-effort; never raises)."""
    try:
        _load()
    except Exception:  # noqa: BLE001 — warm-up must never crash worker startup
        logger.warning("Patho-R1 warm-up failed", exc_info=True)


def _patho_r1_describe(pixels: np.ndarray, magnification: float, focus: str | None = None) -> str:
    """Real Patho-R1-7B (Qwen2.5-VL) perception. Not exercised in CI (manual GPU smoke)."""
    import torch
    from PIL import Image
    from qwen_vl_utils import process_vision_info

    model, processor = _load()
    image = Image.fromarray(np.asarray(pixels)).convert("RGB")
    meta = f"[IMAGE META] Magnification: {magnification:g}x"
    body = "Describe the pathological features visible in this image."
    if focus:
        body += f"\nFocus on: {focus}."
    messages = [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": [
            {"type": "image", "image": image},
            {"type": "text", "text": f"{meta}\n\n{body}"},
        ]},
    ]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    image_inputs, _ = process_vision_info(messages)
    inputs = processor(text=[text], images=image_inputs, padding=True, return_tensors="pt")
    inputs = inputs.to(model.device)
    with torch.no_grad():
        generated = model.generate(**inputs, max_new_tokens=512)
    trimmed = [out[len(inp):] for inp, out in zip(inputs.input_ids, generated, strict=True)]
    return processor.batch_decode(
        trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False
    )[0].strip()
