"""Stub tool executor (PathAgent v2, increment 5).

`invoke(tool, args, scope, artifacts)` is the **stateless invocation seam**: run one
tool given its args, the plan scope, and the artifacts produced so far; return the new
artifacts/values. Increments 7–8 replace the canned bodies below (CellViT++, Histolytics)
without touching the signature, the route, or the frontend.

At increment 5 the bodies are deterministic canned output — no GPU, no I/O — so the whole
run/overlay path is exercised on a laptop and in tests.
"""

from dataclasses import dataclass, field


class ExecutionError(RuntimeError):
    """A tool could not run (unknown tool, missing input artifact)."""


@dataclass
class InvocationResult:
    """What a single tool invocation produced."""

    artifacts: dict = field(default_factory=dict)  # artifact-name → artifact payload
    values: dict = field(default_factory=dict)      # scalar outputs (count, density, …)


# Canned segmentation density: how many nuclei the stub scatters across a region,
# as a target used to pick a grid spacing. Real segmentation replaces this at inc 7.
_TARGET_NUCLEI = 160
_DEFAULT_MPP = 0.25  # µm/px at ~40x, used for density when the plan gave no mpp


def _jitter(col: int, row: int, channel: int) -> float:
    """Deterministic pseudo-random in [0, 1) from a grid cell (a spatial hash) — gives the
    canned nuclei a natural scatter that is identical on every run."""
    n = (col * 73856093) ^ (row * 19349663) ^ ((channel + 1) * 83492791)
    return ((n & 0x7FFFFFFF) % 100003) / 100003.0


def _canned_nuclei(roi: dict) -> list[list[float]]:
    """A jittered grid of nucleus centroids (level-0 image px) filling the ROI."""
    x, y = float(roi["x"]), float(roi["y"])
    w, h = float(roi["width"]), float(roi["height"])
    step = max((max(w * h, 1.0) / _TARGET_NUCLEI) ** 0.5, 1.0)
    cols, rows = max(int(w // step), 1), max(int(h // step), 1)
    points: list[list[float]] = []
    for r in range(rows):
        for c in range(cols):
            px = x + (c + 0.5) * step + (_jitter(c, r, 0) - 0.5) * 0.7 * step
            py = y + (r + 0.5) * step + (_jitter(c, r, 1) - 0.5) * 0.7 * step
            points.append([round(min(max(px, x), x + w), 1),
                           round(min(max(py, y), y + h), 1)])
    return points


def _nuclei_segment_stub(args: dict, scope: dict, artifacts: dict) -> InvocationResult:
    """Produce canned per-nucleus centroids over the scope's region (or a default box)."""
    roi = scope.get("roi") or {"x": 0, "y": 0, "width": 1024, "height": 1024}
    points = _canned_nuclei(roi)
    nuclei = {
        "kind": "nuclei",
        "geometry": "points",
        "points": points,
        "count": len(points),
        "mpp": args.get("mpp") or _DEFAULT_MPP,
        "level0": {k: roi[k] for k in ("x", "y", "width", "height")},
    }
    return InvocationResult(artifacts={"nuclei": nuclei})


def _point_in_roi(p: list[float], roi: dict) -> bool:
    return (roi["x"] <= p[0] <= roi["x"] + roi["width"]
            and roi["y"] <= p[1] <= roi["y"] + roi["height"])


def _count_within_roi(args: dict, scope: dict, artifacts: dict) -> InvocationResult:
    """Count the segmented nuclei inside the ROI and compute a density (cells/mm²)."""
    nuclei = artifacts.get("nuclei")
    if not nuclei:
        raise ExecutionError("count_within_roi needs a 'nuclei' artifact from an earlier step")
    roi = scope.get("roi")
    points = nuclei.get("points") or []
    inside = points if roi is None else [p for p in points if _point_in_roi(p, roi)]
    count = len(inside)
    mpp = nuclei.get("mpp") or _DEFAULT_MPP
    density = 0.0
    if roi:
        area_mm2 = (roi["width"] * roi["height"]) * (mpp / 1000.0) ** 2
        if area_mm2 > 0:
            density = round(count / area_mm2, 1)
    return InvocationResult(values={
        "cell_class": args.get("cell_class"),
        "count": count,
        "density": density,
        "density_unit": "cells/mm²",
    })


# The stub tool bodies, keyed by the registry tool name. Increments 7–8 register real
# implementations here (or a network call) behind the same `invoke` contract.
_IMPLS = {
    "nuclei_segment_stub": _nuclei_segment_stub,
    "count_within_roi": _count_within_roi,
}


def invoke(tool: str, args: dict | None, scope: dict | None, artifacts: dict) -> InvocationResult:
    """Run one tool. Raises ExecutionError for an unknown tool or a missing input."""
    fn = _IMPLS.get(tool)
    if fn is None:
        raise ExecutionError(f"no implementation for tool '{tool}'")
    return fn(args or {}, scope or {}, artifacts)


def execute_plan(steps: list[dict], scope: dict | None) -> dict:
    """Run an approved plan's steps in order, threading artifacts between them.

    Returns ``{"artifacts": {...}, "values": {...}, "steps": [{"n", "tool", "produced"}]}``.
    The route drives the steps itself (to stream per-step frames); this is the convenience
    path used by tests.
    """
    artifacts: dict = {}
    values: dict = {}
    per_step: list[dict] = []
    for s in steps:
        res = invoke(s["tool"], s.get("args"), scope, artifacts)
        artifacts.update(res.artifacts)
        values.update(res.values)
        per_step.append({
            "n": s.get("n"), "tool": s["tool"],
            "produced": list(res.artifacts) + list(res.values),
        })
    return {"artifacts": artifacts, "values": values, "steps": per_step}
