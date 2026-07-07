"""Feed-forward demo for the PathAgent M0 gateway.

Feeds a handful of sample WSI ("whole-slide image") cases through the whole
M0 preprocess -> status -> ready cycle and prints a report of the outcome.

M0 uses a *fake* in-process preprocessor (`pathagent.worker.fake_preprocess`)
that simulates the pipeline stages and writes a stub manifest — no GPU, no
real slide, no Trident/CONCH involved. The real Trident preprocessing worker
(segmentation -> coords -> CONCH patch features) is Plan 2 / M1; this script
will exercise that same code path unchanged once the fake job is swapped out.

Usage:
    uv run python scripts/feed_forward_demo.py                       # inline mode (no Redis needed)
    uv run python scripts/feed_forward_demo.py --redis-url redis://localhost:6379/0
        # worker mode: enqueues onto a real Redis/RQ queue. Requires an external
        # `rq worker pathagent` process running against the SAME redis and the
        # SAME PATHAGENT_CACHE_DIR (export it before starting the worker).
"""

import os
import tempfile

# Must run before importing any pathagent module, so the fake job (and any
# real worker started separately in worker mode) writes manifests somewhere
# writable, and so the settings cache picks it up on first access.
if "PATHAGENT_CACHE_DIR" not in os.environ:
    os.environ["PATHAGENT_CACHE_DIR"] = tempfile.mkdtemp(prefix="pathagent-demo-")

import argparse  # noqa: E402 - see PATHAGENT_CACHE_DIR note above
import time  # noqa: E402
from dataclasses import dataclass  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402
from redis import Redis  # noqa: E402

from pathagent.common import connection  # noqa: E402
from pathagent.common.cache_keys import cache_paths  # noqa: E402
from pathagent.gateway.app import create_app  # noqa: E402
from pathagent.gateway.auth import require_user  # noqa: E402
from pathagent.gateway.queue import PreprocessQueue  # noqa: E402

# Same three sample slides as tests/test_feed_forward_samples.py.
SAMPLE_SLIDES = [
    {"item_id": "5f9a1b2c3d4e5f6a7b8c9d01", "name": "TCGA-BRCA-sample-01.svs"},
    {"item_id": "5f9a1b2c3d4e5f6a7b8c9d02", "name": "TCGA-LUAD-sample-02.svs"},
    {"item_id": "5f9a1b2c3d4e5f6a7b8c9d03", "name": "TCGA-PRAD-sample-03.svs"},
]


def _preprocess_body() -> dict:
    return {
        "backbone": {"patchEncoder": "conch_v1", "mag": 20, "patchSize": 256},
        "slidechat": True,
    }


@dataclass
class SampleResult:
    name: str
    item_id: str
    cache_key: str
    status: str
    elapsed: float
    ready: dict
    manifest_exists: bool


def _build_client(redis_url: str | None) -> TestClient:
    """Build a TestClient wired to either a fake in-memory queue or a real RQ one."""
    if redis_url:
        conn = Redis.from_url(redis_url)
        queue = PreprocessQueue(conn, is_async=True)
    else:
        import fakeredis

        conn = fakeredis.FakeStrictRedis()
        queue = PreprocessQueue(conn, is_async=False)
        # Inline mode runs the fake job in-process (is_async=False), and the job
        # body calls get_job_redis() itself to reach the status registry. Point
        # it at this same fake connection so it doesn't try to dial a real Redis.
        connection.get_job_redis.cache_clear()
        connection.get_job_redis = lambda: conn

    app = create_app(redis_conn=conn, queue=queue)
    app.dependency_overrides[require_user] = lambda: {"_id": "demo-user"}
    return TestClient(app)


def _run_sample(client: TestClient, sample: dict, timeout: float, poll: float) -> SampleResult:
    """POST preprocess for one sample, then poll status until ready/error/timeout."""
    item_id = sample["item_id"]
    name = sample["name"]
    start = time.monotonic()

    resp = client.post(f"/api/agent/cases/{item_id}/preprocess", json=_preprocess_body())
    resp.raise_for_status()
    body = resp.json()
    cache_key = body["cacheKey"]
    status = body["status"]
    ready = {"features": False, "slidechat": False, "classifiers": False}

    while status not in ("ready", "error"):
        if time.monotonic() - start > timeout:
            status = "timeout"
            break
        time.sleep(poll)
        status_resp = client.get(
            f"/api/agent/cases/{item_id}/status", params={"cacheKey": cache_key}
        )
        status_resp.raise_for_status()
        body = status_resp.json()
        status = body["status"]
        ready = body["ready"]

    elapsed = time.monotonic() - start
    manifest_exists = cache_paths(cache_key).manifest.exists()
    return SampleResult(name, item_id, cache_key, status, elapsed, ready, manifest_exists)


def _print_report(results: list[SampleResult], mode: str, cache_dir: str) -> None:
    print(f"PathAgent feed-forward sample demo (mode={mode})")
    print(f"cache dir: {cache_dir}")
    print("-" * 100)

    name_width = max(len(r.name) for r in results)
    for r in results:
        mark = "✓" if r.status == "ready" else "✗"
        ready_str = (
            f"features={r.ready.get('features')} "
            f"slidechat={r.ready.get('slidechat')} "
            f"classifiers={r.ready.get('classifiers')}"
        )
        print(
            f"{mark} {r.name:<{name_width}}  status={r.status:<8} "
            f"elapsed={r.elapsed:>6.2f}s  manifest={'yes' if r.manifest_exists else 'no':<3}  "
            f"{ready_str}  cacheKey={r.cache_key}"
        )

    print("-" * 100)
    ready_count = sum(1 for r in results if r.status == "ready")
    print(f"{ready_count}/{len(results)} samples reached ready")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Feed sample WSI cases through the PathAgent M0 gateway "
            "(fake preprocessor) and report the outcome."
        )
    )
    parser.add_argument(
        "--redis-url",
        default=None,
        help=(
            "Redis URL for worker mode (e.g. redis://localhost:6379/0). Requires an "
            "external `rq worker pathagent` running against the same redis and the "
            "same PATHAGENT_CACHE_DIR. Omit for inline mode (no external worker needed)."
        ),
    )
    parser.add_argument(
        "--timeout", type=float, default=60.0, help="Seconds to wait per sample (default: 60)."
    )
    parser.add_argument(
        "--poll", type=float, default=0.5, help="Seconds between status polls (default: 0.5)."
    )
    args = parser.parse_args()

    mode = "worker" if args.redis_url else "inline"
    client = _build_client(args.redis_url)

    results = [_run_sample(client, sample, args.timeout, args.poll) for sample in SAMPLE_SLIDES]
    _print_report(results, mode, os.environ["PATHAGENT_CACHE_DIR"])

    return 0 if all(r.status == "ready" for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
