import numpy as np

from biomarker_service.infer import NUM_CLASSES
from biomarker_service.markers import CHANNEL_INDEX
from biomarker_service.pipeline import (
    counts_by_phenotype,
    flag_counts,
    phenotype_region,
)


def _make_tile(h, w, markers):
    m = np.full((NUM_CLASSES, h, w), 0.05, dtype=np.float32)
    m[CHANNEL_INDEX["DAPI"]] = 0.9
    for name in markers:
        m[CHANNEL_INDEX[name]] = 0.9
    return m


def test_phenotype_region_streams_tiles_and_gates():
    # 512x1024 region → two 512 tiles side by side. Left tile → CK+ (tumour); right tile →
    # CD3+CD8+Ki67+ (cytotoxic T, proliferating). The right tile is flagged in the red channel so
    # the positional predictor knows which marker set to plant.
    H, W = 512, 1024
    pixels = np.zeros((H, W, 3), dtype=np.uint8)
    pixels[:, 512:, 0] = 255  # right tile marked

    def positional_predict(tile_rgb):
        h, w = tile_rgb.shape[:2]
        is_right = bool(tile_rgb[..., 0].mean() > 127)
        return _make_tile(h, w, ["CD3", "CD8", "Ki67"] if is_right else ["CK"])

    centroids = [[100.0, 100.0 + i * 20] for i in range(10)] + \
                [[700.0, 100.0 + i * 20] for i in range(10)]
    classes = ["Neoplastic"] * 10 + ["Inflammatory"] * 10

    cells, thresholds = phenotype_region(
        pixels, positional_predict, centroids, classes,
        origin_x=0.0, origin_y=0.0, read_scale=1.0, radius_px=3.0,
    )

    assert len(cells) == 20
    left = [c for c in cells if c["x"] == 100.0]
    right = [c for c in cells if c["x"] == 700.0]
    assert all(c["phenotype"] == "Tumour" for c in left)
    assert all(c["phenotype"] == "Cytotoxic T" for c in right)
    assert all("Proliferating" in c["flags"] for c in right)
    assert all(c["dapi_ok"] for c in cells)

    counts = counts_by_phenotype(cells)
    assert counts["Tumour"] == 10 and counts["Cytotoxic T"] == 10
    assert flag_counts(cells)["Proliferating"] == 10
    # each cell ships only its gate-deciding markers (O2), not all 23
    assert set(right[0]["markers"]).issubset({"CD3", "CD8", "Ki67"})
