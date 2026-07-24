import numpy as np

from biomarker_service.markers import CHANNEL_INDEX
from biomarker_service.phenotype import (
    dapi_ok,
    gate,
    pool_cells,
    positive_markers,
    region_thresholds,
)


def _idx(name):
    return CHANNEL_INDEX[name]


def test_pool_cells_disk_mean():
    mif = np.zeros((23, 20, 20), dtype=np.float32)
    mif[_idx("CK"), 8:13, 8:13] = 1.0  # a CK-positive block around (10,10)
    pooled = pool_cells(mif, [(10.0, 10.0)], radius_px=2.0)
    assert pooled.shape == (1, 23)
    assert pooled[0, _idx("CK")] == 1.0        # disk sits inside the block
    assert pooled[0, _idx("CD3")] == 0.0       # other channels untouched


def test_dapi_qc_flags_empty_nucleus():
    v = np.zeros((2, 23), dtype=np.float32)
    v[0, _idx("DAPI")] = 0.9
    v[1, _idx("DAPI")] = 0.02  # below the empty-nucleus floor
    assert list(dapi_ok(v)) == [True, False]


def _two_group_vectors():
    # 10 tumour (CK+), 10 cytotoxic-T (CD3+CD8+Ki67+); CD20 held uniform → no positive population.
    v = np.full((20, 23), 0.05, dtype=np.float32)
    v[:, _idx("DAPI")] = 0.9
    v[0:10, _idx("CK")] = 0.9
    v[10:20, _idx("CD3")] = 0.9
    v[10:20, _idx("CD8")] = 0.9
    v[10:20, _idx("Ki67")] = 0.9
    return v


def test_region_thresholds_guard_rejects_uniform_marker():
    v = _two_group_vectors()
    th = region_thresholds(v)
    assert th["CK"] is not None            # bimodal → a real threshold
    assert th["CD20"] is None              # uniformly negative → no positive population (S6)


def test_gate_tumour_and_cytotoxic_t():
    v = _two_group_vectors()
    th = region_thresholds(v)

    lineage_a, flags_a = gate(positive_markers(v[0], th))
    assert lineage_a == "Tumour" and flags_a == []

    lineage_b, flags_b = gate(positive_markers(v[10], th))
    assert lineage_b == "Cytotoxic T"
    assert "Proliferating" in flags_b      # Ki67+ functional flag
