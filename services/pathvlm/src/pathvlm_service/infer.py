"""Perceptor inference: a region's pixels → a morphology description.

A stub/real seam exactly like the cellvit service. Without a MedGemma checkpoint the GPU-free
stub returns a deterministic, clearly-marked description (so the whole path is browser-E2E-able
with no GPU); the real **MedGemma** (Google's Gemma-3-based medical VLM) runs behind
``_medgemma_describe`` as a warm singleton. torch/transformers are imported lazily on the real
path only, so the base env / CI stays GPU-free.
"""

import logging
import threading
import time

import numpy as np

from .config import get_settings

logger = logging.getLogger(__name__)

# The Perceptor persona: a concise, grounded H&E morphology read. Rides MedGemma's `system`
# role. Deliberately terse — plain prose, no headings, no disclaimer codas — so the copilot
# (Claude) synthesizes clean material instead of relaying a textbook template.
_SYSTEM = (
    "You are a pathology vision assistant that reads H&E morphology. Describe what is visible "
    "in the image — cell morphology, staining, and tissue architecture — in a few sentences of "
    "plain, continuous prose (no headings or bullet lists). Report what is actually present: if "
    "the tissue looks unremarkable, benign, or normal, say so plainly, and do not assume disease "
    "is present or state a diagnosis the image does not support. If a specific question is asked, "
    "answer it directly and briefly — including a negative answer when that is what you see."
)

# (model, processor) singleton — loaded on the real path and dropped once the Perceptor goes
# quiet. MedGemma shares one card with cellvit, tissue and biomarker, so holding ~9 GB of weights
# through an hour of nobody asking for a description is what makes an unrelated build fall back to
# CPU. `_LOCK` matters because gunicorn serves this app with threads: a release must not race a
# load, and two concurrent describes must wait for one load rather than start two.
_MODEL: tuple | None = None
_LOCK = threading.Lock()
_LAST_USE: float = 0.0


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
    """Load MedGemma if it is not resident, and stamp the use. Lazy torch import (GPU-only)."""
    global _MODEL, _LAST_USE
    with _LOCK:
        _LAST_USE = time.monotonic()
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
        logger.info("MedGemma loaded")
        return _MODEL


def release_if_idle() -> bool:
    """Drop the weights when nothing has asked for a description within ``idle_ttl``.

    Returns whether a release happened. An in-flight ``_medgemma_describe`` is unaffected: it
    holds its own reference to the model, so clearing the singleton only stops the *next* call
    from reusing it. An ``idle_ttl`` of 0 disables the policy.
    """
    global _MODEL
    ttl = get_settings().idle_ttl
    if ttl <= 0:
        return False
    with _LOCK:
        if _MODEL is None or time.monotonic() - _LAST_USE < ttl:
            return False
        _MODEL = None
    try:
        import torch

        torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001 — reclaiming is best-effort; the refs are already dropped
        logger.debug("empty_cache after unload failed", exc_info=True)
    logger.info("MedGemma released after %.0fs idle", ttl)
    return True


def start_idle_reaper(interval: float = 60.0) -> None:
    """Run ``release_if_idle`` on a daemon thread; no-op when the policy is off.

    A reaper rather than a check on the request path, because the moment worth releasing at is
    precisely the one where no request is arriving to trigger the check.
    """
    if get_settings().idle_ttl <= 0:
        return

    def loop() -> None:
        while True:
            time.sleep(interval)
            try:
                release_if_idle()
            except Exception:  # noqa: BLE001 — the reaper must outlive any one failure
                logger.warning("MedGemma idle release failed", exc_info=True)

    threading.Thread(target=loop, name="pathvlm-idle-reaper", daemon=True).start()


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
    # Re-stamp after generating, not just before: a long generate must not let the idle window
    # expire underneath a request that is still being served.
    global _LAST_USE
    with _LOCK:
        _LAST_USE = time.monotonic()
    return processor.decode(generation, skip_special_tokens=True).strip()
