"""The taxonomy registry — was test_pannuke.py until Inc 7 made PanNuke one of six."""

import pytest

from cellvit_service.taxonomy import (
    BACKGROUND_INDEX,
    DEFAULT,
    HEAD_IDS,
    TAXONOMIES,
    TAXONOMY_IDS,
    UnknownTaxonomy,
    get,
    name_for,
)


def test_pannuke_is_still_the_five_pannuke_classes():
    assert get("pannuke").names == {
        1: "Neoplastic", 2: "Inflammatory", 3: "Connective", 4: "Dead", 5: "Epithelial",
    }


def test_name_for_maps_ids_and_falls_back_for_unknown():
    assert name_for(1) == "Neoplastic"
    assert name_for(5) == "Epithelial"
    assert name_for(0) == "Unknown"   # background never appears in cells
    assert name_for(99) == "Unknown"


def test_default_is_pannuke_and_it_is_listed_first():
    assert DEFAULT == "pannuke"
    assert TAXONOMY_IDS[0] == "pannuke"


def test_the_five_heads_are_the_breast_three_plus_midog_and_ocelot():
    assert set(HEAD_IDS) == {"nucls_super", "nucls_main", "panoptils", "midog", "ocelot"}
    # Lizard and CoNSeP are in the same bundle and deliberately not offered (D5).
    assert "lizard" not in TAXONOMIES
    assert "consep" not in TAXONOMIES


@pytest.mark.parametrize("tax_id", TAXONOMY_IDS)
def test_stored_ids_are_one_based_and_contiguous(tax_id):
    """0 is reserved for "no nucleus" in every plane, so no taxonomy may store it."""
    tax = get(tax_id)
    assert tax.class_ids == list(range(1, tax.n_classes + 1))
    assert BACKGROUND_INDEX not in tax.class_ids


@pytest.mark.parametrize("tax_id", TAXONOMY_IDS)
def test_every_class_has_a_display_name_and_a_six_digit_colour(tax_id):
    tax = get(tax_id)
    for cid in tax.class_ids:
        assert tax.display[cid]
        assert len(tax.color(cid)) == 6
        int(tax.color(cid), 16)


def test_model_offset_shifts_head_ids_but_not_pannukes():
    # The decoder already emits 1..5 with 0 = background; the heads emit 0-based argmax.
    assert get("pannuke").model_offset == 0
    assert all(get(t).model_offset == 1 for t in HEAD_IDS)


def test_tumour_keeps_one_colour_across_every_taxonomy_that_names_it():
    """D11: switching taxonomy changes the subdivision of the picture, not its colour language."""
    vermillion = get("pannuke").colors[1]          # Neoplastic
    assert get("nucls_super").colors[1] == vermillion   # tumor_any
    assert get("nucls_main").colors[1] == vermillion    # tumor_nonMitotic
    assert get("ocelot").colors[2] == vermillion        # Tumor Cell


def test_immune_and_stroma_are_likewise_shared():
    immune = get("pannuke").colors[2]              # Inflammatory
    assert get("nucls_super").colors[3] == immune       # sTIL
    assert get("panoptils").colors[4] == immune         # TILs
    assert get("nucls_main").colors[5] == immune        # lymphocyte

    stroma = get("pannuke").colors[3]              # Connective
    assert get("nucls_super").colors[2] == stroma       # nonTIL_stromal
    assert get("panoptils").colors[3] == stroma         # Stromal Cells


def test_colours_inside_one_taxonomy_are_distinct():
    """Two classes the same colour is a legend nobody can read."""
    for tax_id in TAXONOMY_IDS:
        tax = get(tax_id)
        colours = [tax.color(c) for c in tax.class_ids]
        assert len(set(colours)) == len(colours), tax_id


def test_unknown_taxonomy_is_a_named_refusal():
    with pytest.raises(UnknownTaxonomy) as exc:
        get("lizard")
    assert "lizard" in str(exc.value)


def test_as_dict_keys_colours_and_display_by_the_stored_name():
    doc = get("nucls_super").as_dict()
    assert doc["classes"] == ["tumor_any", "nonTIL_stromal", "sTIL", "other_nucleus"]
    assert doc["display"]["sTIL"] == "sTIL"
    assert doc["display"]["tumor_any"] == "Tumour (any)"
    assert doc["colors"]["tumor_any"].startswith("#")
    assert doc["organ"].startswith("breast")
