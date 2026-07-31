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
