"""The map's HTTP surface, with every expensive seam faked."""

import io

import numpy as np
import pytest
from PIL import Image

from biomarker_service.app import create_app
from biomarker_service.artifacts import CORE, art_hash
from biomarker_service.config import get_settings
from biomarker_service.markers import CHANNEL_INDEX, CHANNEL_NAMES
from biomarker_service.slides import SlideHandle

N_CH = len(CHANNEL_NAMES)
NUC = "nuc1"
SEG = "seg0001"


@pytest.fixture(autouse=True)
def _cache_in_tmp(tmp_path, monkeypatch):
    monkeypatch.setenv("BIOMARKER_ARTIFACT_CACHE", str(tmp_path))
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _predict(rgb):
    """Deterministic mIF: DAPI everywhere, CK keyed to the PIXELS.

    Two things this fake has to respect, both of which bit the first draft:
    1. a uniformly-high CK correctly trips the Inc 3a degeneracy guard (a flat population is not a
       positive population), so the field must be genuinely bimodal;
    2. the model is called on 512-px chunks and has no idea where on the slide it is — exactly
       like the real one. So position must arrive through the pixels, not through a closure.
    """
    h, w = rgb.shape[:2]
    mif = np.full((N_CH, h, w), 0.05, dtype=np.float32)
    mif[CHANNEL_INDEX["DAPI"]] = 0.9
    mif[CHANNEL_INDEX["CK"]] = np.where(rgb[..., 0] > 128, 0.92, 0.02).astype(np.float32)
    return mif


def _read_window(x, y, w, h):
    """Left half of the slide is CK-positive tissue; right half is not (encoded in red)."""
    px = np.zeros((h, w, 3), dtype=np.uint8)
    px[..., 0] = np.where(np.arange(x, x + w) < 1024, 255, 0)[None, :]
    px[..., 1:] = 200
    return px


def _app_with_fakes(nuclei=((900, 900),)):
    app = create_app()
    app.config["TILE_PREDICT"] = _predict
    app.config["OPEN_SLIDE"] = lambda **kw: (
        SlideHandle(CORE, CORE, 0.25, "fake"),
        _read_window,
    )
    app.config["TISSUE_TILES"] = lambda **kw: [(0, 0)]

    def factory(slide_ref, token, nuclei_hash):
        def fetch(bbox):
            cents = [[float(cx), float(cy)] for cx, cy in nuclei]
            return (cents, [1] * len(cents),
                    [[[cx - 12, cy - 12], [cx + 12, cy - 12],
                      [cx + 12, cy + 12], [cx - 12, cy + 12]] for cx, cy in nuclei])
        return fetch

    app.config["FETCH_NUCLEI_FACTORY"] = factory
    return app


def _run(client, app, bbox=None):
    r = client.post("/biomarker", json={
        "slide_ref": "item1", "seg_hash": SEG, "nuclei_hash": NUC,
        "bbox": bbox or {"x": 0, "y": 0, "width": CORE, "height": CORE},
    })
    assert r.status_code == 200, r.get_data(as_text=True)
    body = r.get_json()
    app.config["JOBS"].join()
    st = client.get(f"/biomarker/status/{body['job_id']}").get_json()
    assert st["status"] == "ready", st
    return body["art_hash"]


def test_catalog_exposes_presets_and_palette_without_hardcoding_biology_in_the_ui():
    body = create_app().test_client().get("/biomarker/catalog").get_json()
    assert set(body["presets"]) == {"Structural", "Immune", "Functional", "Lineage"}
    assert body["presets"]["Immune"][0]["marker"] in body["markers"]
    assert body["phenotype_colors"]["Tumour"].startswith("#")
    assert "Transgelin" in body["equivalents"]        # near-equivalents are labelled, not renamed


def test_enqueue_requires_a_segmentation():
    app = _app_with_fakes()
    r = app.test_client().post("/biomarker", json={"slide_ref": "item1"})
    assert r.status_code == 400
    assert "seg_hash" in r.get_json()["detail"]


def test_enqueue_is_503_without_weights():
    # No fabricated map when the GPU worker is absent — the same discipline as /phenotype.
    app = create_app()
    r = app.test_client().post("/biomarker",
                               json={"slide_ref": "i", "seg_hash": SEG, "nuclei_hash": NUC})
    assert r.status_code == 503


def test_a_map_needs_the_cells_it_is_a_map_of(monkeypatch):
    """A phenotype is an attribute of a nucleus, so there is nothing to attribute it to until the
    nuclei exist. Refused by name rather than by a generic error or a silent stall (Inc 5, D9)."""
    app = _app_with_fakes()
    r = app.test_client().post("/biomarker", json={"slide_ref": "item1", "seg_hash": SEG})
    assert r.status_code == 400
    assert "nuclei" in r.get_json()["detail"]


def test_the_cells_a_map_was_built_on_are_part_of_its_identity():
    """Different cells give different phenotypes over the same pixels, so two maps built on two
    nuclei artifacts are two artifacts — not one that silently overwrites the other."""
    s = get_settings()
    common = {"seg_hash": SEG, "marker_mpp": s.marker_mpp, "pheno_mpp": s.pheno_mpp,
              "nucleus_radius_um": s.nucleus_radius_um}
    assert art_hash(**common, nuclei_hash="a") != art_hash(**common, nuclei_hash="b")
    # …and one built before the switch still resolves to the hash it was written under, so it
    # keeps rendering rather than turning into a second, empty artifact.
    assert art_hash(**common) != art_hash(**common, nuclei_hash="a")


def test_art_hash_is_the_same_for_two_different_bboxes():
    app = _app_with_fakes()
    client = app.test_client()
    a = _run(client, app, {"x": 0, "y": 0, "width": 512, "height": 512})
    b = _run(client, app, {"x": 600, "y": 600, "width": 512, "height": 512})
    assert a == b                       # D6: bbox is coverage, not identity
    s = get_settings()
    assert a == art_hash(seg_hash=SEG, marker_mpp=s.marker_mpp, pheno_mpp=s.pheno_mpp,
                         nucleus_radius_um=s.nucleus_radius_um, nuclei_hash=NUC)


def test_job_runs_and_meta_reports_coverage_and_layers():
    app = _app_with_fakes()
    client = app.test_client()
    ah = _run(client, app)
    meta = client.get(f"/biomarker/item1/{ah}/meta").get_json()
    assert meta["coverage"]["n_tiles"] == 1
    assert meta["layers"]["markers"]["level_offset"] == 2
    assert meta["summary"]["n_cells"] == 1
    assert meta["slide"]["width"] == CORE


def test_unknown_artifact_meta_is_404():
    app = _app_with_fakes()
    assert app.test_client().get("/biomarker/item1/deadbeef/meta").status_code == 404


def test_marker_tile_composites_the_requested_channels():
    app = _app_with_fakes()
    client = app.test_client()
    ah = _run(client, app)
    r = client.get(f"/biomarker/item1/{ah}/tile/markers/0/0/0.png",
                   query_string={"ch": "CK:00ffff", "lo": "0", "hi": "1", "gamma": "1"})
    assert r.status_code == 200 and r.mimetype == "image/png"
    arr = np.array(Image.open(io.BytesIO(r.data)).convert("RGBA"))
    assert arr.shape == (256, 256, 4)
    assert arr[..., 3].max() > 0                 # CK is visible in the left half
    assert arr[0, 0, 0] == 0 and arr[0, 0, 1] > 100   # painted cyan, not white


def test_marker_tile_rejects_an_unknown_channel():
    app = _app_with_fakes()
    client = app.test_client()
    ah = _run(client, app)
    r = client.get(f"/biomarker/item1/{ah}/tile/markers/0/0/0.png",
                   query_string={"ch": "NOPE:00ffff"})
    assert r.status_code == 400


def test_uncovered_tile_is_a_transparent_png_with_http_200():
    # B2: a 204 would make OSD's <img> loader fire onerror for every uncovered tile, on every pan.
    app = _app_with_fakes()
    client = app.test_client()
    ah = _run(client, app)
    r = client.get(f"/biomarker/item1/{ah}/tile/markers/0/99/99.png",
                   query_string={"ch": "CK:00ffff"})
    assert r.status_code == 200 and r.mimetype == "image/png"
    assert np.array(Image.open(io.BytesIO(r.data)).convert("RGBA"))[..., 3].max() == 0
    assert "max-age" in r.headers["Cache-Control"]


def test_pheno_tile_paints_and_filters_by_lineage():
    app = _app_with_fakes(nuclei=((900, 900),))
    client = app.test_client()
    ah = _run(client, app)
    tx, ty = 900 // 256, 900 // 256
    full = client.get(f"/biomarker/item1/{ah}/tile/pheno/0/{tx}/{ty}.png")
    assert full.status_code == 200
    painted = np.array(Image.open(io.BytesIO(full.data)).convert("RGBA"))
    assert painted[..., 3].max() == 255           # a nucleus is drawn here

    # filtering to a lineage this cell is NOT costs a URL change and blanks the tile
    filtered = client.get(f"/biomarker/item1/{ah}/tile/pheno/0/{tx}/{ty}.png",
                          query_string={"show": "Mast cell"})
    assert np.array(Image.open(io.BytesIO(filtered.data)).convert("RGBA"))[..., 3].max() == 0


def test_unknown_layer_is_400():
    app = _app_with_fakes()
    client = app.test_client()
    ah = _run(client, app)
    assert client.get(f"/biomarker/item1/{ah}/tile/nope/0/0/0.png").status_code == 400


def test_cells_sidecar_returns_probabilities_not_intensities():
    app = _app_with_fakes(nuclei=((900, 900),))
    client = app.test_client()
    ah = _run(client, app)
    body = client.get(f"/biomarker/item1/{ah}/cells/0/0").get_json()
    assert len(body["cells"]) == 1
    cell = body["cells"][0]
    assert cell["phenotype"] == "Tumour"          # CK over the slide threshold ⇒ Tumour
    assert 0.0 <= cell["markers"]["CK"] <= 1.0    # a probability, never a raw intensity
    assert cell["dapi_ok"] is True


def test_cells_for_an_uncomputed_tile_is_empty_not_an_error():
    app = _app_with_fakes()
    client = app.test_client()
    ah = _run(client, app)
    assert client.get(f"/biomarker/item1/{ah}/cells/9/9").get_json()["cells"] == []


def test_unknown_job_is_404():
    assert create_app().test_client().get("/biomarker/status/nope").status_code == 404


# ── delete (Inc 5, Phase 1) ────────────────────────────────────────────────────────

def test_delete_removes_the_artifact_directory(tmp_path):
    from biomarker_service.artifacts import artifact_dir

    app = _app_with_fakes()
    client = app.test_client()
    ah = _run(client, app)
    root = artifact_dir(tmp_path, "item1", ah)
    assert root.is_dir()
    assert client.delete(f"/biomarker/item1/{ah}").status_code == 204
    assert not root.exists()


def test_delete_is_idempotent(tmp_path):
    app = _app_with_fakes()
    client = app.test_client()
    ah = _run(client, app)
    assert client.delete(f"/biomarker/item1/{ah}").status_code == 204
    assert client.delete(f"/biomarker/item1/{ah}").status_code == 204


def test_delete_refuses_a_path_that_would_escape_the_cache_root():
    client = _app_with_fakes().test_client()
    assert client.delete("/biomarker/item1/..").status_code in (400, 404)
