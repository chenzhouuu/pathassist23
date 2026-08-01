"""Turning a service's status payload into the one shape the driver reports.

Pure functions, no I/O, so the interesting cases — a stopped run that still has counts, a service
that reports a fraction with no denominator, a payload whose result is nested — are testable
without a Celery worker or a GPU. This is the split the frontend already uses (`preprocessUtils`,
`taskUtils`): decisions in pure functions, transport in the shell around them.
"""

from dataclasses import dataclass

#: States a service will not move off. Everything else means keep polling.
TERMINAL = frozenset({"ready", "failed", "cancelled"})


@dataclass(frozen=True)
class Status:
    """One reading of a running job, in the vocabulary the Girder job records."""

    state: str
    #: Free-text stage name ("tiles", "nuclei", "encoding"), or None before the job says.
    stage: str | None
    #: Work done and work total, when the service reports them. Both None means it only reported a
    #: fraction, which `percent` then carries instead.
    current: int | None
    total: int | None
    #: 0..100, always present, because a progress bar with no number is worse than a coarse one.
    percent: int
    #: The service's own payload, minus the control fields. Carried through to the artifact row.
    result: dict
    error: str | None

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL


def _int(value) -> int | None:
    """A count, or None. A count that is not a number is not a count."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def _percent(current: int | None, total: int | None, fraction) -> int:
    """The bar's number, preferring real counts over the collapsed fraction.

    Counts win because they survive a service that reports its fraction badly, and because
    `142 / 338` and `42%` disagreeing on screen is worse than either alone.
    """
    if current is not None and total:
        return max(0, min(100, round(100 * current / total)))
    try:
        return max(0, min(100, round(100 * float(fraction))))
    except (TypeError, ValueError):
        return 0


#: Control fields every service sends. What is left is the job's actual output.
_CONTROL = frozenset({
    "job_id", "status", "stage", "progress", "error", "result", "current", "total",
})


def normalise(payload: dict, *, nested_result: bool) -> Status:
    """One service status reply as a `Status`.

    `nested_result` follows the service, not a preference: the JobQueue workers (cellvit, tissue,
    biomarker) put their output under "result", while the preprocess service merges it into the top
    level. See `routing.Route.nested_result`.
    """
    payload = payload or {}
    if nested_result:
        result = dict(payload.get("result") or {})
    else:
        result = {k: v for k, v in payload.items() if k not in _CONTROL}

    # Counts may ride at the top level or inside the result, depending on which service and which
    # stage produced them. Look in both rather than making every service move its fields.
    current = _int(payload.get("current"))
    total = _int(payload.get("total"))
    if current is None:
        current = _int(result.get("current"))
    if total is None:
        total = _int(result.get("total"))

    return Status(
        state=str(payload.get("status") or "queued"),
        stage=payload.get("stage") or None,
        current=current,
        total=total,
        percent=_percent(current, total, payload.get("progress")),
        result=result,
        error=payload.get("error") or None,
    )


def progress_message(status: Status) -> str:
    """What the job's progress line says.

    Names the stage, and the counts when there are counts. Never invents a denominator: a service
    that has not said how many tiles there are gets a stage name and nothing else, because
    `142 / ?` reads as a bug and `142 / 142` would be a lie.
    """
    stage = status.stage or status.state
    if status.current is not None and status.total:
        return f"{status.current} / {status.total} · {stage}"
    if status.current is not None:
        return f"{status.current} · {stage}"
    return stage
