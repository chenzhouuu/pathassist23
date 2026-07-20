"""Deterministic Claim builder (PathAgent v2, increment 6a).

A Claim is the durable, verified result of a run:
``{subject, predicate, value, unit, scope, metrics, evidence, method_versions, status}``.

It is built **deterministically** from the run's canonical result — the LLM only ever
*explains* a Claim, it never emits the number. ``evidence`` binds the claim to the
artifacts the run produced (opaque ArtifactRefs = ``{run_id, key}``); ``method_versions``
records the tools + registry version for provenance/audit. Increments 7–8 swap real
tools (CellViT++, Histolytics) behind the run seam without touching this builder.

At the stub rung the only quantitative tool is ``count_within_roi``, so the assertion is
always a count; the predicate/unit generalize when real quantification tools land.
"""


def build_claim(
    *, plan: dict, run_id: int, values: dict, artifacts: dict, registry_version: str
) -> dict:
    """Shape a completed run into a Claim. Pure function — same run → identical claim."""
    return {
        "plan_digest": plan.get("digest"),
        "subject": values.get("cell_class") or "cells",
        "predicate": "count",
        "value": values.get("count"),
        "unit": "cells",
        "scope": plan.get("scope") or {},
        "metrics": dict(values),                     # full canonical result, for rendering
        "evidence": [{"run_id": run_id, "key": key} for key in artifacts],
        "method_versions": {
            "tools": [s.get("tool") for s in (plan.get("steps") or [])],
            "registry_version": registry_version,
        },
        "status": "asserted",                        # stub verification state (no φ in v2)
    }
