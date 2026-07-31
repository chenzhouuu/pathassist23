"""GPU memory hygiene for the Trident stages.

A stage builds a segmentation model or a patch encoder, runs one slide and drops it — but PyTorch's
caching allocator keeps every freed block in its own pool, so an *idle* worker still reads as
several GiB in ``nvidia-smi``. This A6000 is shared with CellViT, MedGemma and three unrelated
services, so that squatted pool is the difference between the next stage running and a CUDA OOM.

Each real stage therefore hands its cache back when it finishes — or fails. The stub chain never
touches a GPU (and the CPU image has no torch at all), so everything here degrades to a no-op.
"""

import gc
import logging
from collections.abc import Iterator
from contextlib import contextmanager

logger = logging.getLogger(__name__)

_GIB = float(1 << 30)


def release_cuda_cache() -> int | None:
    """Return PyTorch's freed-but-pooled CUDA blocks to the driver.

    Returns the bytes still reserved afterwards, or ``None`` when there is nothing to release (no
    torch in this image, or no CUDA device).

    Never raises: this runs in a ``finally``, so a failure to reclaim memory must not be able to
    change the outcome of the stage that just ran.
    """
    try:
        import torch
    except ImportError:
        return None                     # CPU image — the stub chain never allocated on a GPU
    try:
        if not torch.cuda.is_available():
            return None
        before = torch.cuda.memory_reserved()
        # gc first: an nn.Module that landed in a reference cycle is unreachable but not yet
        # collected, and empty_cache() cannot reclaim blocks its tensors still own.
        gc.collect()
        torch.cuda.empty_cache()
        after = torch.cuda.memory_reserved()
        logger.info(
            "released cuda cache: reserved %.2f → %.2f GiB", before / _GIB, after / _GIB,
        )
        return int(after)
    except Exception:  # noqa: BLE001 — see docstring: reclaiming memory must never fail a stage
        logger.warning("could not release the cuda cache", exc_info=True)
        return None


@contextmanager
def cuda_cache_released() -> Iterator[None]:
    """Run a GPU stage, then hand its allocator pool back — on the failure path too.

    The failure path is the one that matters most: a stage that died half-way through still holds
    everything it had allocated, and the *next* attempt is the one that needs the room.
    """
    try:
        yield
    finally:
        release_cuda_cache()
