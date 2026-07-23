import time

import pytest

from preprocess_service.app import create_app
from preprocess_service.config import get_settings


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A test client whose artifact cache is a tmp dir and whose resolver is a no-op stub."""
    monkeypatch.setenv("PREPROCESS_ARTIFACT_CACHE", str(tmp_path / "cache"))
    get_settings.cache_clear()
    app = create_app()
    app.config["RESOLVE"] = lambda item, dest, settings, token: tmp_path / "fake.svs"
    yield app.test_client()
    get_settings.cache_clear()


@pytest.fixture
def wait():
    """A poller: wait_status(client, job_id, want) until the job reaches `want`."""
    def _wait(client, job_id, want, timeout=4.0):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            last = client.get(f"/status?job_id={job_id}").get_json()
            if last.get("status") == want:
                return last
            time.sleep(0.02)
        return last
    return _wait
