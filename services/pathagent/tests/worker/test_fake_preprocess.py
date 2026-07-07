import json


def test_fake_preprocess_sets_ready_and_writes_manifest(job_redis, tmp_cache):
    from pathagent.common.cache_keys import cache_paths
    from pathagent.common.registry import Registry
    from pathagent.common.schemas import JobStatus
    from pathagent.worker.fake_preprocess import run_fake_preprocess

    payload = {"backbone": {"patchEncoder": "conch_v1", "mag": 20, "patchSize": 256}, "slidechat": True}
    run_fake_preprocess("item9-abc", "item9", payload)

    st = Registry(job_redis).get_status("item9-abc")
    assert st.status == JobStatus.ready
    assert st.ready.features is True

    manifest = cache_paths("item9-abc").manifest
    assert manifest.exists()
    assert json.loads(manifest.read_text())["itemId"] == "item9"


def test_fake_preprocess_records_error(job_redis, tmp_cache, monkeypatch):
    from pathagent.common.registry import Registry
    from pathagent.common.schemas import JobStatus
    from pathagent.worker import fake_preprocess

    # Force the manifest write to blow up.
    def boom(*_a, **_k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(fake_preprocess, "_write_stub_manifest", boom)
    try:
        fake_preprocess.run_fake_preprocess("item9-err", "item9", {})
    except RuntimeError:
        pass
    st = Registry(job_redis).get_status("item9-err")
    assert st.status == JobStatus.error
    assert "disk full" in (st.error or "")
