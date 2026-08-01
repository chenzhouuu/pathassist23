"""Whole-slide nuclei: coverage, stop, resume (Inc 5, ticket 07).

A whole-slide run is hours of the only GPU worker, so the three things that matter are that it
looks only where there is tissue, that it can be stopped, and that stopping costs nothing — the
count after a stop-and-resume has to be the count an uninterrupted run would have produced.
"""

import threading
import time

import numpy as np
import pytest

from cellvit_service import routes as routes_mod
from cellvit_service.app import create_app
from cellvit_service.artifacts import CORE, Coverage, artifact_dir, cells_path, read_cells
from cellvit_service.region import RegionImage
from cellvit_service.slides import tissue_core_tiles


@pytest.fixture(autouse=True)
def cache_root(tmp_path, monkeypatch):
    monkeypatch.setenv("CELLVIT_ARTIFACT_CACHE", str(tmp_path))
    from cellvit_service.config import get_settings
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


def _app(tiles=((0, 0), (1, 0), (2, 0)), on_core=None):
    """A service whose slide holds tissue in `tiles` and whose model finds two nuclei per core."""
    app = create_app()
    app.config["SLIDE_INFO"] = lambda **kw: (8192, 4096, 0.25)

    def read_region(*, girder_base, slide_ref, bbox, token, client=None):
        return RegionImage(
            pixels=np.zeros((int(bbox["height"]), int(bbox["width"]), 3), dtype=np.uint8),
            mpp=0.25, scale=1.0,
        )

    def segment(pixels, mpp):
        if on_core is not None:
            on_core()
        # Two nuclei near the middle of the window, so both belong to the core it is centred on.
        h, w = pixels.shape[:2]
        pts = [[w / 2, h / 2], [w / 2 + 30, h / 2]]
        return pts, [1, 3], [_diamond(*p) for p in pts]

    app.config["READ_REGION"] = read_region
    app.config["SEGMENT"] = segment
    app.config["TISSUE_TILES"] = lambda **kw: [tuple(t) for t in tiles]
    return app


def _diamond(cx, cy, r=6.0):
    return [[cx - r, cy], [cx, cy - r], [cx + r, cy], [cx, cy + r]]


def _await(client, job_id, timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        st = client.get(f"/nuclei/status/{job_id}").get_json()
        if st["status"] in ("ready", "failed", "cancelled"):
            return st
        time.sleep(0.02)
    raise AssertionError("job never finished")


def _whole(client, seg_hash="seg1"):
    r = client.post("/nuclei", json={"slide_ref": "item1", "bbox": None, "seg_hash": seg_hash})
    assert r.status_code == 200, r.get_data(as_text=True)
    return r.get_json()


# ── where a whole-slide run looks ──────────────────────────────────────────────────


def test_a_whole_slide_run_only_visits_the_cores_that_hold_tissue(cache_root):
    client = _app(tiles=[(0, 0), (2, 0)]).test_client()
    run = _whole(client)
    st = _await(client, run["job_id"])

    assert run["scope"] == "slide"
    assert st["status"] == "ready"
    root = artifact_dir(cache_root, "item1", run["art_hash"])
    assert Coverage.load(root).done == {(0, 0), (2, 0)}
    # …and nothing was written for the core in between, which is background.
    assert read_cells(cells_path(root, 1, 0)) is None


def test_a_whole_slide_run_without_a_segmentation_says_so(cache_root):
    client = _app().test_client()
    r = client.post("/nuclei", json={"slide_ref": "item1", "bbox": None})
    assert r.status_code == 400
    assert "seg_hash" in r.get_json()["detail"]


def test_a_segmentation_that_holds_no_tissue_fails_the_job_rather_than_running_the_slide(
    cache_root,
):
    """Empty contours mean the mask is not usable, not that the slide is empty. Running every core
    of a whole slide on that basis is hours of GPU spent finding nothing."""
    client = _app(tiles=[]).test_client()
    st = _await(client, _whole(client)["job_id"])
    assert st["status"] == "failed"
    assert "tissue segmentation" in st["error"]


def test_a_region_run_still_needs_no_segmentation(cache_root):
    """The mask is coverage, not identity: a drawn box says where to look all by itself."""
    client = _app().test_client()
    r = client.post("/nuclei", json={
        "slide_ref": "item1", "bbox": {"x": 0, "y": 0, "width": 512, "height": 512},
    })
    assert r.status_code == 200 and r.get_json()["scope"] == "region"
    assert _await(client, r.get_json()["job_id"])["status"] == "ready"


def test_the_cache_is_checked_before_a_whole_slide_run_not_during_one(cache_root, monkeypatch):
    """Filling the volume mid-job leaves a half-written pyramid, which renders as holes rather
    than as an error. A region run is small enough to let through either way."""
    monkeypatch.setattr(routes_mod, "_free_gb", lambda path: 0.5)
    client = _app().test_client()

    r = client.post("/nuclei", json={"slide_ref": "item1", "bbox": None, "seg_hash": "seg1"})
    assert r.status_code == 507
    assert "GB free" in r.get_json()["detail"]

    ok = client.post("/nuclei", json={
        "slide_ref": "item1", "bbox": {"x": 0, "y": 0, "width": 512, "height": 512},
    })
    assert ok.status_code == 200


# ── stop and resume ────────────────────────────────────────────────────────────────


def _stopping_after(n_cores, tiles):
    """A service that asks its own job to stop once the model has run `n_cores` times."""
    state = {"calls": 0, "job_id": None}
    ready = threading.Event()
    app = None

    def on_core():
        # Wait until the test has the job id — the worker thread can reach the model before the
        # POST has returned.
        ready.wait(5)
        state["calls"] += 1
        if state["calls"] >= n_cores:
            app.config["JOBS"].cancel(state["job_id"])

    app = _app(tiles=tiles, on_core=on_core)
    return app, state, ready


def test_stop_leaves_a_smaller_complete_artifact_not_a_damaged_one(cache_root):
    app, state, ready = _stopping_after(1, [(0, 0), (1, 0), (2, 0)])
    client = app.test_client()

    run = _whole(client)
    state["job_id"] = run["job_id"]
    ready.set()
    st = _await(client, run["job_id"])

    assert st["status"] == "cancelled" and st["stage"] == "stopped"
    assert st["result"]["stopped"] is True
    assert st["result"]["remaining"] == 2

    root = artifact_dir(cache_root, "item1", run["art_hash"])
    cov = Coverage.load(root)
    assert cov.done == {(0, 0)}                     # the core it was on finished
    # The invariant Inc 4 arrived at: the tallies describe exactly the tiles listed as done, at
    # every point a reader can observe. A stop is the moment that could break it.
    assert cov.totals["n_nuclei"] == 2 * len(cov.done)
    assert st["result"]["n_nuclei"] == 2


def test_a_stopped_build_keeps_its_progress_rather_than_reporting_done(cache_root):
    app, state, ready = _stopping_after(1, [(0, 0), (1, 0), (2, 0)])
    client = app.test_client()
    run = _whole(client)
    state["job_id"] = run["job_id"]
    ready.set()
    st = _await(client, run["job_id"])

    # A stopped job reporting 100 % would misdescribe the artifact that is now on disk.
    assert 0 < st["progress"] < 1


def test_resuming_reaches_the_same_totals_as_one_uninterrupted_run(cache_root):
    tiles = [(0, 0), (1, 0), (2, 0)]

    app, state, ready = _stopping_after(2, tiles)
    client = app.test_client()
    run = _whole(client)
    state["job_id"] = run["job_id"]
    ready.set()
    stopped = _await(client, run["job_id"])
    assert stopped["status"] == "cancelled"
    part = stopped["result"]["n_nuclei"]
    assert part < 6

    # Same artifact, same route, no special resume verb — coverage is what makes it free.
    resumed = _await(client, _whole(client)["job_id"])
    assert resumed["status"] == "ready"
    assert resumed["result"]["n_nuclei"] == 6           # 3 cores x 2, counted once each
    assert resumed["result"]["remaining"] == 0

    root = artifact_dir(cache_root, "item1", run["art_hash"])
    cov = Coverage.load(root)
    assert cov.done == set(tiles)
    assert cov.totals["n_nuclei"] == 2 * len(cov.done)


def test_a_resume_does_not_reissue_an_instance_id(cache_root):
    """Ids are dense and per artifact, so a resume that restarted the counter would give two
    different nuclei the same id — and ticket 08's raster is addressed by that id."""
    tiles = [(0, 0), (1, 0), (2, 0)]
    app, state, ready = _stopping_after(1, tiles)
    client = app.test_client()
    run = _whole(client)
    state["job_id"] = run["job_id"]
    ready.set()
    _await(client, run["job_id"])
    _await(client, _whole(client)["job_id"])

    root = artifact_dir(cache_root, "item1", run["art_hash"])
    ids = []
    for t in tiles:
        cells = read_cells(cells_path(root, *t))
        if cells is not None:
            ids += cells["inst"].tolist()
    assert len(ids) == len(set(ids)) == 6


def test_a_stopped_run_still_leaves_a_picture(cache_root):
    """The raster is what makes the covered area viewable at all, and it costs a fraction of one
    core — so even a stopped job draws before it returns."""
    from cellvit_service.pyramid import read_class_tile

    app, state, ready = _stopping_after(1, [(0, 0), (1, 0)])
    client = app.test_client()
    run = _whole(client)
    state["job_id"] = run["job_id"]
    ready.set()
    _await(client, run["job_id"])

    root = artifact_dir(cache_root, "item1", run["art_hash"])
    assert read_class_tile(root, 0, 4, 4) is not None       # inside core (0, 0)


def test_cancelling_an_unknown_job_is_a_404():
    client = _app().test_client()
    assert client.post("/nuclei/cancel/nope").status_code == 404


# ── which cores hold tissue ────────────────────────────────────────────────────────


def test_core_selection_is_by_bounding_box_because_a_false_negative_is_the_costly_one():
    contours = {"features": [{"geometry": {
        "type": "Polygon",
        "coordinates": [[[100, 100], [3000, 100], [3000, 3000], [100, 3000], [100, 100]]],
    }}]}
    tiles = tissue_core_tiles(contours, 8192, 8192, CORE)
    assert (0, 0) in tiles and (1, 1) in tiles          # the polygon spans four cores
    assert (3, 3) not in tiles                          # and nothing reaches this one
    assert tissue_core_tiles(None, 8192, 8192, CORE) == []
