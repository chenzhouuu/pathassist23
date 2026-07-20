"""Plan compilation, validation, and digest (PathAgent v2, increment 4).

The trust seam that TissueLab lacks (`schema: null`, prose I/O, prompt-only ordering):
a plan is rejected *before the human sees it* unless every step names a real tool,
its args satisfy that tool's JSON Schema, and every consumed artifact was produced by
an earlier step or supplied by the scope. `plan_digest` freezes the approved artifact
so increment 5 runs exactly what was approved.
"""

import hashlib
import json

from jsonschema import Draft202012Validator

from .registry import Registry

# Artifacts the scope supplies for free — a slide is always in context; an ROI only
# when the turn was grounded to one.
_BASE_ARTIFACTS = {"slide_ref"}


def _scope_artifacts(scope: dict) -> set[str]:
    arts = set(_BASE_ARTIFACTS)
    if scope.get("roi"):
        arts.add("roi")
    return arts


def validate_plan(plan: dict, registry: Registry) -> list[str]:
    """Return a list of human-readable errors; an empty list means the plan is valid."""
    errors: list[str] = []
    steps = plan.get("steps") or []
    if not steps:
        return ["The plan has no steps."]

    available = _scope_artifacts(plan.get("scope") or {})
    for step in steps:
        n = step.get("n", "?")
        name = step.get("tool", "")
        tool = registry.get(name)
        if tool is None:
            errors.append(f"Step {n}: unknown tool '{name}'.")
            continue

        declared = step.get("category")
        if declared and declared != tool["category"]:
            errors.append(
                f"Step {n}: category '{declared}' does not match tool '{name}' "
                f"(category '{tool['category']}')."
            )

        # Arguments must satisfy the tool's JSON Schema.
        schema = tool["consumes"].get("args")
        if schema is not None:
            for err in sorted(
                Draft202012Validator(schema).iter_errors(step.get("args") or {}),
                key=lambda e: list(e.path),
            ):
                where = ".".join(str(p) for p in err.path) or "args"
                errors.append(f"Step {n} ({name}): {where}: {err.message}")

        # Every consumed artifact must already be available.
        for art in tool["consumes"].get("artifacts", []):
            if art not in available:
                errors.append(
                    f"Step {n} ({name}): needs '{art}', which no earlier step produced "
                    f"and the scope does not supply."
                )
        # Then this step's outputs become available to later steps.
        available.update(tool["produces"].get("artifacts", []))

    return errors


def plan_digest(steps: list[dict], scope: dict, registry_version: str) -> str:
    """A stable 12-hex content hash of (steps, scope, registry version).

    Frozen at approval so a later run executes exactly the approved artifact; a change
    to the ROI, the steps, or the registry yields a different digest.
    """
    canon = json.dumps(
        {"steps": steps, "scope": scope, "registry": registry_version},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canon.encode()).hexdigest()[:12]
