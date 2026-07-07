"""FastAPI integration tests for the SSE /query + heatmap endpoints.

Perception and the LLM are monkeypatched to deterministic fakes; the query is
driven through the real compiled graph and its SSE body is buffered by
``TestClient`` and parsed back into events.
"""

import json

import pytest
from fastapi.testclient import TestClient

# A tiny stand-in for the rendered heatmap PNG (FileResponse never parses it).
_PNG_BYTES = b"\x89PNG\r\n\x1a\ndummy-heatmap-bytes"

_ITEM_ID = "item42"
_CACHE_KEY = "item42-deadbeef1234"


def _classifier_json() -> str:
    """Classifier cache exactly as the worker writes it (camelCase, by_alias)."""
    from pathagent.common.schemas import ClassifierResult

    result = ClassifierResult(
        model="brca_abmil",
        prediction="ILC",
        confidence=70.0,
        idc_prob=29.1,
        ilc_prob=70.9,
        num_patches=9,
    )
    return result.model_dump_json(by_alias=True)


@pytest.fixture
def patched(monkeypatch):
    """Patch perception + LLM so /query runs deterministically with no network.

    The patched ``PerceptionRunner.run`` writes the heatmap PNG + meta for the
    task_id it is handed (mirroring the real runner's side effect) and returns a
    canned :class:`NavResult`.
    """
    from pathagent.common.cache_keys import cache_paths
    from pathagent.orchestrator import heatmap
    from pathagent.orchestrator.llm_client import LLMClient
    from pathagent.orchestrator.perception import NavResult, PerceptionRunner

    nav = NavResult(
        regions=[
            {"x": 512, "y": 256, "width": 256, "height": 256, "score": 0.9,
             "rationale": "matches: invasive ductal carcinoma"},
            {"x": 0, "y": 0, "width": 256, "height": 256, "score": 0.6,
             "rationale": "coverage sample"},
        ],
        raster_extent={"x": 0, "y": 0, "width": 4096, "height": 4096},
        grid_shape=[4, 4],
        kb_hits=[{"id": "k1", "text": "IDC infiltrates stroma.", "source": "WHO", "score": 0.8}],
    )

    def fake_run(self, cache_key, question, task_id, roi=None):
        paths = cache_paths(cache_key)
        png = paths.heatmap(task_id)
        png.parent.mkdir(parents=True, exist_ok=True)
        png.write_bytes(_PNG_BYTES)
        heatmap.write_meta(paths.heatmap_meta(task_id), nav.raster_extent)
        return nav

    monkeypatch.setattr(PerceptionRunner, "run", fake_run)
    monkeypatch.setattr(LLMClient, "complete", lambda self, s, u: "Final: lobular carcinoma.")
    monkeypatch.setattr(
        LLMClient,
        "complete_json",
        lambda self, s, u: {"answer": "ILC", "reasoning": "single-file", "phiL": 0.9, "phiK": 0.8},
    )
    return nav


@pytest.fixture
def client(redis_conn, tmp_cache):
    """A TestClient with auth overridden and the cache dir pointed at tmp_cache."""
    from pathagent.gateway.app import create_app
    from pathagent.gateway.auth import require_user
    from pathagent.gateway.queue import PreprocessQueue

    app = create_app(redis_conn=redis_conn, queue=PreprocessQueue(redis_conn, is_async=False))
    app.dependency_overrides[require_user] = lambda: {"_id": "u1"}
    return TestClient(app)


def _write_classifier(tmp_cache) -> None:
    from pathagent.common.cache_keys import cache_paths

    paths = cache_paths(_CACHE_KEY)
    paths.root.mkdir(parents=True, exist_ok=True)
    paths.classifier.write_text(_classifier_json())


def _parse_sse(body: str) -> list[dict]:
    """Parse an SSE response body into its list of JSON ``data:`` events."""
    events: list[dict] = []
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            events.append(json.loads(line[len("data:"):].strip()))
    return events


def test_query_streams_full_reasoning_and_serves_heatmap(client, tmp_cache, patched):
    _write_classifier(tmp_cache)

    resp = client.post(
        "/api/agent/query",
        json={
            "itemId": _ITEM_ID,
            "cacheKey": _CACHE_KEY,
            "question": "subtype?",
            "task": "Diagnosis",
        },
    )
    assert resp.status_code == 200

    events = _parse_sse(resp.text)
    types = [ev["type"] for ev in events]
    assert types[-1] == "final"
    for expected in ("route", "diagnose", "verify"):
        assert expected in types

    final = events[-1]
    task_id = final["heatmapTaskId"]
    assert task_id
    assert final["trail"]  # regions were explored
    assert 0 <= final["confidence"] <= 100

    # The heatmap the run rendered is served with its level-0 extent headers.
    hm = client.get(
        f"/api/agent/cases/{_ITEM_ID}/heatmap/{task_id}", params={"cacheKey": _CACHE_KEY}
    )
    assert hm.status_code == 200
    assert hm.headers["content-type"] == "image/png"
    assert hm.headers["X-Level0-Width"] == "4096"
    assert hm.content == _PNG_BYTES


def test_query_without_classifier_still_streams_final(client, tmp_cache, patched):
    # No classifier.json on disk -> triage degrades to the moderate budget path.
    resp = client.post(
        "/api/agent/query",
        json={"itemId": _ITEM_ID, "cacheKey": _CACHE_KEY, "question": "subtype?"},
    )
    assert resp.status_code == 200
    types = [ev["type"] for ev in _parse_sse(resp.text)]
    assert types[0] == "route"
    assert types[-1] == "final"


def test_query_rejects_unsafe_cache_key(client, tmp_cache, patched):
    resp = client.post(
        "/api/agent/query",
        json={"itemId": _ITEM_ID, "cacheKey": "../evil", "question": "subtype?"},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "invalid cacheKey"


def test_heatmap_missing_task_id_returns_404(client, tmp_cache, patched):
    _write_classifier(tmp_cache)
    resp = client.get(
        f"/api/agent/cases/{_ITEM_ID}/heatmap/does-not-exist",
        params={"cacheKey": _CACHE_KEY},
    )
    assert resp.status_code == 404


def test_heatmap_rejects_unsafe_cache_key(client, tmp_cache, patched):
    resp = client.get(
        f"/api/agent/cases/{_ITEM_ID}/heatmap/anytask", params={"cacheKey": "../x"}
    )
    assert resp.status_code == 400


def test_query_requires_auth(redis_conn, tmp_cache):
    """Without the Girder-Token header the real auth gate rejects the request."""
    from pathagent.gateway.app import create_app
    from pathagent.gateway.queue import PreprocessQueue

    app = create_app(redis_conn=redis_conn, queue=PreprocessQueue(redis_conn, is_async=False))
    unauth = TestClient(app)
    resp = unauth.post(
        "/api/agent/query",
        json={"itemId": _ITEM_ID, "cacheKey": _CACHE_KEY, "question": "?"},
    )
    assert resp.status_code in (401, 422)


def test_cors_exposes_heatmap_extent_headers(client):
    # The M4 OSD overlay reads the level-0 extent from X-Level0-* headers cross-origin;
    # they are only visible to browser JS when CORS explicitly exposes them.
    resp = client.get(
        f"/api/agent/cases/{_ITEM_ID}/heatmap/deadbeef?cacheKey={_CACHE_KEY}",
        headers={"Origin": "http://example.com"},
    )
    exposed = resp.headers.get("access-control-expose-headers", "")
    assert "X-Level0-Width" in exposed
    assert "X-Level0-X" in exposed
