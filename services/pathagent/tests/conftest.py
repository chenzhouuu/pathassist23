import fakeredis
import pytest


@pytest.fixture
def redis_conn():
    """An isolated in-memory Redis for each test."""
    return fakeredis.FakeStrictRedis(decode_responses=False)


@pytest.fixture
def tmp_cache(monkeypatch, tmp_path):
    """Point the cache dir at a temp path and reset the settings cache."""
    from pathagent.common.config import get_settings

    monkeypatch.setenv("PATHAGENT_CACHE_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


@pytest.fixture
def job_redis(redis_conn, monkeypatch):
    """Make the worker-side get_job_redis() return the test's fakeredis."""
    from pathagent.common import connection

    connection.get_job_redis.cache_clear()
    monkeypatch.setattr(connection, "get_job_redis", lambda: redis_conn)
    return redis_conn
