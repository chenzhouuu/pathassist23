"""The HTTP surface with every expensive seam faked — no GPU, no weights, no slide."""

import numpy as np
import pytest
from flask import Flask

from tissue_service import routes as routes_mod
from tissue_service.artifacts import CORE, TILE, art_hash, artifact_dir
from tissue_service.classes import BCSS
from tissue_service.config import get_settings
from tissue_service.jobs import JobQueue
from tissue_service.pyramid import write_class_tile, write_prob_tile
from tissue_service.routes import register
from tissue_service.slides import SlideHandle

ITEM = "item1"
SEG = "seg1"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("TISSUE_ARTIFACT_CACHE", str(tmp_path))
    get_settings.cache_clear()

    application = Flask(__name__)
    application.config["JOBS"] = JobQueue(name="test-worker")
    application.config["PREDICT"] = lambda rgb: np.zeros((5, 512, 512), np.float32)
    application.config["OPEN_SLIDE"] = lambda **_kw: (
        SlideHandle(4096, 4096, 0.25, "girder"), lambda x, y, w, h: np.zeros((h, w, 3), np.uint8))
    application.config["TISSUE_TILES"] = lambda **_kw: [(0, 0)]
    application.config["CONTOURS"] = lambda **_kw: None
    register(application)
    yield application
    get_settings.cache_clear()


@pytest.fixture
def client(app):
    return app.test_client()


def _artifact(tmp_path, backend=BCSS):
    """A minimal on-disk artifact: meta + one class tile + its probabilities."""
    from tissue_service.artifacts import meta_path, write_json

    ah = art_hash(seg_hash=SEG, backend=backend.name, store_mpp=1.0)
    root = artifact_dir(tmp_path, ITEM, ah)
    idx = np.zeros((TILE, TILE), np.uint8)
    idx[:, :TILE // 2] = 1                     # left half Tumour
    idx[:, TILE // 2:] = 2                     # right half Stroma
    write_class_tile(root, 0, 0, 0, idx, backend)
    planes = {c: np.zeros((TILE, TILE), np.uint8) for c in backend.classes}
    planes["Tumour"][:, :TILE // 2] = 250
    planes["Stroma"][:, TILE // 2:] = 120
    write_prob_tile(root, 0, 0, 0, planes)
    write_json(meta_path(root), {
        "art_hash": ah, "backend": backend.name, "classes": list(backend.classes),
        "store_mpp": 1.0, "tile": TILE, "core": CORE,
        "layers": {"classes": {"level_offset": 2, "levels": 3},
                   "probs": {"level_offset": 2, "levels": 3}},
    })
    return ah, root


def test_catalog_describes_the_backends_without_the_panel_hardcoding_biology(client):
    doc = client.get("/tissue/catalog").get_json()
    assert doc["default_backend"] == BCSS.name
    b = doc["backends"][BCSS.name]
    assert b["classes"] == list(BCSS.classes)
    assert b["colors"]["Tumour"].startswith("#")
    assert "CC-BY-NC" in b["weights_license"]
    assert doc["core"] == CORE


def test_enqueue_requires_a_segmentation_parent(client):
    assert client.post("/tissue", json={"slide_ref": ITEM}).status_code == 400
    r = client.post("/tissue", json={"slide_ref": ITEM, "seg_hash": SEG, "bbox": 5})
    assert r.status_code == 400


def test_enqueue_rejects_an_unknown_backend(client):
    r = client.post("/tissue", json={"slide_ref": ITEM, "seg_hash": SEG, "backend": "nope"})
    assert r.status_code == 400
    assert "unknown backend" in r.get_json()["detail"]


def test_without_weights_the_service_says_503_rather_than_faking_a_map(app):
    app.config["PREDICT"] = None
    r = app.test_client().post("/tissue", json={"slide_ref": ITEM, "seg_hash": SEG})
    assert r.status_code == 503
    assert "GPU worker" in r.get_json()["detail"]


def test_enqueue_returns_a_stable_hash_and_the_scope(client):
    a = client.post("/tissue", json={"slide_ref": ITEM, "seg_hash": SEG}).get_json()
    b = client.post("/tissue", json={
        "slide_ref": ITEM, "seg_hash": SEG,
        "bbox": {"x": 0, "y": 0, "width": 10, "height": 10}}).get_json()
    assert a["art_hash"] == b["art_hash"]        # bbox is coverage, not identity
    assert a["scope"] == "slide"
    assert b["scope"] == "region"
    assert client.get(f"/tissue/status/{a['job_id']}").status_code == 200
    assert client.get("/tissue/status/nope").status_code == 404


def test_meta_is_404_before_anything_is_built(client):
    assert client.get(f"/tissue/{ITEM}/deadbeef/meta").status_code == 404


def test_meta_carries_coverage_and_summary(client, tmp_path):
    ah, _ = _artifact(tmp_path)
    doc = client.get(f"/tissue/{ITEM}/{ah}/meta").get_json()
    assert doc["backend"] == BCSS.name
    assert doc["coverage"]["core"] == CORE
    assert "summary" in doc


def test_class_tile_renders_and_filters(client, tmp_path):
    ah, _ = _artifact(tmp_path)
    r = client.get(f"/tissue/{ITEM}/{ah}/tile/classes/0/0/0.png")
    assert r.status_code == 200
    assert r.mimetype == "image/png"
    assert r.headers["Cache-Control"].startswith("public")
    assert client.get(
        f"/tissue/{ITEM}/{ah}/tile/classes/0/0/0.png?show=Tumour").status_code == 200


def test_a_missing_tile_is_a_transparent_png_never_a_204(client, tmp_path):
    ah, _ = _artifact(tmp_path)
    r = client.get(f"/tissue/{ITEM}/{ah}/tile/classes/0/9/9.png")
    assert r.status_code == 200
    assert r.data.startswith(b"\x89PNG")


def test_a_bad_class_spec_is_a_400_not_a_silent_drop(client, tmp_path):
    ah, _ = _artifact(tmp_path)
    assert client.get(
        f"/tissue/{ITEM}/{ah}/tile/classes/0/0/0.png?show=Tumor").status_code == 400
    assert client.get(
        f"/tissue/{ITEM}/{ah}/tile/probs/0/0/0.png?ch=Tumour:zz").status_code == 400


def test_all_three_render_modes_answer(client, tmp_path):
    ah, _ = _artifact(tmp_path)
    for layer in ("classes", "probs", "outline"):
        r = client.get(f"/tissue/{ITEM}/{ah}/tile/{layer}/0/0/0.png")
        assert r.status_code == 200, layer
        assert r.data.startswith(b"\x89PNG"), layer
    assert client.get(f"/tissue/{ITEM}/{ah}/tile/nope/0/0/0.png").status_code == 400


def test_tiles_render_correctly_under_concurrency(app, tmp_path):
    """The service runs one worker with many threads, so tile renders overlap in one process.

    That is only safe because rendering is a file read plus numpy with no shared mutable state.
    Assert it: the same tile requested from many threads at once must come back byte-identical to
    the same tile requested alone, and a different tile must still be different.
    """
    from concurrent.futures import ThreadPoolExecutor

    ah, _ = _artifact(tmp_path)
    url = f"/tissue/{ITEM}/{ah}/tile/classes/0/0/0.png"
    other = f"/tissue/{ITEM}/{ah}/tile/probs/0/0/0.png"

    with app.test_client() as c:
        alone = c.get(url).data

    def fetch(path):
        with app.test_client() as c:
            r = c.get(path)
            assert r.status_code == 200
            return r.data

    with ThreadPoolExecutor(max_workers=8) as ex:
        same = list(ex.map(fetch, [url] * 16))
        mixed = list(ex.map(fetch, [url, other] * 8))

    assert all(d == alone for d in same), "a concurrent render disagreed with a solo one"
    assert len({d for d in mixed}) == 2, "concurrent renders of different tiles collided"


def test_region_stats_count_only_the_requested_rectangle(client, tmp_path):
    ah, _ = _artifact(tmp_path)
    # level_offset 2 ⇒ 4 level-0 px per stored px; the left half of tile (0,0) is Tumour
    doc = client.get(f"/tissue/{ITEM}/{ah}/stats?bbox=0,0,512,1024").get_json()
    assert doc["scope"] == "region"
    assert doc["pixels"]["Tumour"] > 0
    assert doc["pixels"]["Stroma"] == 0
    assert doc["fraction"]["Tumour"] == pytest.approx(1.0)
    assert doc["area_mm2"] > 0


def test_stats_without_a_bbox_is_the_whole_artifact(client, tmp_path):
    ah, _ = _artifact(tmp_path)
    doc = client.get(f"/tissue/{ITEM}/{ah}/stats").get_json()
    assert doc["scope"] == "artifact"


def test_stats_rejects_a_malformed_bbox(client, tmp_path):
    ah, _ = _artifact(tmp_path)
    assert client.get(f"/tissue/{ITEM}/{ah}/stats?bbox=1,2").status_code == 400


def test_a_whole_slide_job_refuses_when_the_cache_volume_is_nearly_full(client, monkeypatch):
    # a half-written pyramid renders as holes, so this must be caught up front, not mid-job
    monkeypatch.setattr(routes_mod, "_free_gb", lambda _p: 0.4)
    r = client.post("/tissue", json={"slide_ref": ITEM, "seg_hash": SEG})
    assert r.status_code == 507
    assert "0.4 GB free" in r.get_json()["detail"]


def test_a_region_job_is_still_allowed_on_a_nearly_full_volume(client, monkeypatch):
    monkeypatch.setattr(routes_mod, "_free_gb", lambda _p: 0.4)
    r = client.post("/tissue", json={"slide_ref": ITEM, "seg_hash": SEG,
                                     "bbox": {"x": 0, "y": 0, "width": 2048, "height": 2048}})
    assert r.status_code == 200


def test_an_undeterminable_volume_never_blocks_a_job(client, monkeypatch):
    monkeypatch.setattr(routes_mod, "_free_gb", lambda _p: None)
    assert client.post("/tissue", json={"slide_ref": ITEM, "seg_hash": SEG}).status_code == 200


# ── the content address, without enqueuing anything (Inc 6 · 06) ───────────────────

def test_the_hash_route_answers_with_the_address_a_run_would_store_under(client, app):
    """The gateway dispatches onto a Celery queue and never sees the run again, so it has to know
    the address first. It must be the *same* string the enqueue path computes, or the row and the
    bytes end up in different places."""
    addressed = client.post("/tissue/hash", json={"seg_hash": SEG}).get_json()
    assert addressed["kind"] == "tissue"
    assert addressed["backend"] == BCSS.name
    assert addressed["art_hash"] == art_hash(
        seg_hash=SEG, backend=BCSS.name, store_mpp=1.0, overlap=0,
    )

    enqueued = client.post("/tissue", json={"slide_ref": ITEM, "seg_hash": SEG}).get_json()
    app.config["JOBS"].join()
    assert enqueued["art_hash"] == addressed["art_hash"]


def test_the_hash_route_enqueues_nothing(client, app):
    client.post("/tissue/hash", json={"seg_hash": SEG})
    # No job to poll: asking what something would be called must not start it.
    assert client.get("/tissue/status/anything").status_code == 404


def test_the_hash_route_refuses_what_the_enqueue_route_refuses(client):
    assert client.post("/tissue/hash", json={}).status_code == 400
    r = client.post("/tissue/hash", json={"seg_hash": SEG, "backend": "no-such-model"})
    assert r.status_code == 400


# ── stopping a build ───────────────────────────────────────────────────────────────

def test_cancelling_an_unknown_job_is_a_404_not_a_silent_ok(client):
    r = client.post("/tissue/cancel/nope")
    assert r.status_code == 404


def test_cancel_reports_the_job_status_it_actually_left_behind(app, client, tmp_path):
    """A running job stays running until it reaches its own clean boundary — the route says so
    rather than reporting a stop that has not happened yet."""
    import threading

    started, stop_seen = threading.Event(), threading.Event()

    def work(report):
        started.set()
        while not report.stopping():
            stop_seen.wait(0.01)
        return {"stopped": True}

    job_id = app.config["JOBS"].submit(work)
    assert started.wait(5)

    body = client.post(f"/tissue/cancel/{job_id}").get_json()
    assert body["status"] == "running"
    assert body["stage"] == "stopping"

    for _ in range(500):
        st = client.get(f"/tissue/status/{job_id}").get_json()
        if st["status"] == "cancelled":
            break
        threading.Event().wait(0.01)
    assert st["status"] == "cancelled"
    assert st["result"] == {"stopped": True}


# ── delete (Inc 5, Phase 1) ────────────────────────────────────────────────────────

def test_delete_removes_the_artifact_directory(client, tmp_path):
    ah, root = _artifact(tmp_path)
    assert root.is_dir()
    assert client.delete(f"/tissue/{ITEM}/{ah}").status_code == 204
    assert not root.exists()


def test_delete_is_idempotent_so_a_retry_after_a_crash_still_succeeds(client, tmp_path):
    ah, _root = _artifact(tmp_path)
    assert client.delete(f"/tissue/{ITEM}/{ah}").status_code == 204
    assert client.delete(f"/tissue/{ITEM}/{ah}").status_code == 204


def test_delete_refuses_a_path_that_would_escape_the_cache_root(client):
    assert client.delete(f"/tissue/{ITEM}/..").status_code in (400, 404)


def test_delete_leaves_a_sibling_artifact_alone(client, tmp_path):
    from tissue_service.artifacts import artifact_dir as adir

    ah, root = _artifact(tmp_path)
    other = adir(tmp_path, ITEM, "0123456789abcdef")
    other.mkdir(parents=True)
    (other / "meta.json").write_text("{}")
    assert client.delete(f"/tissue/{ITEM}/{ah}").status_code == 204
    assert not root.exists() and other.is_dir()
