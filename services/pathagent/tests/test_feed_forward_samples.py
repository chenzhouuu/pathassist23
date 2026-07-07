"""Feed several sample WSI cases through the whole M0 gateway, in-process.

Exercises the enqueue -> status -> ready cycle end to end (with the inline fake
preprocessor) for a small set of representative Girder-style slide items, and
checks the idempotent-reprocess and unsafe-item-id-rejection behaviors along
the way. See also scripts/feed_forward_demo.py for a standalone CLI harness
that prints a human-readable report (inline or against a real RQ worker).
"""

import json

import pytest
from fastapi.testclient import TestClient

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


@pytest.fixture
def client(redis_conn, job_redis, tmp_cache):
    # job_redis makes the inline fake job write status to the SAME fakeredis the app reads.
    from pathagent.gateway.app import create_app
    from pathagent.gateway.auth import require_user
    from pathagent.gateway.queue import PreprocessQueue

    app = create_app(redis_conn=redis_conn, queue=PreprocessQueue(redis_conn, is_async=False))
    app.dependency_overrides[require_user] = lambda: {"_id": "u1"}
    return TestClient(app)


def test_all_samples_reach_ready(client, tmp_cache):
    from pathagent.common.cache_keys import cache_paths

    for sample in SAMPLE_SLIDES:
        item_id = sample["item_id"]
        resp = client.post(f"/api/agent/cases/{item_id}/preprocess", json=_preprocess_body())
        assert resp.status_code == 202, sample["name"]
        cache_key = resp.json()["cacheKey"]

        status_resp = client.get(
            f"/api/agent/cases/{item_id}/status", params={"cacheKey": cache_key}
        )
        assert status_resp.status_code == 200
        body = status_resp.json()
        assert body["status"] == "ready", sample["name"]
        assert body["ready"]["features"] is True, sample["name"]

        manifest_path = cache_paths(cache_key).manifest
        assert manifest_path.exists(), sample["name"]
        manifest = json.loads(manifest_path.read_text())
        assert manifest["itemId"] == item_id
        assert manifest["stub"] is True


def test_reprocess_is_idempotent(client):
    sample = SAMPLE_SLIDES[0]
    item_id = sample["item_id"]

    first = client.post(f"/api/agent/cases/{item_id}/preprocess", json=_preprocess_body())
    assert first.status_code == 202
    assert first.json()["status"] == "queued"

    second = client.post(f"/api/agent/cases/{item_id}/preprocess", json=_preprocess_body())
    assert second.status_code == 202
    assert second.json()["status"] == "ready"
    assert second.json()["jobId"] == "cached"


def test_unsafe_sample_id_rejected(client):
    resp = client.post("/api/agent/cases/bad..id/preprocess", json=_preprocess_body())
    assert resp.status_code == 400
