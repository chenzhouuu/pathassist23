"""Perceptor magnification contract: map a requested objective power to what large_image is
asked for and the magnification actually delivered.

Girder/large_image serves a level-0 bbox at a target magnification (server-side pyramid
downsample), optionally capped to an output pixel budget. These pure helpers decide (a) the
magnification to request — never above the slide's native power — and (b) the effective
magnification once the output cap bounds a large region, so ``describe_region`` can report the
true magnification the model actually saw.
"""

from dataclasses import dataclass


def effective_magnification(native_mag: float, requested: float | None, default: int) -> int:
    """The objective power to request: ``requested`` (or ``default`` when None), never above native.

    A 20x-scanned slide has no real 40x, so an over-ask is clamped down; the default is clamped too.
    """
    want = default if requested is None else requested
    want = max(1, int(round(want)))
    return int(min(want, round(native_mag)))


@dataclass(frozen=True)
class ReadPlan:
    """How to ask large_image for the region, plus the magnification actually delivered."""

    magnification: int  # the `magnification` query param (already ≤ native)
    out_px: int  # the output cap (longest side): width = height = out_px
    effective_mag: float  # what the returned image really shows, after the out_px cap


def read_plan(native_mag: float, target_mag: int, out_px: int, bbox: dict) -> ReadPlan:
    """Read the region at ``target_mag`` capped to ``out_px``.

    When the bbox is large the output cap binds and the effective magnification falls below
    ``target_mag`` (``native · out_px / longest_side``) — a wide region can only be shown so big.
    """
    longest = max(float(bbox.get("width", 0)), float(bbox.get("height", 0)), 1.0)
    cap_mag = native_mag * out_px / longest  # mag if the output cap is the binding limit
    effective = min(float(target_mag), cap_mag)
    return ReadPlan(magnification=target_mag, out_px=out_px, effective_mag=round(effective, 2))
