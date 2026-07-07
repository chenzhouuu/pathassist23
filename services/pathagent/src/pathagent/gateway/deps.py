from fastapi import Request

from ..common.registry import Registry
from .queue import PreprocessQueue


def get_registry(request: Request) -> Registry:
    """FastAPI dependency: return the app's shared status Registry."""
    return request.app.state.registry


def get_queue(request: Request) -> PreprocessQueue:
    """FastAPI dependency: return the app's shared preprocess queue."""
    return request.app.state.queue
