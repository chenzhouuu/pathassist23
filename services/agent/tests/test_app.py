from agent.common.config import get_settings
from agent.gateway.app import create_app
from agent.loop.artifacts import InMemoryArtifactStore
from agent.loop.girder_annotations import GirderAnnotationStore


def test_uses_in_memory_store_without_cellvit(monkeypatch):
    monkeypatch.setenv("AGENT_CELLVIT_SERVICE_URL", "")
    get_settings.cache_clear()
    try:
        app = create_app()
        assert isinstance(app.state.artifacts, InMemoryArtifactStore)
    finally:
        get_settings.cache_clear()


def test_uses_girder_annotation_store_when_cellvit_configured(monkeypatch):
    monkeypatch.setenv("AGENT_CELLVIT_SERVICE_URL", "http://cellvit:8020")
    get_settings.cache_clear()
    try:
        app = create_app()
        assert isinstance(app.state.artifacts, GirderAnnotationStore)
    finally:
        get_settings.cache_clear()
