from redis import Redis

from .schemas import JobStatus, StatusResponse


def _key(cache_key: str) -> str:
    return f"pathagent:case:{cache_key}"


class Registry:
    """Stores per-cache-key job status as JSON in Redis."""

    def __init__(self, conn: Redis) -> None:
        self.conn = conn

    def set_status(self, cache_key: str, status: StatusResponse) -> None:
        """Persist the job status for a cache key."""
        self.conn.set(_key(cache_key), status.model_dump_json(by_alias=True))

    def get_status(self, cache_key: str) -> StatusResponse | None:
        """Return the stored job status for a cache key, or None if absent."""
        raw = self.conn.get(_key(cache_key))
        if raw is None:
            return None
        return StatusResponse.model_validate_json(raw)

    def create(self, cache_key: str) -> StatusResponse:
        """Initialize and store a fresh queued status for a cache key."""
        status = StatusResponse(status=JobStatus.queued, stage="queued", progress=0.0)
        self.set_status(cache_key, status)
        return status
