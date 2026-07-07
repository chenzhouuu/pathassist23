def test_create_then_get(redis_conn):
    from pathagent.common.registry import Registry
    from pathagent.common.schemas import JobStatus

    reg = Registry(redis_conn)
    assert reg.get_status("k1") is None
    reg.create("k1")
    st = reg.get_status("k1")
    assert st is not None and st.status == JobStatus.queued


def test_set_status_roundtrip(redis_conn):
    from pathagent.common.registry import Registry
    from pathagent.common.schemas import JobStatus, ReadyFlags, StatusResponse

    reg = Registry(redis_conn)
    reg.set_status("k2", StatusResponse(status=JobStatus.ready, stage="done", progress=1.0,
                                        ready=ReadyFlags(features=True)))
    st = reg.get_status("k2")
    assert st.status == JobStatus.ready
    assert st.ready.features is True
