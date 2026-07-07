from fastapi import Request

from ..common.registry import Registry
from .queue import PreprocessQueue


def get_registry(request: Request) -> Registry:
    return request.app.state.registry


def get_queue(request: Request) -> PreprocessQueue:
    return request.app.state.queue
