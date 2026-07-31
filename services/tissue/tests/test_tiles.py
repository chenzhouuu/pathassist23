import numpy as np
import pytest

from tissue_service.artifacts import TILE
from tissue_service.classes import BCSS
from tissue_service.tiles import (
    TRANSPARENT_TILE,
    BadClassSpec,
    colourise_classes,
    composite_probs,
    encode_png,
    max_prob,
    outline_classes,
    parse_channels,
    parse_show,
)


def test_parse_show_validates_rather_than_dropping():
    assert parse_show("Tumour,Stroma", BCSS) == ["Tumour", "Stroma"]
    assert parse_show("", BCSS) is None
    assert parse_show(None, BCSS) is None
    # a typo must be a 400 — silently dropping it would read as "this class is absent here"
    with pytest.raises(BadClassSpec):
        parse_show("Tumor", BCSS)


def test_parse_channels_defaults_to_the_backend_palette():
    ch = parse_channels("", BCSS)
    assert [n for n, _ in ch] == list(BCSS.classes)
    assert ch[0][1] == (0xD5, 0x5E, 0x00)


def test_parse_channels_accepts_overrides_and_rejects_junk():
    assert parse_channels("Stroma:ff0000", BCSS) == [("Stroma", (255, 0, 0))]
    with pytest.raises(BadClassSpec):
        parse_channels("Stroma:xyz", BCSS)
    with pytest.raises(BadClassSpec):
        parse_channels("Nope:ff0000", BCSS)


def test_colourise_filters_by_palette_not_by_rerender():
    idx = np.array([[1, 2], [3, 0]], dtype=np.uint8)
    rgba = colourise_classes(idx, BCSS, show=["Tumour"])
    assert tuple(rgba[0, 0][:3]) == (0xD5, 0x5E, 0x00)
    assert rgba[0, 0][3] == 255
    assert rgba[0, 1][3] == 0        # Stroma hidden
    assert rgba[1, 1][3] == 0        # outside tissue is always transparent


def test_confidence_scales_alpha_between_the_floor_and_full():
    idx = np.ones((2, 2), dtype=np.uint8)
    conf = np.array([[255, 0], [128, 255]], dtype=np.uint8)
    rgba = colourise_classes(idx, BCSS, conf=conf, conf_floor=0.2)
    assert rgba[0, 0][3] == 255                       # certain → full
    assert rgba[0, 1][3] == pytest.approx(51, abs=2)  # 0.2 floor keeps it visible, not invisible
    assert 100 < rgba[1, 0][3] < 200


def test_alpha_multiplies_on_top_of_confidence():
    idx = np.ones((1, 1), dtype=np.uint8)
    full = colourise_classes(idx, BCSS, alpha=1.0)[0, 0][3]
    half = colourise_classes(idx, BCSS, alpha=0.5)[0, 0][3]
    assert half == pytest.approx(full / 2, abs=2)


def test_composite_is_additive_with_alpha_from_the_max_response():
    planes = {"Tumour": np.full((TILE, TILE), 255, np.uint8),
              "Stroma": np.zeros((TILE, TILE), np.uint8)}
    rgba = composite_probs(planes, [("Tumour", (255, 0, 0)), ("Stroma", (0, 0, 255))])
    assert tuple(rgba[0, 0][:3]) == (255, 0, 0)
    assert rgba[0, 0][3] == 255
    empty = composite_probs({"Tumour": np.zeros((TILE, TILE), np.uint8)},
                            [("Tumour", (255, 0, 0))])
    assert empty[0, 0][3] == 0      # no signal ⇒ transparent, never a black square


def test_outline_keeps_only_boundaries():
    idx = np.ones((16, 16), dtype=np.uint8)
    idx[:, 8:] = 2
    rgba = outline_classes(idx, BCSS, width=1)
    assert rgba[0, 0][3] == 0        # interior is see-through
    assert rgba[0, 7][3] > 0         # the class edge is drawn
    thick = outline_classes(idx, BCSS, width=3)
    assert int((thick[..., 3] > 0).sum()) > int((rgba[..., 3] > 0).sum())


def test_max_prob_is_the_confidence_channel():
    planes = {"Tumour": np.array([[10]], np.uint8), "Stroma": np.array([[200]], np.uint8)}
    assert max_prob(planes, BCSS)[0, 0] == 200
    assert max_prob({}, BCSS) is None


def test_transparent_tile_is_a_real_png_not_a_204():
    # OSD loads tiles through an <img>; a bodiless response fires onerror and enters retry storms
    assert TRANSPARENT_TILE.startswith(b"\x89PNG")
    assert len(TRANSPARENT_TILE) > 50
    assert encode_png(np.zeros((TILE, TILE, 4), np.uint8)).startswith(b"\x89PNG")
