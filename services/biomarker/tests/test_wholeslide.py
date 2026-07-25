"""The stage, end to end, with every expensive thing injected — no GPU, no CellViT, no slide.

The headline test is `test_a_nucleus_on_the_core_seam_is_counted_once_and_drawn_whole`: that is
review finding B1, and it is the difference between a map and a grid of chopped nuclei.
"""

import numpy as np

from biomarker_service.artifacts import CORE, Coverage, cells_path, read_json, summary_path
from biomarker_service.markers import CHANNEL_INDEX, CHANNEL_NAMES
from biomarker_service.pyramid import read_marker_tile, read_pheno_tile
from biomarker_service.wholeslide import SlideInfo, run_region

N_CH = len(CHANNEL_NAMES)
SLIDE = SlideInfo(width=2 * CORE, height=CORE, mpp=0.25)


def _reader(ck_left_of=CORE):
    """A synthetic slide whose PIXELS carry position: red is high left of ``ck_left_of``.

    The model is fed 512-px chunks and, like the real one, has no idea where on the slide it is —
    so anything position-dependent has to travel through the pixels, not a closure.
    """
    def read_window(x, y, w, h):
        px = np.zeros((h, w, 3), dtype=np.uint8)
        px[..., 0] = np.where(np.arange(x, x + w) < ck_left_of, 255, 0)[None, :]
        px[..., 1:] = 128
        return px
    return read_window


def _predictor():
    """DAPI everywhere; CK follows the red channel, so the field is genuinely bimodal."""
    def tile_predict(rgb):
        h, w = rgb.shape[:2]
        mif = np.full((N_CH, h, w), 0.05, dtype=np.float32)
        mif[CHANNEL_INDEX["DAPI"]] = 0.9
        mif[CHANNEL_INDEX["CK"]] = np.where(rgb[..., 0] > 128, 0.95, 0.02).astype(np.float32)
        return mif
    return tile_predict, None


def _nuclei(points):
    """A fetch_nuclei that returns fixed level-0 nuclei with 20-px square contours."""
    def fetch_nuclei(bbox):
        x0, y0 = bbox["x"], bbox["y"]
        x1, y1 = x0 + bbox["width"], y0 + bbox["height"]
        cents, classes, contours = [], [], []
        for cx, cy in points:
            if x0 <= cx < x1 and y0 <= cy < y1:
                cents.append([float(cx), float(cy)])
                classes.append(1)
                contours.append([[cx - 10, cy - 10], [cx + 10, cy - 10],
                                 [cx + 10, cy + 10], [cx - 10, cy + 10]])
        return cents, classes, contours
    return fetch_nuclei


def test_region_produces_both_pyramids_coverage_and_sidecars(tmp_path):
    predict, _ = _predictor()
    res = run_region(
        root=tmp_path, art="art1", slide=SLIDE,
        bbox={"x": 0, "y": 0, "width": CORE, "height": CORE},
        tissue_tiles=[(0, 0), (1, 0)],
        read_window=_reader(), tile_predict=predict,
        fetch_nuclei=_nuclei([(500, 500), (600, 700)]),
    )
    assert res["n_new_tiles"] == 1 and res["n_cells"] == 2

    # marker level 0 exists and carries the channel we asked for, by name
    got = read_marker_tile(tmp_path, 0, 0, 0, ["CK", "DAPI"])
    assert set(got) == {"CK", "DAPI"}
    assert got["DAPI"].shape == (256, 256)
    assert got["DAPI"].mean() > 200          # DAPI 0.9 → ~230 after uint8 quantisation

    # phenotype level 0 has painted nuclei
    ph = read_pheno_tile(tmp_path, 0, 500 // 256, 500 // 256)
    assert ph is not None and (ph != 0).any()

    # coverage + sidecar + summary all landed (S3/S4: sidecars and coarse levels are phase 1)
    assert Coverage.load(tmp_path).done == {(0, 0)}
    assert cells_path(tmp_path, 0, 0).is_file()
    assert read_json(summary_path(tmp_path))["n_cells"] == 2


def test_coarse_levels_are_built_so_a_region_is_visible_zoomed_out(tmp_path):
    predict, _ = _predictor()
    run_region(
        root=tmp_path, art="art1", slide=SLIDE,
        bbox={"x": 0, "y": 0, "width": CORE, "height": CORE}, tissue_tiles=[(0, 0)],
        read_window=_reader(), tile_predict=predict, fetch_nuclei=_nuclei([(500, 500)]),
    )
    # S4: without coarse levels the map is invisible until 1:1 zoom.
    assert (tmp_path / "pheno" / "1").is_dir()
    assert (tmp_path / "markers" / "1").is_dir()
    meta = read_json(tmp_path / "meta.json")
    assert meta["layers"]["markers"]["level_offset"] == 2      # S1: 1 µm/px = 2 octaves coarser
    assert meta["layers"]["pheno"]["level_offset"] == 0


def test_a_nucleus_on_the_core_seam_is_counted_once_and_drawn_whole(tmp_path):
    # B1 regression. This nucleus sits exactly on the boundary between core (0,0) and (1,0):
    # without halo+centroid-ownership it is detected by both tiles, counted twice, and rasterised
    # as two flat-sided fragments.
    seam_x = CORE
    predict, _ = _predictor()
    run_region(
        root=tmp_path, art="art1", slide=SLIDE, bbox=None,
        tissue_tiles=[(0, 0), (1, 0)],
        read_window=_reader(), tile_predict=predict,
        fetch_nuclei=_nuclei([(seam_x, 500)]),
    )
    summary = read_json(summary_path(tmp_path))
    assert summary["n_cells"] == 1, "the seam nucleus was double-counted"

    # ...and it is drawn on BOTH sides of the seam, i.e. the contour was not clipped to the core
    left = read_pheno_tile(tmp_path, 0, (seam_x - 1) // 256, 500 // 256)
    right = read_pheno_tile(tmp_path, 0, seam_x // 256, 500 // 256)
    assert left is not None and right is not None
    assert (left != 0).any(), "left half of the seam nucleus is missing"
    assert (right != 0).any(), "right half of the seam nucleus is missing"


def test_thresholds_are_slide_level_and_shared_by_every_tile(tmp_path):
    # D9: one threshold set for the whole artifact ⇒ no seam between separately-run regions.
    predict, _ = _predictor()
    run_region(
        root=tmp_path, art="art1", slide=SLIDE, bbox=None, tissue_tiles=[(0, 0), (1, 0)],
        read_window=_reader(), tile_predict=predict,
        fetch_nuclei=_nuclei([(500, 500), (CORE + 500, 500)]),
    )
    meta = read_json(tmp_path / "meta.json")
    assert meta["threshold_scope"] == "slide"
    assert meta["threshold_rev"] == 1
    assert "CK" in meta["thresholds"]


def test_rerunning_the_same_bbox_is_idempotent(tmp_path):
    predict, _ = _predictor()
    kw = dict(
        root=tmp_path, art="art1", slide=SLIDE,
        bbox={"x": 0, "y": 0, "width": CORE, "height": CORE}, tissue_tiles=[(0, 0)],
        read_window=_reader(), tile_predict=predict, fetch_nuclei=_nuclei([(500, 500)]),
    )
    first = run_region(**kw)
    second = run_region(**kw)
    assert first["n_new_tiles"] == 1
    assert second["n_new_tiles"] == 0            # D6: covered tiles are skipped, not recomputed
    assert second["n_cells"] == 1                # ...and the count does not double


def test_a_second_region_extends_the_same_artifact(tmp_path):
    predict, _ = _predictor()
    common = dict(root=tmp_path, art="art1", slide=SLIDE, tissue_tiles=[(0, 0), (1, 0)],
                  read_window=_reader(), tile_predict=predict)
    run_region(**common, bbox={"x": 0, "y": 0, "width": CORE, "height": CORE},
               fetch_nuclei=_nuclei([(500, 500)]))
    run_region(**common, bbox={"x": CORE, "y": 0, "width": CORE, "height": CORE},
               fetch_nuclei=_nuclei([(CORE + 500, 500)]))
    # D6: one artifact, coverage grew, counts are the union — not two forks of the map
    assert Coverage.load(tmp_path).done == {(0, 0), (1, 0)}
    assert read_json(summary_path(tmp_path))["n_cells"] == 2


def test_a_tile_with_no_nuclei_still_writes_tiles_and_covers(tmp_path):
    predict, _ = _predictor()
    res = run_region(
        root=tmp_path, art="art1", slide=SLIDE,
        bbox={"x": 0, "y": 0, "width": CORE, "height": CORE}, tissue_tiles=[(0, 0)],
        read_window=_reader(), tile_predict=predict, fetch_nuclei=_nuclei([]),
    )
    assert res["n_cells"] == 0
    assert Coverage.load(tmp_path).done == {(0, 0)}       # empty tissue is done, not pending
    assert read_marker_tile(tmp_path, 0, 0, 0, ["CK"])    # the marker map still exists there


def test_chunks_are_feathered_so_the_chunk_pitch_leaves_no_seam():
    """A read window larger than one chunk must not print a grid at the chunk pitch.

    The predictor here returns a value that depends on the chunk's *own* mean pixel, so
    butt-jointed chunks would step discontinuously at every boundary — which is exactly what a
    real model does when each call pads and windows independently.
    """
    from biomarker_service.wholeslide import CHUNK_OVERLAP, predict_window

    calls = {"n": 0}

    def tile_predict(rgb):
        calls["n"] += 1
        h, w = rgb.shape[:2]
        return np.full((N_CH, h, w), 0.1 + 0.3 * (calls["n"] % 3), dtype=np.float32)

    assert CHUNK_OVERLAP > 0
    big = np.zeros((3200, 3200, 3), dtype=np.uint8)      # > PREDICT_CHUNK, so it must chunk
    out = predict_window(big, tile_predict)
    assert calls["n"] > 1, "the fixture must actually exercise the multi-chunk path"
    row = out[0, 1600, :].astype(np.float32)
    steps = np.abs(np.diff(row))
    # Butt-joined chunks step by ~0.3*255 ≈ 77 at the seam; feathered ones must be far gentler.
    assert steps.max() < 12, f"chunk seam of {steps.max():.1f} — chunks are not blended"


def test_a_window_that_fits_one_chunk_is_a_single_model_call():
    from biomarker_service.wholeslide import predict_window

    calls = {"n": 0}

    def tile_predict(rgb):
        calls["n"] += 1
        h, w = rgb.shape[:2]
        return np.full((N_CH, h, w), 0.5, dtype=np.float32)

    predict_window(np.zeros((2560, 2560, 3), dtype=np.uint8), tile_predict)
    assert calls["n"] == 1      # a haloed core is one call, so it has no internal chunk seam
