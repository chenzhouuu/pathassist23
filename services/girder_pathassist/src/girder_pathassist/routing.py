"""Which service owns a kind, and where its three routes live.

One table, read by both halves: the REST layer uses it to refuse an unknown kind at submit time,
and the driver uses it to know what to dial. Keeping it here rather than in the driver is what lets
a bad `kind` fail in the browser instead of an hour into a queue.

The URLs are **box-local**. A driver running on box 2 dials box 2's services, which is the whole
of the multi-machine story (Inc 6 · D4): the queue name selects the box, and the box's env selects
the services. Nothing routes across boxes.

The three routes are not uniform, and are not made uniform here. The preprocess service predates
the JobQueue shape the map workers use, so it answers `GET /status?job_id=` with the result merged
into the top level, while the others answer `GET /{kind}/status/{job_id}` with the result nested.
Normalising that is `driver.read_status`'s job; inventing a route a service does not serve would
only move the failure later.
"""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Route:
    """Everything the driver needs to run one kind on this box."""

    #: Env var holding this kind's box-local service base URL.
    env: str
    #: Fallback when the env var is unset — the port the service publishes in compose.
    default: str
    #: Path the submit POST goes to.
    submit: str
    #: `str.format(job_id=...)` template for the status GET.
    status: str
    #: `str.format(job_id=...)` template for the cancel POST, or None where the service has no
    #: cooperative stop yet. `None` is load-bearing: the driver must refuse a cancel it cannot
    #: deliver rather than report a job stopped that is still computing.
    cancel: str | None
    #: True when the status payload nests its result under "result" (the JobQueue shape).
    nested_result: bool


ROUTES: dict[str, Route] = {
    "segmentation": Route(
        env="PATHASSIST_PREPROCESS_URL", default="http://localhost:8030",
        submit="/segment", status="/status?job_id={job_id}", cancel=None, nested_result=False,
    ),
    "patching": Route(
        env="PATHASSIST_PREPROCESS_URL", default="http://localhost:8030",
        submit="/patch", status="/status?job_id={job_id}", cancel=None, nested_result=False,
    ),
    "features": Route(
        env="PATHASSIST_PREPROCESS_URL", default="http://localhost:8030",
        submit="/features", status="/status?job_id={job_id}", cancel=None, nested_result=False,
    ),
    "prediction": Route(
        env="PATHASSIST_PREPROCESS_URL", default="http://localhost:8030",
        submit="/predict", status="/status?job_id={job_id}", cancel=None, nested_result=False,
    ),
    "nuclei": Route(
        env="PATHASSIST_CELLVIT_URL", default="http://localhost:8020",
        submit="/nuclei", status="/nuclei/status/{job_id}",
        cancel="/nuclei/cancel/{job_id}", nested_result=True,
    ),
    "tissue": Route(
        env="PATHASSIST_TISSUE_URL", default="http://localhost:8023",
        submit="/tissue", status="/tissue/status/{job_id}",
        cancel="/tissue/cancel/{job_id}", nested_result=True,
    ),
    "biomarker": Route(
        env="PATHASSIST_BIOMARKER_URL", default="http://localhost:8022",
        submit="/biomarker", status="/biomarker/status/{job_id}",
        cancel=None, nested_result=True,
    ),
}


def route_for(kind: str) -> Route:
    """The route table entry for `kind`.

    Raises:
        KeyError: when the kind is not one this bridge dispatches. Callers turn this into a 400 —
            an unknown kind is a caller mistake, not a service outage.
    """
    return ROUTES[kind]


def base_url(route: Route) -> str:
    """This box's base URL for the service owning `route`, trailing slash stripped."""
    return os.environ.get(route.env, route.default).rstrip("/")
