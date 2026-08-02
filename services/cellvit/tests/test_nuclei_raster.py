"""The nuclei mask (Inc 5, ticket 06).

The claim under test is that the picture is the vectors: every stored nucleus is painted, in its
own class, in the right place — including the ones that hang across a core seam, which is the case
that would otherwise draw a 2048 px grid over the slide.
"""

import time

import numpy as np
import pytest
from support import segmented

from cellvit_service.app import create_app
from cellvit_service.artifacts import (
    CORE,
    TILE,
    artifact_dir,
    cells_path,
    label_dir,
    labels_path,
    read_cells,
    read_labels,
)
from cellvit_service.pyramid import (
    downsample_class,
    downsample_cover,
    read_class_tile,
    read_cover_tile,
)
from cellvit_service.region import RegionImage
from cellvit_service.taxonomy import DEFAULT
from cellvit_service.taxonomy import get as get_taxonomy


@pytest.fixture(autouse=True)
def cache_root(tmp_path, monkeypatch):
    monkeypatch.setenv("CELLVIT_ARTIFACT_CACHE", str(tmp_path))
    from cellvit_service.config import get_settings
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


def _blob(cx, cy, r=12.0):
    """An octagon around (cx, cy) — big enough to survive a couple of pyramid levels."""
    k = r * 0.4
    return [[cx - r, cy - k], [cx - k, cy - r], [cx + k, cy - r], [cx + r, cy - k],
            [cx + r, cy + k], [cx + k, cy + r], [cx - k, cy + r], [cx - r, cy + k]]


def _app(per_tile):
    """A service whose model returns whatever `per_tile(window)` says, in window-local pixels."""
    app = create_app()

    def slide_info(*, girder_base, slide_ref, token, client=None):
        return 4096, 4096, 0.25

    def read_region(*, girder_base, slide_ref, bbox, token, client=None):
        app.config["_WIN"] = bbox
        px = np.zeros((int(bbox["height"]), int(bbox["width"]), 3), dtype=np.uint8)
        return RegionImage(pixels=px, mpp=0.25, scale=1.0)

    app.config["SLIDE_INFO"] = slide_info
    app.config["READ_REGION"] = read_region
    app.config["SEGMENT"] = lambda pixels, mpp: per_tile(app.config["_WIN"])
    return app


def _at(win, *nuclei):
    """Place `(x, y, class)` triples given in *slide* pixels into the window's local frame."""
    pts = [[x - win["x"], y - win["y"]] for x, y, _ in nuclei]
    return segmented(pts, [c for _, _, c in nuclei], [_blob(*p) for p in pts])


def _run(client, bbox):
    r = client.post("/nuclei", json={"slide_ref": "item1", "bbox": bbox})
    assert r.status_code == 200, r.get_data(as_text=True)
    body = r.get_json()
    for _ in range(300):
        st = client.get(f"/nuclei/status/{body['job_id']}").get_json()
        if st["status"] in ("ready", "failed", "cancelled"):
            assert st["status"] == "ready", st.get("error")
            return body["art_hash"], st
        time.sleep(0.02)
    raise AssertionError("job never finished")


def _pixel(root, x, y):
    """The class index the level-0 raster carries at a slide pixel (mpp 0.25 ⇒ offset 0)."""
    tile = read_class_tile(root, DEFAULT, 0, x // TILE, y // TILE)
    return None if tile is None else int(tile[y % TILE, x % TILE])


# ── the picture is the vectors ─────────────────────────────────────────────────────


def test_every_stored_nucleus_is_painted_in_its_own_class(cache_root):
    placed = [(300, 400, 1), (700, 650, 3), (1500, 1200, 2)]
    client = _app(lambda win: _at(win, *placed)).test_client()
    ah, _ = _run(client, {"x": 0, "y": 0, "width": CORE, "height": CORE})

    root = artifact_dir(cache_root, "item1", ah)
    stored = read_cells(cells_path(root, 0, 0))
    assert len(stored["xy"]) == len(placed)

    # Read the picture at each *stored* centroid rather than at the coordinates the fake model was
    # given: this asserts the raster agrees with what is on disk, which is the thing that could
    # drift.
    named = read_labels(labels_path(root, DEFAULT, 0, 0))
    for (cx, cy), cls in zip(stored["xy"], named["cls"].tolist(), strict=True):
        assert _pixel(root, int(cx), int(cy)) == cls


def test_nothing_is_painted_where_there_is_no_nucleus(cache_root):
    client = _app(lambda win: _at(win, (300, 400, 1))).test_client()
    ah, _ = _run(client, {"x": 0, "y": 0, "width": CORE, "height": CORE})

    root = artifact_dir(cache_root, "item1", ah)
    assert _pixel(root, 300, 400) == 1
    assert _pixel(root, 900, 900) == 0                 # far from the one nucleus
    idx = read_class_tile(root, DEFAULT, 0, 0, 0)
    assert set(np.unique(idx).tolist()) <= {0, 1}      # no class nobody predicted


def test_a_nucleus_straddling_a_seam_is_painted_on_both_sides(cache_root):
    """The reason a core is drawn from its 3x3 neighbourhood: ownership is by centroid, so this
    nucleus is stored once, by the left core, and must still appear in the right core's tiles."""
    def per_tile(win):
        return _at(win, (CORE - 4, 500, 1))            # centroid left of the seam, body across it

    client = _app(per_tile).test_client()
    ah, _ = _run(client, {"x": 0, "y": 0, "width": CORE + 512, "height": 1024})

    root = artifact_dir(cache_root, "item1", ah)
    # Stored once, by the left core.
    assert len(read_cells(cells_path(root, 0, 0))["xy"]) == 1
    assert read_cells(cells_path(root, 1, 0)) is not None
    assert len(read_cells(cells_path(root, 1, 0))["xy"]) == 0
    # Painted on both sides of it.
    assert _pixel(root, CORE - 6, 500) == 1
    assert _pixel(root, CORE + 4, 500) == 1


def test_the_raster_is_rebuilt_when_it_is_missing(cache_root):
    """Derived data, so losing it costs a redraw and never a number. Also the path by which an
    artifact built before this ticket gets a picture."""
    import shutil

    client = _app(lambda win: _at(win, (300, 400, 1))).test_client()
    bbox = {"x": 0, "y": 0, "width": CORE, "height": CORE}
    ah, _ = _run(client, bbox)

    root = artifact_dir(cache_root, "item1", ah)
    shutil.rmtree(label_dir(root, DEFAULT) / "classes")
    assert _pixel(root, 300, 400) is None

    # Every tile is already covered, so nothing is inferred — only the picture comes back.
    ah2, st = _run(client, bbox)
    assert ah2 == ah
    assert st["result"]["n_nuclei"] == 1               # and the count did not double
    assert _pixel(root, 300, 400) == 1


# ── the pyramid ────────────────────────────────────────────────────────────────────


def test_a_pyramid_is_built_up_to_a_single_tile(cache_root):
    client = _app(lambda win: _at(win, (300, 400, 1))).test_client()
    ah, _ = _run(client, {"x": 0, "y": 0, "width": CORE, "height": CORE})

    root = artifact_dir(cache_root, "item1", ah)
    meta = client.get(f"/nuclei/item1/{ah}/meta").get_json()
    # 4096 px at 0.25 µm/px stored 1:1 ⇒ 16 tiles across ⇒ 5 levels.
    assert meta["layers"]["classes"] == {"level_offset": 0, "levels": 5}
    assert meta["tile"] == TILE
    assert (label_dir(root, DEFAULT) / "classes" / "4").is_dir()


def test_coarse_levels_keep_the_class_and_lose_only_the_resolution(cache_root):
    client = _app(lambda win: _at(win, (300, 400, 2))).test_client()
    ah, _ = _run(client, {"x": 0, "y": 0, "width": CORE, "height": CORE})

    root = artifact_dir(cache_root, "item1", ah)
    for z, (x, y) in [(1, (150, 200)), (2, (75, 100))]:
        tile = read_class_tile(root, DEFAULT, z, x // TILE, y // TILE)
        assert tile is not None
        assert int(tile[y % TILE, x % TILE]) == 2


def test_downsampling_neither_inflates_nor_erases_the_nuclei():
    """The reason for a coverage plane at all: a class raster alone cannot answer 'how much'.

    A quarter-full field must not come out solid (which 'non-background first' would give) and must
    not come out blank (which plain mode would give).
    """
    idx = np.zeros((4, 4), dtype=np.uint8)
    idx[0, 0] = idx[2, 2] = 1                          # one nucleus pixel in each 2x2 quad-corner
    cover = ((idx != 0) * 255).astype(np.uint8)

    small_idx = downsample_class(idx, get_taxonomy(DEFAULT).class_ids)
    small_cov = downsample_cover(cover)

    assert small_idx[0, 0] == 1 and small_idx[1, 1] == 1     # the class survived
    assert small_idx[0, 1] == 0 and small_idx[1, 0] == 0     # empty quads stayed empty
    assert small_cov[0, 0] == 63                             # …at a quarter of the density
    assert small_cov[0, 1] == 0


def test_a_tie_between_two_classes_resolves_to_the_lower_id():
    idx = np.array([[3, 3], [1, 1]], dtype=np.uint8)
    assert int(downsample_class(idx, get_taxonomy(DEFAULT).class_ids)[0, 0]) == 1


# ── the tile route ─────────────────────────────────────────────────────────────────


def test_a_tile_renders_the_class_colour_at_the_requested_opacity(cache_root):
    from io import BytesIO

    from PIL import Image

    client = _app(lambda win: _at(win, (300, 400, 1))).test_client()
    ah, _ = _run(client, {"x": 0, "y": 0, "width": CORE, "height": CORE})

    r = client.get(f"/nuclei/item1/{ah}/tile/classes/0/1/1.png?alpha=0.5")
    assert r.status_code == 200
    assert r.headers["Content-Type"] == "image/png"
    rgba = np.array(Image.open(BytesIO(r.data)).convert("RGBA"))
    px = rgba[400 % TILE, 300 % TILE]
    assert tuple(px[:3]) == (0xD5, 0x5E, 0x00)         # Neoplastic, from the artifact's palette
    assert px[3] == 127                                # opacity x coverage(=1) at level 0
    assert rgba[10, 10, 3] == 0                        # and nothing where there is no nucleus


def test_hiding_a_class_makes_it_transparent_without_touching_the_others(cache_root):
    from io import BytesIO

    from PIL import Image

    client = _app(lambda win: _at(win, (300, 400, 1), (340, 400, 3))).test_client()
    ah, _ = _run(client, {"x": 0, "y": 0, "width": CORE, "height": CORE})

    r = client.get(f"/nuclei/item1/{ah}/tile/classes/0/1/1.png?show=Connective")
    rgba = np.array(Image.open(BytesIO(r.data)).convert("RGBA"))
    assert rgba[400 % TILE, 300 % TILE][3] == 0        # Neoplastic hidden
    assert rgba[400 % TILE, 340 % TILE][3] == 255      # Connective still drawn


def test_an_uncovered_tile_is_a_transparent_png_not_an_error(cache_root):
    client = _app(lambda win: _at(win, (300, 400, 1))).test_client()
    ah, _ = _run(client, {"x": 0, "y": 0, "width": CORE, "height": CORE})

    r = client.get(f"/nuclei/item1/{ah}/tile/classes/0/60/60.png")
    assert r.status_code == 200
    assert r.headers["Content-Type"] == "image/png"


def test_an_unknown_class_or_layer_is_refused_rather_than_silently_dropped(cache_root):
    client = _app(lambda win: _at(win, (300, 400, 1))).test_client()
    ah, _ = _run(client, {"x": 0, "y": 0, "width": CORE, "height": CORE})

    assert client.get(f"/nuclei/item1/{ah}/tile/classes/0/1/1.png?show=Tumour").status_code == 400
    assert client.get(f"/nuclei/item1/{ah}/tile/probs/0/1/1.png").status_code == 400


def test_a_coarse_tile_fades_by_how_much_of_the_pixel_is_nucleus(cache_root):
    """Zoomed out, a pixel is part nucleus and part not, and the picture says so — the alpha ramp
    is where the coverage plane shows up on screen."""
    from io import BytesIO

    from PIL import Image

    client = _app(lambda win: _at(win, (300, 400, 1))).test_client()
    ah, _ = _run(client, {"x": 0, "y": 0, "width": CORE, "height": CORE})

    root = artifact_dir(cache_root, "item1", ah)
    cov = read_cover_tile(root, 2, 0, 0)
    assert cov is not None
    partial = cov[(cov > 0) & (cov < 255)]
    assert partial.size, "a nucleus at 4x should have partly-covered pixels at its edge"

    r = client.get(f"/nuclei/item1/{ah}/tile/classes/2/0/0.png")
    alpha = np.array(Image.open(BytesIO(r.data)).convert("RGBA"))[..., 3]
    assert int(alpha.max()) == 255                     # its middle is solidly nucleus
    assert ((alpha > 0) & (alpha < 255)).any()         # its edge is not
