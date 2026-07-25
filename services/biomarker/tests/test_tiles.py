"""Tile compositing: the picture itself, plus the uncovered-tile contract (review B2)."""

import io

import numpy as np
import pytest
from PIL import Image

from biomarker_service.pyramid import phenotype_index
from biomarker_service.tiles import (
    TRANSPARENT_TILE,
    BadChannelSpec,
    colourise_pheno,
    composite,
    encode_png,
    parse_channels,
    transfer,
)


def test_parse_channels_keeps_order_and_decodes_colour():
    assert parse_channels("CK:00ffff,CD8:8000ff") == [
        ("CK", (0, 255, 255)), ("CD8", (128, 0, 255)),
    ]
    assert parse_channels("") == []
    assert parse_channels("CK")[0][1] == (255, 255, 255)   # colour defaults to white


def test_parse_channels_rejects_rather_than_silently_dropping():
    # A dropped channel would read as "this marker is negative here" — a wrong scientific
    # reading, so a typo must be a 400.
    with pytest.raises(BadChannelSpec):
        parse_channels("NotAMarker:00ffff")
    with pytest.raises(BadChannelSpec):
        parse_channels("CK:xyz")
    with pytest.raises(BadChannelSpec):
        parse_channels("CK:00ff")


def test_transfer_windows_and_gammas():
    p = np.array([[0, 128, 255]], dtype=np.uint8)
    v = transfer(p, lo=0.0, hi=1.0, gamma=1.0)
    assert v[0, 0] == pytest.approx(0.0) and v[0, 2] == pytest.approx(1.0)
    # everything below lo clips to 0, above hi clips to 1
    v2 = transfer(p, lo=0.6, hi=0.9, gamma=1.0)
    assert v2[0, 0] == 0.0 and v2[0, 2] == 1.0


def test_composite_paints_one_channel_in_its_own_colour():
    planes = {"CK": np.full((256, 256), 255, dtype=np.uint8)}
    rgba = composite(planes, [("CK", (0, 255, 255))], lo=0.0, hi=1.0, gamma=1.0)
    assert rgba.shape == (256, 256, 4)
    assert tuple(rgba[0, 0, :3]) == (0, 255, 255)
    assert rgba[0, 0, 3] == 255                 # full signal ⇒ opaque


def test_composite_saturates_instead_of_wrapping():
    # two full-intensity red channels must clip at 255, never wrap round to a small number
    planes = {"CK": np.full((256, 256), 255, dtype=np.uint8),
              "CD3": np.full((256, 256), 255, dtype=np.uint8)}
    rgba = composite(planes, [("CK", (255, 0, 0)), ("CD3", (255, 0, 0))], lo=0.0, hi=1.0, gamma=1.0)
    assert rgba[0, 0, 0] == 255


def test_composite_leaves_signal_free_tissue_transparent():
    planes = {"CK": np.zeros((256, 256), dtype=np.uint8)}
    rgba = composite(planes, [("CK", (0, 255, 255))], lo=0.0, hi=1.0, gamma=1.0)
    assert rgba[..., 3].max() == 0      # a black square would hide the H&E / DAPI underneath


def test_composite_ignores_a_channel_that_is_not_on_disk():
    rgba = composite({}, [("CK", (0, 255, 255))])
    assert rgba[..., 3].max() == 0


def test_colourise_pheno_filters_by_lineage():
    idx = np.zeros((4, 4), dtype=np.uint8)
    idx[0, 0] = phenotype_index("Tumour")
    idx[1, 1] = phenotype_index("Cytotoxic T")

    full = colourise_pheno(idx)
    assert full[0, 0, 3] == 255 and full[1, 1, 3] == 255
    assert full[2, 2, 3] == 0                       # background stays transparent

    only_t = colourise_pheno(idx, show=["Cytotoxic T"])
    assert only_t[0, 0, 3] == 0                     # Tumour filtered out by palette, not re-render
    assert only_t[1, 1, 3] == 255


def test_uncovered_tile_is_a_real_transparent_png_not_a_204():
    # B2: OSD 4.1.1 loads tiles through an <img>; a bodiless response fires onerror and enters
    # retry/backoff for every uncovered tile on every pan.
    with Image.open(io.BytesIO(TRANSPARENT_TILE)) as im:
        assert im.size == (256, 256)
        arr = np.array(im.convert("RGBA"))
    assert arr[..., 3].max() == 0


def test_encode_png_round_trips():
    rgba = np.zeros((256, 256, 4), dtype=np.uint8)
    rgba[10, 10] = (1, 2, 3, 255)
    with Image.open(io.BytesIO(encode_png(rgba))) as im:
        assert tuple(np.array(im.convert("RGBA"))[10, 10]) == (1, 2, 3, 255)
