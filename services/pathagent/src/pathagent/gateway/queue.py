from redis import Redis
from rq import Queue

from ..common.schemas import PreprocessRequest
from ..worker.trident_preprocess import run_trident_preprocess

QUEUE_NAME = "pathagent"


class PreprocessQueue:
    """Thin wrapper around an RQ queue for preprocessing jobs."""

    def __init__(self, conn: Redis, is_async: bool = True) -> None:
        self.queue = Queue(QUEUE_NAME, connection=conn, is_async=is_async)

    def enqueue_preprocess(self, cache_key: str, item_id: str, request: PreprocessRequest) -> str:
        """Enqueue a preprocessing job and return its RQ job id."""
        job = self.queue.enqueue(
            run_trident_preprocess, cache_key, item_id, request.model_dump(by_alias=True)
        )
        return job.id
