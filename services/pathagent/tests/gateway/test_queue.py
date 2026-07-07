def test_enqueue_runs_job_inline(redis_conn, monkeypatch):
    from pathagent.common.schemas import FeatureSpec, PreprocessRequest
    from pathagent.gateway.queue import PreprocessQueue
    from pathagent.worker import fake_preprocess

    calls = []
    monkeypatch.setattr(fake_preprocess, "run_fake_preprocess", lambda *a: calls.append(a))

    q = PreprocessQueue(redis_conn, is_async=False)  # is_async=False runs the job inline
    req = PreprocessRequest(backbone=FeatureSpec(patchEncoder="conch_v1"))
    job_id = q.enqueue_preprocess("item1-abc", "item1", req)

    assert isinstance(job_id, str) and job_id
    assert len(calls) == 1
    cache_key, item_id, payload = calls[0]
    assert cache_key == "item1-abc"
    assert item_id == "item1"
    assert payload["backbone"]["patchEncoder"] == "conch_v1"
