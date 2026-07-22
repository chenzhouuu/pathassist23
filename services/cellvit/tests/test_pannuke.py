from cellvit_service.pannuke import TYPE_NAMES, name_for


def test_type_names_are_the_five_pannuke_classes():
    assert TYPE_NAMES == {
        1: "Neoplastic", 2: "Inflammatory", 3: "Connective", 4: "Dead", 5: "Epithelial",
    }


def test_name_for_maps_ids_and_falls_back_for_unknown():
    assert name_for(1) == "Neoplastic"
    assert name_for(5) == "Epithelial"
    assert name_for(0) == "Unknown"   # background never appears in cells
    assert name_for(99) == "Unknown"
