"""GPU cache hygiene (the idle-worker VRAM squat).

The CPU image has no torch and CI has no GPU, so the CUDA branch is exercised against a fake torch
module injected into ``sys.modules`` — that keeps the ordering contract (collect *then* empty_cache)
under test everywhere instead of only on the GPU box.
"""

import sys
import types

import pytest

from preprocess_service import gpu
from preprocess_service.stages import run_features, run_patching, run_segmentation

# ── a fake torch, so the CUDA branch is testable without a GPU ──────────────────────


def _fake_torch(*, available=True, reserved=(8 << 30, 1 << 30), on_empty=None):
    calls: list[str] = []

    def empty_cache():
        calls.append("empty_cache")
        if on_empty is not None:
            on_empty()

    sizes = iter(reserved)
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(
        is_available=lambda: available,
        memory_reserved=lambda: next(sizes),
        empty_cache=empty_cache,
    )
    return torch, calls


@pytest.fixture
def fake_torch(monkeypatch):
    """Install a fake torch and record the order of gc/empty_cache calls."""

    def install(**kw):
        torch, calls = _fake_torch(**kw)
        monkeypatch.setitem(sys.modules, "torch", torch)
        monkeypatch.setattr(gpu.gc, "collect", lambda: calls.append("gc") or 0)
        return calls

    return install


# ── release_cuda_cache ──────────────────────────────────────────────────────────────


def test_release_returns_none_without_torch(monkeypatch):
    """The CPU image has no torch at all — releasing must be a silent no-op, not an ImportError."""
    monkeypatch.setitem(sys.modules, "torch", None)  # `import torch` raises ImportError on None
    assert gpu.release_cuda_cache() is None


def test_release_returns_none_without_cuda(fake_torch):
    calls = fake_torch(available=False)
    assert gpu.release_cuda_cache() is None
    assert calls == []


def test_release_collects_before_emptying(fake_torch):
    """gc must run first: a module stuck in a reference cycle still owns its CUDA blocks, and
    empty_cache() cannot reclaim what is still referenced."""
    calls = fake_torch()
    gpu.release_cuda_cache()
    assert calls == ["gc", "empty_cache"]


def test_release_reports_bytes_still_reserved(fake_torch):
    fake_torch(reserved=(8 << 30, 1 << 30))
    assert gpu.release_cuda_cache() == 1 << 30


def test_release_swallows_torch_failures(fake_torch):
    """Runs in a finally — a CUDA context already wedged by an OOM must not mask the real error."""
    def boom():
        raise RuntimeError("CUDA error: an illegal memory access was encountered")

    fake_torch(on_empty=boom)
    assert gpu.release_cuda_cache() is None


# ── the context manager ─────────────────────────────────────────────────────────────


def test_context_releases_on_success(monkeypatch):
    seen = []
    monkeypatch.setattr(gpu, "release_cuda_cache", lambda: seen.append(1))
    with gpu.cuda_cache_released():
        assert seen == []
    assert seen == [1]


def test_context_releases_on_failure_and_reraises(monkeypatch):
    """The OOM path is the one that matters: the *next* attempt needs the room back."""
    seen = []
    monkeypatch.setattr(gpu, "release_cuda_cache", lambda: seen.append(1))
    with pytest.raises(RuntimeError, match="CUDA out of memory"), gpu.cuda_cache_released():
        raise RuntimeError("CUDA out of memory")
    assert seen == [1]


# ── the stage entry points are wired to it ──────────────────────────────────────────


@pytest.mark.parametrize("stage", ["segmentation", "patching", "features"])
def test_trident_stages_release_even_when_they_fail(monkeypatch, tmp_path, stage):
    """Every real stage returns its allocator pool, including on the failure path."""
    seen = []
    monkeypatch.setattr(gpu, "release_cuda_cache", lambda: seen.append(stage))

    def boom(*a, **kw):
        raise RuntimeError("CUDA out of memory")

    runners = {
        "segmentation": (
            "_trident_segment",
            lambda: run_segmentation(tmp_path / "s.svs", {}, {}, use_trident=True),
        ),
        "patching": (
            "_trident_patch",
            lambda: run_patching(tmp_path / "s.svs", {}, {}, {}, use_trident=True),
        ),
        "features": (
            "_trident_features",
            lambda: run_features(tmp_path / "s.svs", {}, {}, {}, use_trident=True),
        ),
    }
    target, call = runners[stage]
    monkeypatch.setattr("preprocess_service.stages." + target, boom)

    with pytest.raises(RuntimeError, match="CUDA out of memory"):
        call()
    assert seen == [stage]


def test_stub_stages_never_touch_the_gpu(monkeypatch, tmp_path):
    """The GPU-free chain must not call into torch at all — CI has no CUDA to release."""
    monkeypatch.setattr(
        gpu, "release_cuda_cache", lambda: pytest.fail("stub stage tried to release CUDA"),
    )
    seg = {"dir": tmp_path / "seg", "contours": tmp_path / "seg" / "contours.geojson"}
    seg["dir"].mkdir()
    run_segmentation(tmp_path / "s.svs", {"segmenter": "hest"}, seg)
