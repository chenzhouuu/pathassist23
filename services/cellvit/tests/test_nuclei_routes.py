"""The nuclei artifact (Inc 5, ticket 05).

What is worth asserting is the thing the ticket exists for: the ring CellViT computes is stored,
comes back, and reproduces the same count and class histogram it went in with. Everything else —
counts, coverage, the summary — is derived from that.
"""

import time

import numpy as np
import pytest
from support import segmented

from cellvit_service.app import create_app
from cellvit_service.artifacts import (
    CORE,
    Coverage,
    art_hash,
    artifact_dir,
    cells_path,
    labels_path,
    read_cells,
    read_labels,
    write_cells,
    write_labels,
)
from cellvit_service.region import RegionImage


@pytest.fixture(autouse=True)
def cache_root(tmp_path, monkeypatch):
    monkeypatch.setenv("CELLVIT_ARTIFACT_CACHE", str(tmp_path))
    from cellvit_service.config import get_settings
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


def _nucleus(cx, cy, r=4.0):
    """A little diamond around (cx, cy) — enough of a ring to round-trip."""
    return [[cx - r, cy], [cx, cy - r], [cx + r, cy], [cx, cy + r]]


def _app_with_fakes(per_tile=None):
    """A service whose model returns two nuclei per read window, placed in that window."""
    app = create_app()

    def slide_info(*, girder_base, slide_ref, token, client=None):
        return 4096, 4096, 0.25

    def read_region(*, girder_base, slide_ref, bbox, token, client=None):
        px = np.zeros((int(bbox["height"]), int(bbox["width"]), 3), dtype=np.uint8)
        # The seam the model reads through hands back region-local pixels; remember the origin so
        # the fake model can place its nuclei somewhere meaningful.
        app.config["_LAST_WINDOW"] = bbox
        return RegionImage(pixels=px, mpp=0.25, scale=1.0)

    def segment(pixels, mpp):
        win = app.config["_LAST_WINDOW"]
        if per_tile is not None:
            return per_tile(win)
        # Two nuclei near the middle of the window, in region-local coordinates.
        h, w = pixels.shape[:2]
        pts = [[w / 2, h / 2], [w / 2 + 20, h / 2 + 20]]
        return segmented(pts, [1, 3], [_nucleus(*p) for p in pts])

    app.config["SLIDE_INFO"] = slide_info
    app.config["READ_REGION"] = read_region
    app.config["SEGMENT"] = segment
    return app


def _run(client, bbox=None):
    r = client.post("/nuclei", json={
        "slide_ref": "item1", "bbox": bbox or {"x": 0, "y": 0, "width": 512, "height": 512},
    })
    assert r.status_code == 200, r.get_data(as_text=True)
    body = r.get_json()
    for _ in range(200):
        st = client.get(f"/nuclei/status/{body['job_id']}").get_json()
        if st["status"] in ("ready", "failed", "cancelled"):
            assert st["status"] == "ready", st.get("error")
            return body["art_hash"], st
        time.sleep(0.02)
    raise AssertionError("job never finished")


# ── the vector round trip ──────────────────────────────────────────────────────────


def test_rings_survive_storage(tmp_path):
    xy = np.array([[100.5, 200.25], [1000.0, 1500.0]], dtype=np.float32)
    rings = [_nucleus(100.5, 200.25), _nucleus(1000.0, 1500.0, r=7.0)]
    write_cells(
        tmp_path / "cells" / "0_0.npz",
        xy=xy, rings=rings, inst=np.array([1, 2], dtype=np.uint32), origin=(0, 0),
    )
    back = read_cells(tmp_path / "cells" / "0_0.npz")

    assert len(back["rings"]) == 2
    assert back["inst"].tolist() == [1, 2]
    # Rings are stored relative to the tile origin as int16, so they come back rounded to the
    # pixel — which is the resolution a polygon on a slide is meaningful at.
    for got, want in zip(back["rings"], rings, strict=True):
        assert np.allclose(np.array(got), np.rint(np.array(want)), atol=0.5)


def test_a_naming_round_trips_beside_the_outlines_it_names(tmp_path):
    """Since Inc 7 the class is not in the cells file: it is a sidecar, row-aligned with it."""
    write_labels(
        labels_path(tmp_path, "nucls_super", 0, 0),
        cls=np.array([1, 3], dtype=np.uint8), prob=np.array([0.91, 0.42], dtype=np.float16),
    )
    back = read_labels(labels_path(tmp_path, "nucls_super", 0, 0))
    assert back["cls"].tolist() == [1, 3]
    assert back["prob"].tolist() == pytest.approx([0.91, 0.42], abs=1e-3)
    # A taxonomy that has not run leaves nothing behind rather than a file of zeros, which would
    # be a naming that calls every nucleus background.
    assert read_labels(labels_path(tmp_path, "midog", 0, 0)) is None


def test_ring_coordinates_are_relative_to_the_tile_origin(tmp_path):
    """The whole reason int16 is enough: a far-away tile's points still land near zero."""
    path = tmp_path / "cells" / "9_9.npz"
    write_cells(
        path,
        xy=np.array([[9 * CORE + 10.0, 9 * CORE + 10.0]], dtype=np.float32),
        rings=[_nucleus(9 * CORE + 10.0, 9 * CORE + 10.0)],
        inst=np.array([1], dtype=np.uint32),
        origin=(9 * CORE, 9 * CORE),
    )
    with np.load(path) as z:
        assert np.abs(z["ring_xy"]).max() < 100      # stored relative
        assert z["ring_xy"].dtype == np.int16
    # …and absolute again on the way out.
    assert read_cells(path)["rings"][0][0][0] > 9 * CORE


# ── the job ────────────────────────────────────────────────────────────────────────


def test_a_region_run_stores_rings_and_reports_counts(cache_root):
    app = _app_with_fakes()
    client = app.test_client()
    ah, st = _run(client)

    root = artifact_dir(cache_root, "item1", ah)
    assert cells_path(root, 0, 0).is_file()
    assert st["result"]["n_nuclei"] == 2
    assert st["result"]["counts_by_class"] == {"Neoplastic": 1, "Connective": 1}

    stored = read_cells(cells_path(root, 0, 0))
    assert len(stored["rings"]) == 2 == len(stored["xy"])


def test_meta_reports_the_slide_and_the_store_resolution(cache_root):
    client = _app_with_fakes().test_client()
    ah, _ = _run(client)

    meta = client.get(f"/nuclei/item1/{ah}/meta").get_json()
    assert meta["slide"] == {"width": 4096, "height": 4096, "mpp": 0.25}
    assert meta["store_mpp"] == 0.25
    assert meta["level_offset"] == 0          # a 0.25 µm/px slide stored at 0.25 µm/px
    assert meta["summary"]["n_nuclei"] == 2
    assert meta["coverage"]["n_tiles"] == 1


def test_a_nucleus_belongs_to_the_core_its_centroid_falls_in(cache_root):
    """The halo makes a straddling nucleus whole; the centroid decides which tile stores it."""
    def straddling(win):
        # One nucleus just left of the x=CORE seam, one just right of it — both visible from the
        # left tile's haloed window, only one of them owned by it.
        pts = [[CORE - 5 - win["x"], 50 - win["y"]], [CORE + 5 - win["x"], 50 - win["y"]]]
        return segmented(pts, [1, 1], [_nucleus(*p) for p in pts])

    app = _app_with_fakes(per_tile=straddling)
    client = app.test_client()
    ah, st = _run(client, bbox={"x": 0, "y": 0, "width": CORE + 512, "height": 256})

    root = artifact_dir(cache_root, "item1", ah)
    left = read_cells(cells_path(root, 0, 0))
    right = read_cells(cells_path(root, 1, 0))
    # Two tiles ran, each seeing both nuclei; each kept exactly the one it owns, so nothing is
    # counted twice and nothing is dropped.
    assert len(left["xy"]) == 1 and len(right["xy"]) == 1
    assert st["result"]["n_nuclei"] == 2


def test_instance_ids_are_unique_across_tiles(cache_root):
    app = _app_with_fakes()
    client = app.test_client()
    ah, _ = _run(client, bbox={"x": 0, "y": 0, "width": CORE + 512, "height": 256})

    root = artifact_dir(cache_root, "item1", ah)
    ids = []
    for tx in (0, 1):
        cells = read_cells(cells_path(root, tx, 0))
        if cells is not None:
            ids += cells["inst"].tolist()
    assert len(ids) == len(set(ids))


def test_re_running_a_covered_region_does_not_double_count(cache_root):
    app = _app_with_fakes()
    client = app.test_client()
    ah, first = _run(client)
    ah2, second = _run(client)

    assert ah2 == ah                                   # same params, same artifact
    assert second["result"]["n_nuclei"] == first["result"]["n_nuclei"] == 2
    assert Coverage.load(artifact_dir(cache_root, "item1", ah)).totals["n_nuclei"] == 2


def test_tallies_describe_exactly_the_tiles_marked_done(cache_root):
    app = _app_with_fakes()
    client = app.test_client()
    ah, _ = _run(client, bbox={"x": 0, "y": 0, "width": CORE + 512, "height": 256})

    cov = Coverage.load(artifact_dir(cache_root, "item1", ah))
    # Two nuclei per tile, and the tally is written in the same atomic write as the tile list.
    assert cov.totals["n_nuclei"] == 2 * len(cov.done)


# ── the control plane ──────────────────────────────────────────────────────────────


def test_the_hash_route_names_a_run_without_starting_one(cache_root):
    """Since Inc 6 · 05 the gateway has to know the content address before it dispatches, because
    a dispatched run goes onto a queue and never comes back through the gateway. It asks here
    rather than computing it, so there is one implementation of the address and not two."""
    app = _app_with_fakes()
    client = app.test_client()

    body = client.post("/nuclei/hash", json={}).get_json()
    assert body["kind"] == "nuclei"
    # The same string a real run would store under, from the same function.
    assert body["art_hash"] == art_hash(backend=body["backend"])

    # Nothing was enqueued and nothing reached the disk.
    assert not artifact_dir(cache_root, "item1", body["art_hash"]).exists()

    ah, _ = _run(client)
    assert ah == body["art_hash"]


def test_a_bbox_is_a_rectangle_or_null_and_nothing_else():
    """null is the whole slide (see test_nuclei_wholeslide); anything else is a typo, and a typo
    that ran over the whole slide would be hours of GPU nobody asked for."""
    client = _app_with_fakes().test_client()
    r = client.post("/nuclei", json={"slide_ref": "item1", "bbox": "everything"})
    assert r.status_code == 400
    assert "null = whole slide" in r.get_json()["detail"]


def test_meta_for_an_unbuilt_artifact_is_404():
    client = _app_with_fakes().test_client()
    assert client.get(f"/nuclei/item1/{art_hash(backend='stub')}/meta").status_code == 404


def test_usage_and_delete(cache_root):
    app = _app_with_fakes()
    client = app.test_client()
    ah, _ = _run(client)

    assert client.get(f"/nuclei/item1/{ah}/usage").get_json()["bytes"] > 0
    assert client.delete(f"/nuclei/item1/{ah}").status_code == 204
    assert not artifact_dir(cache_root, "item1", ah).exists()
    # Idempotent, like the other services': the gateway may retry after a crash.
    assert client.delete(f"/nuclei/item1/{ah}").status_code == 204
    assert client.get(f"/nuclei/item1/{ah}/usage").get_json()["bytes"] == 0


def test_delete_refuses_a_path_that_would_escape_the_cache_root():
    client = _app_with_fakes().test_client()
    assert client.delete("/nuclei/item1/..").status_code in (400, 404)


def test_the_stateless_segment_route_still_works(cache_root):
    """This ticket adds an artifact path; it does not take the agent's one away."""
    client = _app_with_fakes().test_client()
    r = client.post("/segment", json={
        "slide_ref": "item1", "bbox": {"x": 0, "y": 0, "width": 64, "height": 48},
    })
    assert r.status_code == 200
    assert r.get_json()["count"] == 2
