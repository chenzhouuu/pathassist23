from functools import lru_cache

from redis import Redis

from .config import get_settings


@lru_cache
def get_job_redis() -> Redis:
    """Redis connection used by RQ jobs (built from settings). Tests monkeypatch this."""
    return Redis.from_url(get_settings().redis_url)
