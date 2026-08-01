"""The instance-id raster (Inc 5, ticket 08).

Every nucleus carries its own identity, packed exactly enough that a click can later be turned back
into one nucleus without shipping a million polygons to the browser. The claims worth pinning are
that the ids survive the round trip, that touching nuclei stay separate, and that a resume does not
renumber anything — the last one because the id is what everything downstream will join on.
"""

import time

import numpy as np
import pytest

from cellvit_service.app import create_app
from cellvit_service.artifacts import CORE, TILE, artifact_dir, cells_path, read_cells
from cellvit_service.pyramid import (
    downsample_instance,
    pack_instances,
    read_class_tile,
    read_instance_tile,
    unpack_instances,
)
from cellvit_service.region import RegionImage
from cellvit_service.tiles import colourise_instances


@pytest.fixture(autouse=True)
def cache_root(tmp_path, monkeypatch):
    monkeypatch.setenv("CELLVIT_ARTIFACT_CACHE", str(tmp_path))
    from cellvit_service.config import get_settings
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


def _blob(cx, cy, r=10.0):
    k = r * 0.4
    return [[cx - r, cy - k], [cx - k, cy - r], [cx + k, cy - r], [cx + r, cy - k],
            [cx + r, cy + k], [cx + k, cy + r], [cx - k, cy + r], [cx - r, cy + k]]


def _app(placed):
    app = create_app()
    app.config["SLIDE_INFO"] = lambda **kw: (4096, 4096, 0.25)

    def read_region(*, girder_base, slide_ref, bbox, token, client=None):
        app.config["_WIN"] = bbox
        return RegionImage(
            pixels=np.zeros((int(bbox["height"]), int(bbox["width"]), 3), dtype=np.uint8),
            mpp=0.25, scale=1.0)

    def segment(pixels, mpp):
        win = app.config["_WIN"]
        pts = [[x - win["x"], y - win["y"]] for x, y, _ in placed]
        return pts, [c for _, _, c in placed], [_blob(*p) for p in pts]

    app.config["READ_REGION"] = read_region
    app.config["SEGMENT"] = segment
    return app


def _run(client, bbox=None):
    r = client.post("/nuclei", json={
        "slide_ref": "item1", "bbox": bbox or {"x": 0, "y": 0, "width": 1024, "height": 1024}})
    assert r.status_code == 200, r.get_data(as_text=True)
    body = r.get_json()
    for _ in range(400):
        st = client.get(f"/nuclei/status/{body['job_id']}").get_json()
        if st["status"] in ("ready", "failed", "cancelled"):
            assert st["status"] == "ready", st.get("error")
            return body["art_hash"]
        time.sleep(0.02)
    raise AssertionError("job never finished")


def _id_at(root, x, y):
    t = read_instance_tile(root, 0, x // TILE, y // TILE)
    return None if t is None else int(t[y % TILE, x % TILE])


# ── the packing ────────────────────────────────────────────────────────────────────


def test_ids_survive_the_packing_exactly():
    ids = np.array([[0, 1, 255], [256, 65_535, 16_777_215]], dtype=np.uint32)
    assert (unpack_instances(pack_instances(ids)) == ids).all()


def test_no_nucleus_is_transparent_and_reads_back_as_zero():
    rgba = pack_instances(np.array([[0, 7]], dtype=np.uint32))
    assert rgba[0, 0, 3] == 0 and rgba[0, 1, 3] == 255
    assert unpack_instances(rgba).tolist() == [[0, 7]]


def test_an_id_too_large_to_carry_is_an_error_not_a_wrong_number():
    """24 bits is ~16.7 M nuclei against a real slide's 1–10 M. Silently wrapping would give two
    different cells the same id, which is worse than refusing."""
    with pytest.raises(RuntimeError, match="24 bits"):
        pack_instances(np.array([[1 << 24]], dtype=np.uint32))


# ── the raster ─────────────────────────────────────────────────────────────────────


def test_every_nucleus_gets_its_own_id_in_the_raster(cache_root):
    placed = [(300, 300, 1), (500, 400, 3), (700, 600, 2)]
    client = _app(placed).test_client()
    ah = _run(client)

    root = artifact_dir(cache_root, "item1", ah)
    stored = read_cells(cells_path(root, 0, 0))
    seen = [_id_at(root, int(cx), int(cy)) for cx, cy in stored["xy"]]
    assert seen == stored["inst"].tolist()
    assert len(set(seen)) == len(placed)


def test_touching_nuclei_do_not_merge_into_one_blob(cache_root):
    """Two cells 12 px apart with a 10 px radius overlap. In the class raster they are one region
    of one colour; the point of the instance raster is that they are still two."""
    client = _app([(400, 400, 1), (412, 400, 1)]).test_client()
    ah = _run(client)

    root = artifact_dir(cache_root, "item1", ah)
    left, right = _id_at(root, 392, 400), _id_at(root, 420, 400)
    assert left and right and left != right
    # …while the class raster, correctly, cannot tell them apart.
    cls = read_class_tile(root, 0, 400 // TILE, 400 // TILE)
    assert cls[400 % TILE, 392 % TILE] == cls[400 % TILE, 420 % TILE] == 1


def test_the_two_rasters_agree_on_which_pixels_are_nucleus(cache_root):
    """They are the same array split by a lookup, so this is a structural claim, not a tolerance."""
    client = _app([(300, 300, 1), (500, 400, 3)]).test_client()
    ah = _run(client)
    root = artifact_dir(cache_root, "item1", ah)
    for tx in range(2):
        for ty in range(2):
            cls, ids = read_class_tile(root, 0, tx, ty), read_instance_tile(root, 0, tx, ty)
            if cls is None:
                continue
            assert ((cls != 0) == (ids != 0)).all()


def test_an_id_is_stable_across_a_stop_and_resume(cache_root):
    """Everything downstream will join on this id, so a resume that renumbered would silently
    re-point every reference at a different cell."""
    placed = [(300, 300, 1)]
    client = _app(placed).test_client()
    ah = _run(client, {"x": 0, "y": 0, "width": 1024, "height": 1024})
    root = artifact_dir(cache_root, "item1", ah)
    before = _id_at(root, 300, 300)

    # Extend the artifact with a second core; the first must not be renumbered.
    _run(client, {"x": 0, "y": 0, "width": CORE + 512, "height": 1024})
    assert _id_at(root, 300, 300) == before


# ── the view ───────────────────────────────────────────────────────────────────────


def test_consecutive_ids_are_given_far_apart_colours():
    """Ids are handed out in the order nuclei are computed, so the exact packing would paint a
    field of separate cells as a smooth gradient."""
    ids = np.arange(1, 9, dtype=np.uint32).reshape(2, 4)
    rgb = colourise_instances(ids, None)[..., :3].reshape(-1, 3).astype(int)
    gaps = [int(np.abs(rgb[i] - rgb[i + 1]).max()) for i in range(len(rgb) - 1)]
    assert min(gaps) > 40, f"neighbouring ids look alike: {gaps}"


def test_the_same_nucleus_is_always_the_same_colour():
    a = colourise_instances(np.array([[12345]], dtype=np.uint32), None)
    b = colourise_instances(np.array([[12345]], dtype=np.uint32), None)
    assert (a == b).all()


def test_raw_hands_back_the_stored_packing_for_a_future_picker():
    ids = np.array([[0, 1, 70_000]], dtype=np.uint32)
    assert (unpack_instances(colourise_instances(ids, None, raw=True)) == ids).all()


def test_downsampling_keeps_an_id_rather_than_inventing_one():
    ids = np.array([[7, 7], [9, 0]], dtype=np.uint32)
    assert int(downsample_instance(ids)[0, 0]) == 7          # the majority
    ids = np.array([[0, 0], [0, 0]], dtype=np.uint32)
    assert int(downsample_instance(ids)[0, 0]) == 0          # and background stays background


# ── the route ──────────────────────────────────────────────────────────────────────


def test_the_instance_layer_is_served_and_advertised(cache_root):
    from io import BytesIO

    from PIL import Image

    client = _app([(300, 300, 1)]).test_client()
    ah = _run(client)

    meta = client.get(f"/nuclei/item1/{ah}/meta").get_json()
    assert meta["layers"]["instances"] == meta["layers"]["classes"]

    r = client.get(f"/nuclei/item1/{ah}/tile/instances/0/1/1.png")
    assert r.status_code == 200 and r.headers["Content-Type"] == "image/png"
    im = np.array(Image.open(BytesIO(r.data)).convert("RGBA"))
    assert im[..., 3].max() == 255

    raw = client.get(f"/nuclei/item1/{ah}/tile/instances/0/1/1.png?raw=1")
    ids = unpack_instances(np.array(Image.open(BytesIO(raw.data)).convert("RGBA")))
    assert ids[300 % TILE, 300 % TILE] == _id_at(
        artifact_dir(cache_root, "item1", ah), 300, 300)


def test_an_uncovered_instance_tile_is_a_transparent_png(cache_root):
    client = _app([(300, 300, 1)]).test_client()
    ah = _run(client)
    r = client.get(f"/nuclei/item1/{ah}/tile/instances/0/40/40.png")
    assert r.status_code == 200 and r.headers["Content-Type"] == "image/png"


# ── handing cells to another service (Inc 5 · 09) ──────────────────────────────────


def test_cells_in_a_window_come_back_in_level_0_pixels(cache_root):
    """The shape the biomarker map consumes instead of segmenting the slide a second time."""
    placed = [(300, 300, 1), (500, 400, 3), (1500, 1500, 2)]
    client = _app(placed).test_client()
    ah = _run(client, {"x": 0, "y": 0, "width": 2048, "height": 2048})

    body = client.get(f"/nuclei/item1/{ah}/cells?bbox=0,0,600,600").get_json()
    assert body["count"] == 2                       # the third is outside the window
    xs = sorted(int(c[0]) for c in body["centroids"])
    assert xs == [300, 500]
    assert sorted(body["classes"]) == ["Connective", "Neoplastic"]
    assert len(body["contours"]) == 2 and len(body["contours"][0]) >= 3
    assert len(set(body["instances"])) == 2         # the artifact's own ids ride along


def test_a_window_spanning_two_cores_counts_each_nucleus_once(cache_root):
    """Ownership is by centroid, so no cell is returned by two cores."""
    client = _app([(CORE - 20, 300, 1), (CORE + 20, 300, 1)]).test_client()
    ah = _run(client, {"x": 0, "y": 0, "width": CORE + 512, "height": 1024})

    body = client.get(f"/nuclei/item1/{ah}/cells?bbox=0,0,{CORE + 512},1024").get_json()
    assert body["count"] == 2
    assert len(set(body["instances"])) == 2


def test_a_window_reaching_past_the_computed_area_says_so(cache_root):
    """Honest and partial rather than silently short: the caller decides whether that is usable."""
    client = _app([(300, 300, 1)]).test_client()
    ah = _run(client, {"x": 0, "y": 0, "width": 1024, "height": 1024})

    inside = client.get(f"/nuclei/item1/{ah}/cells?bbox=0,0,1024,1024").get_json()
    beyond = client.get(f"/nuclei/item1/{ah}/cells?bbox=0,0,{CORE * 3},1024").get_json()
    assert inside["covered"] is True
    assert beyond["covered"] is False


def test_a_missing_bbox_is_refused_rather_than_meaning_the_whole_slide(cache_root):
    """A built-out artifact holds millions of polygons; a forgotten parameter must not ship them."""
    client = _app([(300, 300, 1)]).test_client()
    ah = _run(client)
    assert client.get(f"/nuclei/item1/{ah}/cells").status_code == 400
    assert client.get(f"/nuclei/item1/{ah}/cells?bbox=0,0,0,0").status_code == 400


def test_cells_for_an_artifact_that_does_not_exist_is_a_404():
    client = _app([]).test_client()
    assert client.get("/nuclei/item1/deadbeef/cells?bbox=0,0,10,10").status_code == 404
