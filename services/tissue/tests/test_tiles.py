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


def test_the_confidence_fade_is_quantised_so_the_tile_stays_cheap_to_encode():
    """The ramp's entropy *is* the encode cost — 14.2 ms of a 17 ms tile before this.

    Pinned as a property rather than a byte count: what must hold is that a continuous confidence
    field produces a small, bounded number of alpha levels, and that "hidden" stays exactly
    invisible rather than being rounded up to the first step.
    """
    from tissue_service.tiles import CONF_STEPS

    idx = np.ones((TILE, TILE), dtype=np.uint8)
    conf = np.arange(TILE * TILE, dtype=np.uint32).reshape(TILE, TILE) % 256
    rgba = colourise_classes(idx, BCSS, conf=conf.astype(np.uint8), conf_floor=0.2)
    assert len(np.unique(rgba[..., 3])) <= CONF_STEPS

    hidden = colourise_classes(idx, BCSS, show=["Stroma"], conf=conf.astype(np.uint8))
    assert set(np.unique(hidden[..., 3])) == {0}     # a hidden class never rounds up into view


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


def test_a_served_tile_is_not_encoded_at_archive_effort():
    """`optimize=True` here cost 184 ms against 14 ms, to save 6.7% of the bytes.

    It was the dominant cost of mounting the map — worse than reading every probability plane off
    disk by two orders of magnitude. The guard is a *ratio* against the archive-effort encode of
    the same array, so it measures the choice rather than the speed of the machine running it.
    """
    import io
    import time

    from PIL import Image

    rng = np.random.default_rng(0)
    # The shape that makes it expensive: flat class colours, but a continuous alpha ramp, which is
    # exactly what "alpha follows confidence" produces.
    rgba = np.zeros((TILE, TILE, 4), np.uint8)
    rgba[..., :3] = np.array([0xD5, 0x5E, 0x00], np.uint8)
    rgba[..., 3] = rng.integers(0, 256, (TILE, TILE), dtype=np.uint8)

    def archive() -> bytes:
        buf = io.BytesIO()
        Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", optimize=True)
        return buf.getvalue()

    encode_png(rgba), archive()                      # warm both paths

    t0 = time.perf_counter()
    served = encode_png(rgba)
    t_served = time.perf_counter() - t0

    t0 = time.perf_counter()
    stored = archive()
    t_archive = time.perf_counter() - t0

    assert served.startswith(b"\x89PNG")
    assert t_served * 3 < t_archive, (
        f"served tile took {t_served * 1000:.0f} ms vs {t_archive * 1000:.0f} ms at archive "
        "effort — the encoder is back to optimising tiles nobody keeps"
    )
    # And the bytes it gives up for that are a rounding error on a tile cached for a day.
    assert len(served) < len(stored) * 1.5
