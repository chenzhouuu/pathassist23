# tests/test_end_to_end.py
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def _fake_normalize(job_dir, slide_stem, item_id, cache_key, spec, overlap, paths):
    """Stand-in for the real Trident normalizer: write a real manifest, no GPU/subprocess."""
    from pathagent.common.cache_keys import PIPELINE_VERSION
    from pathagent.common.schemas import Manifest

    manifest = Manifest(
        cache_key=cache_key, item_id=item_id, slide_name=slide_stem, backbone=spec,
        patch_count=7, feature_dim=512, level0_width=83664, level0_height=64892,
        level0_magnification=40.0, target_magnification=20.0, patch_size_level0=512,
        overlap=overlap, pipeline_version=PIPELINE_VERSION,
        artifacts={"features": paths.features(spec.patch_encoder).name},
    )
    paths.root.mkdir(parents=True, exist_ok=True)
    paths.manifest.write_text(manifest.model_dump_json(by_alias=True, indent=2))
    return manifest


@pytest.fixture
def client(redis_conn, job_redis, tmp_cache, monkeypatch):
    # job_redis makes the inline job write status to the SAME fakeredis the app reads.
    from pathagent.gateway.app import create_app
    from pathagent.gateway.auth import require_user
    from pathagent.gateway.queue import PreprocessQueue
    from pathagent.worker import trident_preprocess

    # The queue now runs the real Trident worker; mock its collaborators (no GPU/subprocess).
    monkeypatch.setattr(
        trident_preprocess, "resolve_slide",
        lambda item_id, dest, settings, **k: Path(f"/slides/{item_id}.svs"),
    )
    monkeypatch.setattr(trident_preprocess, "run_trident", lambda *a, **k: None)
    monkeypatch.setattr(trident_preprocess, "normalize_and_manifest", _fake_normalize)

    app = create_app(redis_conn=redis_conn, queue=PreprocessQueue(redis_conn, is_async=False))
    app.dependency_overrides[require_user] = lambda: {"_id": "u1"}
    return TestClient(app)


def test_preprocess_to_ready(client, tmp_cache):
    from pathagent.common.cache_keys import cache_paths

    body = {
        "backbone": {"patchEncoder": "conch_v1", "mag": 20, "patchSize": 256},
        "slidechat": True,
    }
    resp = client.post("/api/agent/cases/item77/preprocess", json=body)
    cache_key = resp.json()["cacheKey"]

    # is_async=False ran the job inline during enqueue, so status is already ready.
    st = client.get("/api/agent/cases/item77/status", params={"cacheKey": cache_key})
    assert st.json()["status"] == "ready"
    assert st.json()["ready"]["features"] is True
    assert cache_paths(cache_key).manifest.exists()
